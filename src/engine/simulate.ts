import { migrationCost, totals } from './budget.ts';
import { routeTable, type NodeRoutes, type RouteTable } from './routing.ts';
import type {
  ArchLink,
  ArchNode,
  Architecture,
  Catalog,
  ComponentDef,
  FailureReason,
  Gauge,
  Incident,
  NodeSummary,
  NodeTick,
  RequestKind,
  SimEvent,
  TickMetrics,
  TrafficSource,
  Wave,
  WaveResult,
} from './types.ts';
import { REQUEST_KINDS, SYNC_KINDS } from './types.ts';
import { upgradeLevel, validateArchitecture } from './validate.ts';

/**
 * Au-delà, la latence d'un nœud saturé n'augmente plus : les requêtes en trop
 * échouent au lieu d'attendre indéfiniment. Plafonne le facteur à 1 / (1 - 0.95) = 20.
 */
const MAX_UTILIZATION_FOR_LATENCY = 0.95;

/** Charge affichée d'un composant sans aucune instance en service qui reçoit du trafic. */
const OUTAGE_UTILIZATION = 10;

function ratio(demand: number, capacity: number): number {
  if (demand === 0) return 0;
  return capacity > 0 ? demand / capacity : OUTAGE_UTILIZATION;
}

/**
 * Un flux élémentaire : des requêtes d'un type, d'une source, à un niveau de
 * regroupement donné. `batch` > 1 après une file qui regroupe ses messages :
 * l'aval paie le travail d'un envoi, mais on compte toujours les messages.
 */
interface Stream {
  kind: RequestKind;
  source: string;
  batch: number;
  rps: number;
  /** Copie livrée une seconde fois par un incident : elle ne compte jamais comme livrée. */
  duplicate?: boolean;
}

/** Un événement async original : ce qu'un service attend de recevoir. */
const isEvent = (s: Stream) => s.kind === 'async' && !s.duplicate;

type Flow = Map<string, Stream>;

function streamKey(s: Pick<Stream, 'kind' | 'source' | 'batch' | 'duplicate'>): string {
  return `${s.kind}|${s.source}|${s.batch}${s.duplicate ? '|dup' : ''}`;
}

function addStream(flow: Flow, s: Stream): void {
  if (s.rps <= 0) return;
  const key = streamKey(s);
  const existing = flow.get(key);
  if (existing) existing.rps += s.rps;
  else flow.set(key, { ...s });
}

function scaleFlow(flow: Flow, factor: number): Flow {
  const out: Flow = new Map();
  for (const s of flow.values()) addStream(out, { ...s, rps: s.rps * factor });
  return out;
}

function sumRps(flow: Flow, pred: (s: Stream) => boolean = () => true): number {
  let total = 0;
  for (const s of flow.values()) if (pred(s)) total += s.rps;
  return total;
}

function work(flow: Flow, def: ComponentDef, pred: (s: Stream) => boolean = () => true): number {
  let total = 0;
  for (const s of flow.values()) {
    if (pred(s)) total += (s.rps * (def.workPerRequest[s.kind] ?? 0)) / s.batch;
  }
  return total;
}

function loadedLatency(baseMs: number, utilization: number): number {
  return baseMs / (1 - Math.min(utilization, MAX_UTILIZATION_FOR_LATENCY));
}

function factorAt(wave: Wave, tick: number): number {
  const base = wave.profile.find((seg) => tick < seg.until)?.factor ?? wave.profile.at(-1)?.factor ?? 1;
  return base * envelopeAt(wave, tick);
}

/** Courbe en S : une montée sans à-coup, ni au départ ni à l'arrivée. */
const smooth = (x: number) => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};

export function envelopeAt(wave: Wave, tick: number): number {
  if (!wave.ramp) return 1;
  const { up, down } = wave.ramp;
  let f = 1;
  if (up > 0 && tick < up) f = 0.25 + 0.75 * smooth((tick + 1) / up);
  const fromEnd = wave.ticks - tick;
  if (down > 0 && fromEnd <= down) f = Math.min(f, 1 - 0.6 * smooth((down - fromEnd + 1) / down));
  return f;
}

interface NodeOutcome {
  /** Flux servi par ce nœud et qui continue vers l'aval (avant routage). */
  passed: Flow;
  utilization: number;
  /** Part de chaque type servi qui poursuit sa route de façon synchrone. */
  syncForwardShare: Partial<Record<RequestKind, number>>;
  instances?: number;
  /** Instances d'autoscaling demandées et pas encore prêtes. */
  starting?: number;
  /** Serveur : part de ses fils occupés, et la dépendance qui les retient s'ils sont tous pris. */
  threads?: number;
  blockedBy?: string;
}

interface AutoscaleState {
  instanceCost: number;
  active: number;
  pending: { readyAt: number; count: number }[];
  /** Somme sur les ticks des instances ajoutées en service : base de la facture. */
  instanceTicks: number;
}

/** Ce que le rendu doit montrer et que les échecs confondent, par nœud et par tick. */
interface Tally {
  duplicates: number;
  deduplicated: number;
  lost: number;
  stale: number;
}

interface TickContext {
  tick: number;
  failures: Record<FailureReason, number>;
  nodeFailed: Map<string, number>;
  /** Trafic abusif écarté par nœud pendant le tick : voulu, donc hors échecs. */
  nodeShed: Map<string, number>;
  /** Ce que le rendu doit montrer et que les échecs confondent : doublons reçus, événements perdus. */
  nodeTally: Map<string, Tally>;
  events: SimEvent[];
  shed: { value: number };
  /** Cumul de la vague : événements async en échec, et copies arrivées au bout de leur chemin. */
  asyncTally: { failed: number; delivered: number };
}

const P95 = 0.95;
/** Part du trafic au-delà de laquelle des clients lents se voient dans le p95. */
const P95_SHARE = 1 - P95;

/**
 * `previous` est l'architecture en place à la fin de la vague précédente : les retraits
 * depuis celle-ci s'ajoutent à la facture de la vague (décision E3).
 */
export function simulateWave(
  arch: Architecture,
  wave: Wave,
  catalog: Catalog,
  previous?: Architecture,
): WaveResult {
  const { cost: fixed, complexity } = totals(arch, catalog);
  const billed = { fixed, autoscaling: 0, migration: previous ? migrationCost(previous, arch, catalog) : 0 };
  const validation = validateArchitecture(arch, catalog);
  if (!validation.ok) {
    return invalidResult(wave, billed, complexity, validation.errors);
  }

  const nodes = new Map(arch.nodes.map((n) => [n.id, n]));
  const defOf = (id: string): ComponentDef => catalog.components[nodes.get(id)!.type]!;
  const routes = routeTable(arch, catalog);
  let active: Incident[] = [];
  const down = (node: ArchNode): number =>
    active.reduce(
      (a, i) =>
        a + (i.component !== node.type ? 0 : i.effect.type === 'instance-down' ? i.effect.count : i.effect.type === 'dependency-down' ? Infinity : 0),
      0,
    );
  // Une ruée vers le cache vide le cache comme un redémarrage à froid.
  const hitFactor = (type: string, tick: number): number =>
    active.reduce(
      (f, i) => (i.component === type && (i.effect.type === 'cold-cache' || i.effect.type === 'cache-stampede') ? f * ((tick - i.from) / (i.until - i.from)) : f),
      1,
    );
  const hasEffect = (node: ArchNode, effect: string): boolean =>
    Object.values(catalog.upgrades).some((u) => u.appliesTo === node.type && u.effect.type === effect && upgradeLevel(node, u.id) > 0);
  /** Chaque absence recalculée `herd` fois en base pendant une ruée, sauf derrière un verrou de recalcul. */
  const herdAt = (cacheId: string): number => {
    const cache = nodes.get(cacheId)!;
    if (hasEffect(cache, 'coalescing')) return 1;
    return active.reduce((h, i) => (i.component === cache.type && i.effect.type === 'cache-stampede' ? Math.max(h, i.effect.herd) : h), 1);
  };
  /** Latence d'un nœud hors charge, ralentie par un incident en cours. */
  const latencyOf = (id: string): number =>
    active.reduce(
      (l, i) => (i.component === nodes.get(id)!.type && i.effect.type === 'slow-dependency' ? Math.max(l, i.effect.latencyMs) : l),
      defOf(id).latencyMs,
    );
  const hasReplicas = (node: ArchNode): boolean =>
    Object.values(catalog.upgrades).some((u) => u.appliesTo === node.type && u.effect.type === 'readReplicas' && upgradeLevel(node, u.id) > 0);
  const isDown = (id: string): boolean => instancesOf(nodes.get(id)!, catalog, down(nodes.get(id)!)) === 0;
  const breakerOf = (node: ArchNode): number | undefined => {
    for (const u of Object.values(catalog.upgrades)) {
      if (u.appliesTo === node.type && u.effect.type === 'circuitBreaker' && upgradeLevel(node, u.id) > 0) return u.effect.timeoutMs;
    }
    return undefined;
  };
  // Une donnée qui doit être à jour ne se lit pas en cache.
  const hitRateAt = (nodeId: string, s: Stream): number =>
    sourcesById.get(s.source)?.longTail || sourcesById.get(s.source)?.consistent ? 0 : (defOf(nodeId).hitRate ?? 0) * hitFactor(nodes.get(nodeId)!.type, currentTick);
  let currentTick = 0;
  /** Part d'un incident de messagerie en cours sur ce type de composant. */
  const incidentShare = (type: string, effect: 'duplicate-delivery' | 'publish-loss'): number =>
    active.reduce((a, i) => a + (i.component === type && i.effect.type === effect ? i.effect.share : 0), 0);
  const roles = new Map(arch.nodes.map((n) => [n.id, messagingRoles(n, nodes, catalog, routes)]));

  const sourcesById = new Map(wave.sources.map((s) => [s.id, s]));
  const backlogs = new Map<string, Flow>();
  const autoscalers = new Map<string, AutoscaleState>();
  const saturated = new Set<string>();
  const summaries = new Map<string, NodeSummary>(
    [...nodes.keys()].map((id) => [id, { peakUtilization: 0, failed: 0, saturatedTicks: 0 }]),
  );

  const failures = noFailures();
  const events: SimEvent[] = [];
  const shed = { value: 0 };
  const asyncTally = { failed: 0, delivered: 0 };
  const consumers = new Set(wave.consumers ?? []);
  const fanOut = consumers.size;
  let asyncInjected = 0;
  let undeliveredSoFar = 0;
  const ticks: TickMetrics[] = [];
  const reportedNoRoute = new Set<string>();
  const reportedBlocked = new Set<string>();

  // Relances des clients (S19) : ce que chaque source renverra au tick suivant.
  const retrying = wave.sources.filter((s) => (s.retries ?? 0) > 0 && !s.abusive);
  /** Relances prévues, par source et par tick. */
  const retryAt = new Map<string, number[]>(retrying.map((s) => [s.id, new Array<number>(wave.ticks).fill(0)]));
  /** Échecs relancés pendant la vague : le client ne les a pas vus, il a réessayé. */
  let retriedTotal = 0;
  const backoff = Object.values(catalog.upgrades).find(
    (u) => u.appliesTo === nodes.get(validation.sourceId)!.type && u.effect.type === 'backoff' && upgradeLevel(nodes.get(validation.sourceId)!, u.id) > 0,
  )?.effect;
  const syncOf = (src: TrafficSource) => SYNC_KINDS.reduce((a, k) => a + (src.rps[k] ?? 0), 0);

  let offeredTotal = 0;
  let syncWeightedLatency = 0;
  let syncOffered = 0;

  for (let tick = 0; tick < wave.ticks; tick++) {
    const factor = factorAt(wave, tick);
    currentTick = tick;
    const was = new Set(active.map((i) => i.id));
    active = (wave.incidents ?? []).filter((i) => tick >= i.from && tick < i.until);
    for (const i of active) if (!was.has(i.id)) events.push({ type: 'incident-start', tick, incident: i.id });
    for (const id of was) if (!active.some((i) => i.id === id)) events.push({ type: 'incident-end', tick, incident: id });
    const nodeFailed = new Map<string, number>();
    const nodeShed = new Map<string, number>();
    const nodeTally: TickContext['nodeTally'] = new Map();
    const ctx: TickContext = { tick, failures, nodeFailed, nodeShed, nodeTally, events, shed, asyncTally };
    const failedBefore = sumFailures(failures);

    const inbound = new Map<string, Flow>([...nodes.keys()].map((id) => [id, new Map()]));
    const injected: Flow = new Map();
    let retried = 0;
    for (const src of wave.sources) {
      // Une relance refait la même requête : elle suit la répartition lectures / écritures de sa source.
      const again = retryAt.get(src.id)?.[tick] ?? 0;
      retried += again;
      const sync = syncOf(src);
      for (const kind of REQUEST_KINDS) {
        const share = SYNC_KINDS.includes(kind) && sync > 0 ? (src.rps[kind] ?? 0) / sync : 0;
        addStream(injected, { kind, source: src.id, batch: 1, rps: (src.rps[kind] ?? 0) * factor + again * share });
      }
    }
    const asyncFailedBefore = asyncTally.failed;
    const staleBefore = failures['stale-read'];
    inbound.set(validation.sourceId, injected);
    asyncInjected += sumRps(injected, isEvent);
    const offered = sumRps(injected);
    offeredTotal += offered;

    const outcomes = new Map<string, NodeOutcome>();
    const nodeTicks: Record<string, NodeTick> = {};
    const routed: Routed = new Map();

    // Circuits ouverts ce tick : les dépendances directes d'un serveur à disjoncteur qui
    // dépassent son délai, ou qui sont en panne.
    const open = new Map<string, Set<string>>();
    for (const node of arch.nodes) {
      const timeout = breakerOf(node);
      if (timeout === undefined) continue;
      const targets = new Set(REQUEST_KINDS.flatMap((k) => routes.get(node.id)!.forward[k]));
      const cut = [...targets].filter((t) => isDown(t) || latencyOf(t) > timeout);
      if (cut.length > 0) open.set(node.id, new Set(cut));
    }
    /** Ce qu'un appel direct de ce type attend en aval, hors circuits coupés et dépendances en panne (refus immédiat). */
    const syncWait = (id: string, kind: RequestKind): { ms: number; dependency?: string } => {
      let worst: { ms: number; dependency?: string } = { ms: 0 };
      for (const t of routes.get(id)!.forward[kind]) {
        if (open.get(id)?.has(t) || isDown(t)) continue;
        const ms = latencyOf(t);
        if (ms > worst.ms) worst = { ms, dependency: t };
      }
      return worst;
    };

    for (const id of validation.order) {
      const node = nodes.get(id)!;
      const def = defOf(id);
      const incoming = inbound.get(id)!;
      const outcome = processNode(node, def, incoming, {
        ctx,
        catalog,
        sourcesById,
        backlogs,
        autoscalers,
        down,
        hitFactor: (type) => hitFactor(type, tick),
        syncWait: (kind) => syncWait(id, kind),
        consumers: consumersOf(routes.get(id)!).map((c) => ({ ...c, def: defOf(c.id), node: nodes.get(c.id)! })),
        timeouts: retrying.length > 0,
        partitioned: (n) => active.some((i) => i.component === n.type && i.effect.type === 'partition'),
      });
      outcomes.set(id, outcome);

      route(id, def, outcome.passed, routes.get(id)!, {
        inbound,
        ctx,
        reportedNoRoute,
        routed,
        hitRateAt,
        roles: roles.get(id)!,
        incidentShare: (effect) => incidentShare(node.type, effect),
        consumer: consumers.has(id),
        open: open.get(id),
        herdAt,
      });
      if (outcome.blockedBy && !reportedBlocked.has(id)) {
        reportedBlocked.add(id);
        events.push({ type: 'threads-exhausted', tick, node: id, dependency: outcome.blockedBy });
      }

      const isSaturated = outcome.utilization > 1;
      if (isSaturated && !saturated.has(id)) {
        saturated.add(id);
        events.push({ type: 'saturation-start', tick, node: id, utilization: outcome.utilization });
      } else if (!isSaturated && saturated.has(id)) {
        saturated.delete(id);
        events.push({ type: 'saturation-end', tick, node: id });
      }

      const summary = summaries.get(id)!;
      summary.peakUtilization = Math.max(summary.peakUtilization, outcome.utilization);
      if (isSaturated) summary.saturatedTicks++;
      summary.failed += nodeFailed.get(id) ?? 0;

      nodeTicks[id] = {
        rps: sumRps(incoming),
        utilization: outcome.utilization,
        latencyMs: loadedLatency(latencyOf(id), outcome.utilization),
        failed: nodeFailed.get(id) ?? 0,
        ...(backlogs.has(id) ? { backlog: sumRps(backlogs.get(id)!) } : {}),
        ...(outcome.instances !== undefined ? { instances: outcome.instances } : {}),
        ...(outcome.starting ? { starting: outcome.starting } : {}),
        ...(nodeShed.has(id) ? { shed: nodeShed.get(id)! } : {}),
        // Une dépendance fermée a toutes ses instances hors service, pas une infinité.
        ...(down(node) > 0 ? { down: Math.min(down(node), instancesOf(node, catalog)) } : {}),
        ...nonZero(nodeTally.get(id)),
        ...(outcome.threads !== undefined ? { threads: outcome.threads } : {}),
        ...(outcome.blockedBy ? { waitingOn: outcome.blockedBy } : {}),
        ...(open.has(id) ? { open: [...open.get(id)!] } : {}),
        ...(def.behavior === 'database' && hasReplicas(node) && active.some((i) => i.component === node.type && i.effect.type === 'partition') ? { partitioned: true } : {}),
      };
    }

    const pathLatency = computePathLatencies(validation.order, routes, routed, outcomes, nodeTicks, open);
    // L'événement fait partie de la commande : tant qu'il est traité en direct, le client
    // l'attend. Une file le sort du chemin critique (sa part synchrone s'arrête à elle).
    const injectedSync = REQUEST_KINDS.map((k) => ({ k, rps: sumRps(injected, (s) => s.kind === k) }));
    const syncRps = injectedSync.reduce((a, x) => a + x.rps, 0);
    const tickLatency =
      syncRps > 0
        ? injectedSync.reduce((a, x) => a + x.rps * (pathLatency(validation.sourceId, x.k)), 0) / syncRps
        : 0;
    // Le client qui passe commande attend tout l'événement tant qu'il est traité en direct :
    // sa latence compte entière, pas diluée dans les lectures (décision S17). Derrière une
    // file, la part synchrone de l'événement s'arrête à elle et reste courte.
    const eventRps = injectedSync.find((x) => x.k === 'async')?.rps ?? 0;
    // De même, une lecture qui doit être à jour ne passe par aucun cache : si ces clients
    // pèsent plus de 5 % du trafic, le p95 les voit, leur latence compte entière (S21).
    const consistentRps = sumRps(injected, (s) => s.kind === 'read' && !!sourcesById.get(s.source)?.consistent);
    const consistentLatency =
      consistentRps > P95_SHARE * syncRps
        ? computePathLatencies(validation.order, routes, routed, outcomes, nodeTicks, open, (id) => !!defOf(id).lookaside)(validation.sourceId, 'read')
        : 0;
    const slaLatency = Math.max(tickLatency, eventRps > 0 ? pathLatency(validation.sourceId, 'async') : 0, consistentLatency);
    syncWeightedLatency += tickLatency * syncRps;
    syncOffered += syncRps;

    // Ce qui manque aux abonnés attendus, une fois retirés les échecs déjà comptés et ce
    // qui attend encore en file : compté au fil des ticks, pour que le rejeu le montre.
    if (fanOut > 0) {
      // Seul ce qui attend dans une file vidée par un consommateur arrivera un jour.
      const waiting = [...backlogs]
        .filter(([id]) => routes.get(id)!.forward.async.length > 0)
        .reduce((a, [, b]) => a + sumRps(b, isEvent), 0);
      const missing = Math.max(0, asyncInjected * fanOut - asyncTally.delivered - asyncTally.failed - waiting);
      if (missing > undeliveredSoFar) failures.undelivered += missing - undeliveredSoFar;
      undeliveredSoFar = Math.max(undeliveredSoFar, missing);
    }

    // Chaque échec synchrone d'un client qui relance revient (S19) : au tick suivant sans
    // backoff, tous ensemble ; étalé sur les ticks suivants avec. Au plus `retries` relances
    // par requête neuve : au-delà, le client abandonne et l'échec est le sien.
    if (retrying.length > 0) {
      // Une lecture périmée n'est pas une erreur pour le client : il ne la relance pas.
      const syncFailed = Math.max(0, sumFailures(failures) - failedBefore - (asyncTally.failed - asyncFailedBefore) - (failures['stale-read'] - staleBefore));
      const weight = retrying.reduce((a, s) => a + syncOf(s), 0);
      const spread = backoff?.type === 'backoff' ? backoff.spreadTicks : 1;
      for (const src of retrying) {
        const schedule = retryAt.get(src.id)!;
        const fresh = syncOf(src) * factorAt(wave, tick);
        const again = Math.min((syncFailed * syncOf(src)) / weight, (src.retries ?? 0) * fresh);
        for (let d = 1; d <= spread; d++) {
          // Une relance prévue après la fin de la vague n'a pas lieu : son échec reste.
          if (tick + d >= wave.ticks) break;
          schedule[tick + d]! += again / spread;
          retriedTotal += again / spread;
        }
      }
    }

    ticks.push({
      tick,
      offered,
      failed: sumFailures(failures) - failedBefore,
      avgLatencyMs: tickLatency,
      slaLatencyMs: slaLatency,
      nodes: nodeTicks,
      links: linkTraffic(routed),
      ...(active.length > 0 ? { incidents: active.map((i) => i.id) } : {}),
      ...(retried > 0 ? { retries: retried } : {}),
    });
  }

  for (const id of saturated) events.push({ type: 'saturation-end', tick: wave.ticks, node: id });
  for (const i of active) events.push({ type: 'incident-end', tick: wave.ticks, incident: i.id });

  for (const a of autoscalers.values()) billed.autoscaling += (a.instanceTicks * a.instanceCost) / wave.ticks;

  // Un échec relancé n'est pas vu du client : sa relance compte à sa place, réussie ou non.
  const failed = sumFailures(failures) - retriedTotal;
  const counted = offeredTotal - shed.value - retriedTotal;
  const failureRate = counted > 0 ? failed / counted : 0;
  const avgLatency = syncOffered > 0 ? syncWeightedLatency / syncOffered : 0;

  const gauges = {
    cost: gauge(billed.fixed + billed.autoscaling + billed.migration, wave.budget),
    complexity: gauge(complexity, wave.complexityCap),
    failureRate: gauge(failureRate, wave.sla.maxFailureRate),
    latency: gauge(percentile(ticks.map((t) => t.slaLatencyMs), P95), wave.sla.maxP95LatencyMs),
  };
  const lossReasons = lossReasonsFor(gauges, billed);

  return {
    won: lossReasons.length === 0,
    lossReasons,
    bill: billed,
    avgLatencyMs: avgLatency,
    gauges,
    offered: offeredTotal,
    failed,
    failuresByReason: failures,
    shed: shed.value,
    ...(fanOut > 0 ? { delivery: { expected: asyncInjected * fanOut, delivered: asyncTally.delivered } } : {}),
    nodes: Object.fromEntries(summaries),
    ticks,
    events,
  };
}

interface ProcessEnv {
  ctx: TickContext;
  catalog: Catalog;
  sourcesById: Map<string, TrafficSource>;
  backlogs: Map<string, Flow>;
  autoscalers: Map<string, AutoscaleState>;
  /** Instances d'un nœud mises hors service par un incident en cours. */
  down: (node: ArchNode) => number;
  /** Facteur appliqué au taux de succès d'un type de composant (cache froid). */
  hitFactor: (type: string) => number;
  /** Ce qu'un appel direct de ce type fait attendre en aval : le temps d'occupation d'un fil. */
  syncWait: (kind: RequestKind) => { ms: number; dependency?: string };
  consumers: { kinds: RequestKind[]; def: ComponentDef; node: ArchNode }[];
  /**
   * Les clients relancent (S19) : un serveur saturé ne rejette plus vite, il fait attendre
   * jusqu'au délai du client, et travaille encore pour des requêtes déjà abandonnées.
   */
  timeouts: boolean;
  /** Un incident coupe les réplicas de ce nœud de son primaire (S21). */
  partitioned: (node: ArchNode) => boolean;
}

function processNode(node: ArchNode, def: ComponentDef, incoming: Flow, env: ProcessEnv): NodeOutcome {
  switch (def.behavior) {
    case 'source':
      return { passed: incoming, utilization: 0, syncForwardShare: allForwarded() };
    case 'edge':
      return processEdge(node, def, incoming, env);
    case 'balancer':
      return processBalancer(node, def, incoming, env);
    case 'service':
      return processService(node, def, incoming, env);
    case 'cache':
      return processCache(node, def, incoming, env);
    case 'database':
      return processDatabase(node, def, incoming, env);
    case 'queue':
      return processQueue(node, def, incoming, env);
    case 'pubsub':
      return processCache(node, def, incoming, env);
  }
}

function allForwarded(): Partial<Record<RequestKind, number>> {
  return { read: 1, write: 1, async: 1 };
}

function instancesOf(node: ArchNode, catalog: Catalog, down = 0): number {
  let extra = 0;
  for (const up of Object.values(catalog.upgrades)) {
    if (up.effect.type === 'instances' && up.appliesTo === node.type) extra += upgradeLevel(node, up.id);
  }
  return Math.max(0, 1 + extra - down);
}

function noFailures(): Record<FailureReason, number> {
  return {
    saturation: 0,
    'no-route': 0,
    'rate-limited': 0,
    'queue-overflow': 0,
    'lost-at-edge': 0,
    duplicate: 0,
    'lost-event': 0,
    undelivered: 0,
    'circuit-open': 0,
    'stale-read': 0,
  };
}

/**
 * Des clients qui relancent n'attendent pas d'être rejetés (S19) : au-delà de la capacité,
 * le nœud traite des requêtes déjà abandonnées et ne sert plus que capacité / charge de ce
 * qu'il pourrait. C'est ce qui entretient la tempête une fois la panne passée.
 */
function timedOut(demand: number, capacity: number, env: ProcessEnv): number {
  return env.timeouts && demand > capacity && capacity > 0 ? (demand * demand) / capacity : demand;
}

/** Sert ce qui tient dans la capacité, fait échouer le reste à parts égales. */
function serveWithin(nodeId: string, flow: Flow, demand: number, capacity: number, ctx: TickContext): Flow {
  if (demand <= capacity || demand === 0) return flow;
  const servedShare = capacity / demand;
  const lostShare = 1 - servedShare;
  fail(ctx, nodeId, 'saturation', sumRps(flow) * lostShare, sumRps(flow, isEvent) * lostShare);
  return scaleFlow(flow, servedShare);
}

/** `events` : la part de ces échecs qui sont des événements async, pour compter ce qui reste à livrer. */
function tally(ctx: TickContext, nodeId: string, key: keyof Tally, rps: number): void {
  const t = ctx.nodeTally.get(nodeId) ?? { duplicates: 0, deduplicated: 0, lost: 0, stale: 0 };
  t[key] += rps;
  ctx.nodeTally.set(nodeId, t);
}

function nonZero(t: Tally | undefined): Partial<NodeTick> {
  if (!t) return {};
  return Object.fromEntries(Object.entries(t).filter(([, v]) => v > 0));
}

function fail(ctx: TickContext, nodeId: string, reason: FailureReason, rps: number, events = 0): void {
  if (rps <= 0) return;
  ctx.failures[reason] += rps;
  ctx.nodeFailed.set(nodeId, (ctx.nodeFailed.get(nodeId) ?? 0) + rps);
  ctx.asyncTally.failed += events;
}

function processBalancer(node: ArchNode, def: ComponentDef, incoming: Flow, env: ProcessEnv): NodeOutcome {
  let flow = incoming;
  for (const up of Object.values(env.catalog.upgrades)) {
    if (up.effect.type !== 'rateLimit' || up.appliesTo !== node.type) continue;
    const level = upgradeLevel(node, up.id);
    const limit = up.effect.tiersPerClientRps[level - 1];
    if (limit === undefined) continue;
    flow = applyRateLimit(node.id, flow, limit, env);
  }
  const capacity = def.capacity * instancesOf(node, env.catalog, env.down(node));
  const demand = work(flow, def);
  return {
    passed: serveWithin(node.id, flow, demand, capacity, env.ctx),
    utilization: ratio(demand, capacity),
    syncForwardShare: allForwarded(),
  };
}

function applyRateLimit(nodeId: string, flow: Flow, limitPerClient: number, env: ProcessEnv): Flow {
  const out: Flow = new Map();
  // L'async est un effet de bord des requêtes (un clic compté par redirection), pas une
  // requête du client : il n'entame pas son quota mais suit le sort de sa requête.
  const perSource = new Map<string, number>();
  for (const s of flow.values()) {
    if (SYNC_KINDS.includes(s.kind)) perSource.set(s.source, (perSource.get(s.source) ?? 0) + s.rps);
  }

  const keepShare = new Map<string, number>();
  for (const [sourceId, rps] of perSource) {
    const src = env.sourcesById.get(sourceId);
    const allowed = limitPerClient * (src?.clients ?? 1);
    if (rps <= allowed) {
      keepShare.set(sourceId, 1);
      continue;
    }
    const rejected = rps - allowed;
    keepShare.set(sourceId, allowed / rps);
    if (src?.abusive) {
      env.ctx.shed.value += rejected;
      env.ctx.nodeShed.set(nodeId, (env.ctx.nodeShed.get(nodeId) ?? 0) + rejected);
    }
    else fail(env.ctx, nodeId, 'rate-limited', rejected);
    env.ctx.events.push({ type: 'rate-limited', tick: env.ctx.tick, node: nodeId, source: sourceId, rejectedRps: rejected });
  }
  for (const s of flow.values()) addStream(out, { ...s, rps: s.rps * (keepShare.get(s.source) ?? 1) });
  return out;
}

function processService(node: ArchNode, def: ComponentDef, incoming: Flow, env: ProcessEnv): NodeOutcome {
  const base = instancesOf(node, env.catalog, env.down(node));
  const auto = autoscale(node, def, base, env);
  const instances = base + (auto?.active ?? 0);
  const capacity = def.capacity * instances;
  const demand = work(incoming, def);
  auto?.plan(demand);
  let utilization = ratio(demand, capacity);
  // Travail à servir : celui des requêtes, ou plus si les fils manquent avant le processeur.
  let load = demand;
  // Loi de Little : fils occupés = débit × temps passé par requête, attente de l'aval comprise.
  let threads: number | undefined;
  let blockedBy: string | undefined;
  if (def.threads && instances > 0) {
    let busy = 0;
    let worst = { busy: 0, dependency: undefined as string | undefined };
    for (const kind of REQUEST_KINDS) {
      // Un envoi groupé n'occupe qu'un fil, comme il ne coûte qu'un travail (le lot d'une file).
      let rps = 0;
      for (const s of incoming.values()) if (s.kind === kind) rps += s.rps / s.batch;
      const wait = env.syncWait(kind);
      const held = (rps * (def.latencyMs + wait.ms)) / 1000;
      busy += held;
      if (wait.dependency && held > worst.busy) worst = { busy: held, dependency: wait.dependency };
    }
    threads = busy / (def.threads * instances);
    if (threads > utilization) {
      utilization = threads;
      load = threads * capacity;
      if (threads > 1) blockedBy = worst.dependency;
    }
  }
  // Un quota compte des messages, pas du travail : un envoi regroupé n'y échappe pas.
  if (def.maxRps) {
    const quota = (sumRps(incoming) / (def.maxRps * instances)) * capacity;
    if (quota > load) {
      load = quota;
      utilization = Math.max(utilization, ratio(quota, capacity));
    }
  }
  load = timedOut(load, capacity, env);
  return {
    passed: serveWithin(node.id, incoming, load, capacity, env.ctx),
    utilization,
    syncForwardShare: allForwarded(),
    instances,
    ...(auto && auto.starting() > 0 ? { starting: auto.starting() } : {}),
    ...(threads !== undefined ? { threads } : {}),
    ...(blockedBy ? { blockedBy } : {}),
  };
}

/**
 * Autoscaling réactif : il dimensionne sur la charge du tick courant, mais les instances
 * demandées n'arrivent qu'après leur délai de démarrage. Réduire est immédiat.
 */
function autoscale(node: ArchNode, def: ComponentDef, base: number, env: ProcessEnv) {
  for (const up of Object.values(env.catalog.upgrades)) {
    if (up.effect.type !== 'autoscaling' || up.appliesTo !== node.type) continue;
    const max = upgradeLevel(node, up.id);
    if (max === 0) continue;
    const { instanceCost, startupTicks, targetUtilization } = up.effect;
    const tick = env.ctx.tick;

    let state = env.autoscalers.get(node.id);
    if (!state) {
      state = { instanceCost, active: 0, pending: [], instanceTicks: 0 };
      env.autoscalers.set(node.id, state);
    }
    const s = state;
    for (const p of s.pending.filter((x) => x.readyAt <= tick)) s.active += p.count;
    s.pending = s.pending.filter((x) => x.readyAt > tick);
    s.instanceTicks += s.active;

    return {
      active: s.active,
      /** Instances demandées qui démarrent encore, après la décision de ce tick. */
      starting: () => s.pending.reduce((a, p) => a + p.count, 0),
      plan(demand: number) {
        const wanted = Math.ceil(demand / (def.capacity * targetUtilization)) - base;
        const target = Math.min(max, Math.max(0, wanted));
        const inFlight = s.pending.reduce((a, p) => a + p.count, 0);
        if (target > s.active + inFlight) {
          s.pending.push({ readyAt: tick + startupTicks, count: target - s.active - inFlight });
        } else if (target < s.active) {
          s.active = target;
          s.pending = [];
        }
      },
    };
  }
  return undefined;
}

/**
 * Bordure (CDN) : sert une part des lectures sans les transmettre. Les tâches async
 * déclenchées par ces lectures-là n'ont jamais lieu, puisque le serveur ne les voit pas.
 */
function processEdge(node: ArchNode, def: ComponentDef, incoming: Flow, env: ProcessEnv): NodeOutcome {
  const capacity = def.capacity * instancesOf(node, env.catalog, env.down(node));
  const demand = work(incoming, def);
  const served = serveWithin(node.id, incoming, demand, capacity, env.ctx);
  const passed: Flow = new Map();
  for (const s of served.values()) {
    const hitRate = hitRateFor(s, def, env);
    if (s.kind === 'read') {
      addStream(passed, { ...s, rps: s.rps * (1 - hitRate) });
    } else if (s.kind === 'async') {
      fail(env.ctx, node.id, 'lost-at-edge', s.rps * hitRate, s.duplicate ? 0 : s.rps * hitRate);
      addStream(passed, { ...s, rps: s.rps * (1 - hitRate) });
    } else {
      addStream(passed, s);
    }
  }
  return {
    passed,
    utilization: ratio(demand, capacity),
    syncForwardShare: { ...allForwarded(), read: readShare(served, passed) },
  };
}

/**
 * Cache-aside : le routage ne lui envoie que les lectures qu'il sert, il n'a donc qu'à
 * tenir la charge. Les absences ne passent jamais par lui ; seuls les succès comptent
 * dans sa charge, les consultations ratées sont négligées.
 */
function processCache(node: ArchNode, def: ComponentDef, incoming: Flow, env: ProcessEnv): NodeOutcome {
  const capacity = def.capacity * instancesOf(node, env.catalog, env.down(node));
  const demand = work(incoming, def);
  return {
    passed: serveWithin(node.id, incoming, demand, capacity, env.ctx),
    utilization: ratio(demand, capacity),
    syncForwardShare: allForwarded(),
  };
}

/** Part des lectures servies qui continue vers l'aval, longue traîne comprise. */
function readShare(served: Flow, passed: Flow): number {
  const isRead = (s: Stream) => s.kind === 'read';
  const before = sumRps(served, isRead);
  return before > 0 ? sumRps(passed, isRead) / before : 0;
}

function hitRateFor(s: Stream, def: ComponentDef, env: ProcessEnv): number {
  return env.sourcesById.get(s.source)?.longTail ? 0 : (def.hitRate ?? 0) * env.hitFactor(def.id);
}

function processDatabase(node: ArchNode, def: ComponentDef, incoming: Flow, env: ProcessEnv): NodeOutcome {
  const primary = def.capacity * instancesOf(node, env.catalog, env.down(node));
  let replicaCapacity = 0;
  for (const up of Object.values(env.catalog.upgrades)) {
    if (up.effect.type === 'readReplicas' && up.appliesTo === node.type) {
      replicaCapacity += up.effect.capacityPerReplica * upgradeLevel(node, up.id);
    }
  }

  // Tout ce qui n'est pas une lecture passe par le primaire ; les lectures prennent
  // la capacité qu'il lui reste, plus celle des réplicas.
  const isRead = (s: Stream) => s.kind === 'read';
  const notRead = (s: Stream) => !isRead(s);
  const writeFlow = filterFlow(incoming, notRead);
  const readFlow = filterFlow(incoming, isRead);

  const writeDemand = work(writeFlow, def);
  const servedWrites = serveWithin(node.id, writeFlow, timedOut(writeDemand, primary, env), primary, env.ctx);
  const primaryLeft = Math.max(0, primary - Math.min(writeDemand, primary));

  const readDemand = work(readFlow, def);
  const readCapacity = primaryLeft + replicaCapacity;
  const consistent = (s: Stream) => !!env.sourcesById.get(s.source)?.consistent;
  const leaderReads = Object.values(env.catalog.upgrades).some(
    (u) => u.appliesTo === node.type && u.effect.type === 'leaderReads' && upgradeLevel(node, u.id) > 0,
  );
  const passed: Flow = new Map();
  for (const s of servedWrites.values()) addStream(passed, s);

  if (leaderReads && replicaCapacity > 0) {
    // Les lectures qui doivent être à jour prennent le primaire d'abord ; les autres se
    // partagent ce qui reste et les réplicas.
    const critical = filterFlow(readFlow, consistent);
    const others = filterFlow(readFlow, (s) => !consistent(s));
    const criticalDemand = work(critical, def);
    for (const s of serveWithin(node.id, critical, timedOut(criticalDemand, primaryLeft, env), primaryLeft, env.ctx).values()) addStream(passed, s);
    const left = Math.max(0, primaryLeft - Math.min(criticalDemand, primaryLeft)) + replicaCapacity;
    const served = left > 0 ? serveWithin(node.id, others, timedOut(work(others, def), left, env), left, env.ctx) : failAll(node.id, others, env.ctx);
    for (const s of served.values()) addStream(passed, s);
  } else {
    const servedReads =
      readCapacity > 0
        ? serveWithin(node.id, readFlow, timedOut(readDemand, readCapacity, env), readCapacity, env.ctx)
        : failAll(node.id, readFlow, env.ctx);
    // Les lectures se répartissent selon la capacité : la part servie par des réplicas
    // coupés du primaire est périmée, un échec pour qui exige une donnée à jour.
    const staleShare = env.partitioned(node) && readCapacity > 0 ? replicaCapacity / readCapacity : 0;
    for (const s of servedReads.values()) {
      const stale = consistent(s) ? s.rps * staleShare : 0;
      if (stale > 0) {
        fail(env.ctx, node.id, 'stale-read', stale);
        tally(env.ctx, node.id, 'stale', stale);
      }
      addStream(passed, { ...s, rps: s.rps - stale });
    }
  }

  const utilization = Math.max(
    ratio(writeDemand, primary),
    ratio(writeDemand + readDemand, primary + replicaCapacity),
  );
  return { passed, utilization, syncForwardShare: allForwarded() };
}

function failAll(nodeId: string, flow: Flow, ctx: TickContext): Flow {
  fail(ctx, nodeId, 'saturation', sumRps(flow), sumRps(flow, isEvent));
  return new Map();
}

function filterFlow(flow: Flow, pred: (s: Stream) => boolean): Flow {
  const out: Flow = new Map();
  for (const s of flow.values()) if (pred(s)) addStream(out, s);
  return out;
}

/**
 * Une file accepte vite, stocke, puis relâche au rythme que ses consommateurs
 * peuvent absorber. Ce qui sort est découplé : l'amont n'attend pas l'aval.
 */
function processQueue(node: ArchNode, def: ComponentDef, incoming: Flow, env: ProcessEnv): NodeOutcome {
  const capacity = def.capacity * instancesOf(node, env.catalog, env.down(node));
  const demand = work(incoming, def);
  const accepted = serveWithin(node.id, incoming, demand, capacity, env.ctx);

  const backlog = env.backlogs.get(node.id) ?? new Map<string, Stream>();
  for (const s of accepted.values()) addStream(backlog, s);

  const batch = def.batchSize ?? 1;
  const passed: Flow = new Map();
  for (const kind of REQUEST_KINDS) {
    const pending = sumRps(backlog, (s) => s.kind === kind);
    if (pending === 0) continue;
    const drain = Math.min(pending, drainCapacity(kind, batch, env));
    const share = drain / pending;
    for (const s of [...backlog.values()].filter((x) => x.kind === kind)) {
      const out = s.rps * share;
      addStream(passed, { ...s, batch: s.batch * batch, rps: out });
      s.rps -= out;
    }
  }

  let maxBacklog = def.maxBacklog ?? Infinity;
  for (const up of Object.values(env.catalog.upgrades)) {
    if (up.effect.type === 'retention' && up.appliesTo === node.type) maxBacklog += up.effect.perLevel * upgradeLevel(node, up.id);
  }
  const waiting = sumRps(backlog);
  if (waiting > maxBacklog) {
    const lost = waiting - maxBacklog;
    fail(env.ctx, node.id, 'queue-overflow', lost, (lost * sumRps(backlog, isEvent)) / waiting);
    env.ctx.events.push({ type: 'queue-overflow', tick: env.ctx.tick, node: node.id, lostRps: lost });
    for (const s of backlog.values()) s.rps *= maxBacklog / waiting;
  }
  for (const [k, s] of backlog) if (s.rps <= 1e-9) backlog.delete(k);
  env.backlogs.set(node.id, backlog);

  return {
    passed,
    utilization: ratio(demand, capacity),
    syncForwardShare: { read: 0, write: 0, async: 0 },
  };
}

/** Messages par seconde que les consommateurs d'une file peuvent absorber pour ce type. */
function drainCapacity(kind: RequestKind, batch: number, env: ProcessEnv): number {
  let total = 0;
  for (const c of env.consumers) {
    if (!c.kinds.includes(kind)) continue;
    const perBatch = c.def.workPerRequest[kind] ?? 0;
    const instances = instancesOf(c.node, env.catalog, env.down(c.node));
    const quota = c.def.maxRps !== undefined ? c.def.maxRps * instances : Infinity;
    if (perBatch === 0) {
      if (quota === Infinity) return Infinity;
      total += quota;
      continue;
    }
    total += Math.min(((c.def.capacity * instances) / perBatch) * batch, quota);
  }
  return total;
}

/** Voisins transmis d'un nœud, avec les types que le routage leur envoie. */
function consumersOf(routes: NodeRoutes): { id: string; kinds: RequestKind[] }[] {
  const byId = new Map<string, RequestKind[]>();
  for (const kind of REQUEST_KINDS) {
    for (const id of routes.forward[kind]) byId.set(id, [...(byId.get(id) ?? []), kind]);
  }
  return [...byId].map(([id, kinds]) => ({ id, kinds }));
}

/** Débit envoyé par nœud, par type et par voisin pendant le tick : pondère les latences. */
type Routed = Map<string, Map<RequestKind, Map<string, number>>>;

interface RouteEnv {
  inbound: Map<string, Flow>;
  ctx: TickContext;
  reportedNoRoute: Set<string>;
  routed: Routed;
  hitRateAt: (nodeId: string, s: Stream) => number;
  roles: MessagingRoles;
  incidentShare: (effect: 'duplicate-delivery' | 'publish-loss') => number;
  /** Service qui doit recevoir chaque événement : ce qui lui parvient compte comme livré. */
  consumer: boolean;
  /** Dépendances coupées par le circuit breaker de ce nœud : leurs appels échouent tout de suite. */
  open: Set<string> | undefined;
  herdAt: (cacheId: string) => number;
}

/** Ce qu'un nœud fait des événements async : les publier, les consommer, avec quelles protections. */
interface MessagingRoles {
  /** Serveur qui publie vers une file ou un pub/sub : exposé à la perte à la publication. */
  publisher: boolean;
  /** Base à outbox où ce serveur écrit : ses événements passent par elle et ne se perdent plus. */
  outbox?: string;
  /** Service consommateur idempotent : il écarte les doublons, avec sa propre mémoire des clés. */
  idempotent: boolean;
  /** Bases où ce nœud écrit : l'outbox est cherchée parmi elles. */
  writeTargets: string[];
}

function messagingRoles(
  node: ArchNode,
  nodes: Map<string, ArchNode>,
  catalog: Catalog,
  routes: RouteTable,
): MessagingRoles {
  const own = routes.get(node.id)!;
  const behaviorOf = (id: string) => catalog.components[nodes.get(id)?.type ?? '']?.behavior;
  const hasEffect = (n: ArchNode | undefined, effect: string) =>
    !!n && Object.values(catalog.upgrades).some((u) => u.appliesTo === n.type && u.effect.type === effect && upgradeLevel(n, u.id) > 0);
  const service = catalog.components[node.type]?.behavior === 'service';
  const writeTargets = own.forward.write.filter((id) => behaviorOf(id) === 'database');
  const outbox = writeTargets.find((id) => hasEffect(nodes.get(id), 'outbox'));
  return {
    publisher: service && own.forward.async.some((id) => behaviorOf(id) === 'queue' || behaviorOf(id) === 'pubsub'),
    ...(outbox ? { outbox } : {}),
    idempotent: service && hasEffect(node, 'idempotence'),
    writeTargets,
  };
}

function linkTraffic(routed: Routed): TickMetrics['links'] {
  const links: TickMetrics['links'] = {};
  for (const [from, byKind] of routed) {
    for (const [kind, byTo] of byKind) {
      for (const [to, rps] of byTo) (links[`${from}→${to}`] ??= {})[kind] = rps;
    }
  }
  return links;
}

function route(id: string, def: ComponentDef, passed: Flow, routes: NodeRoutes, env: RouteEnv): void {
  const send = (to: string, s: Stream, rps: number) => {
    if (rps <= 0) return;
    addStream(env.inbound.get(to)!, { ...s, rps });
    const byKind = env.routed.get(id) ?? new Map<RequestKind, Map<string, number>>();
    const byTo = byKind.get(s.kind) ?? new Map<string, number>();
    byTo.set(to, (byTo.get(to) ?? 0) + rps);
    byKind.set(s.kind, byTo);
    env.routed.set(id, byKind);
  };

  const { roles } = env;

  for (const original of passed.values()) {
    let s = original;
    if (env.consumer && isEvent(s)) env.ctx.asyncTally.delivered += s.rps;

    if (s.kind === 'async' && def.behavior === 'service') {
      if (s.duplicate) {
        // Un doublon reconnu est écarté ; sinon il est traité une seconde fois, et c'est l'erreur.
        // La clé déjà vue est gardée par le service lui-même : pas de base partagée (S10).
        if (roles.idempotent) {
          tally(env.ctx, id, 'deduplicated', s.rps);
          continue;
        }
        tally(env.ctx, id, 'duplicates', s.rps);
        fail(env.ctx, id, 'duplicate', s.rps);
        continue;
      }
      if (!def.terminalFor.includes(s.kind)) {
        if (roles.publisher && roles.outbox) {
          send(roles.outbox, { ...s, kind: 'write' }, s.rps);
        } else if (roles.publisher) {
          const lost = s.rps * Math.min(1, env.incidentShare('publish-loss'));
          if (lost > 0) {
            tally(env.ctx, id, 'lost', lost);
            fail(env.ctx, id, 'lost-event', lost, lost);
            s = { ...s, rps: s.rps - lost };
          }
        }
      }
    }
    if (def.terminalFor.includes(s.kind)) continue;

    // Cache-aside : chaque cache consulté sert sa part, le reste repart d'ici.
    let remaining = s.rps;
    let herd = 1;
    const lookups = routes.lookup[s.kind];
    for (const cache of lookups) {
      const consulted = s.rps / lookups.length;
      const hits = consulted * env.hitRateAt(cache, s);
      send(cache, s, hits);
      remaining -= hits;
      herd = Math.max(herd, env.herdAt(cache));
    }
    // Une ruée recalcule chaque absence plusieurs fois : la base fait `herd` fois le travail,
    // mais chaque client n'attend qu'une réponse (un lot plus petit que 1 multiplie le travail).
    if (herd > 1) s = { ...s, batch: s.batch / herd };

    const targets = routes.forward[s.kind];
    if (targets.length === 0) {
      fail(env.ctx, id, 'no-route', remaining, isEvent(s) ? remaining : 0);
      const key = `${id}|${s.kind}`;
      if (remaining > 0 && !env.reportedNoRoute.has(key)) {
        env.reportedNoRoute.add(key);
        env.ctx.events.push({ type: 'no-route', tick: env.ctx.tick, node: id, kind: s.kind });
      }
      continue;
    }
    // Une file partage les messages entre ses voisins ; un pub/sub les copie à chacun.
    const each = def.fanOut ? remaining : remaining / targets.length;
    const duplicated = s.kind === 'async' && !s.duplicate ? Math.min(1, env.incidentShare('duplicate-delivery')) : 0;
    for (const to of targets) {
      if (env.open?.has(to)) {
        fail(env.ctx, id, 'circuit-open', each, isEvent(s) ? each : 0);
        continue;
      }
      send(to, s, each);
      if (duplicated > 0) send(to, { ...s, duplicate: true }, each * duplicated);
    }
  }
}

/**
 * Latence moyenne d'une requête depuis un nœud jusqu'au bout de son chemin synchrone.
 * `skip` écarte des voisins : les caches, pour une lecture qui ne peut pas y tomber.
 */
function computePathLatencies(
  order: string[],
  routes: RouteTable,
  routed: Routed,
  outcomes: Map<string, NodeOutcome>,
  nodeTicks: Record<string, NodeTick>,
  open: Map<string, Set<string>>,
  skip: (id: string) => boolean = () => false,
): (id: string, kind: RequestKind) => number {
  const memo = new Map<string, number>();
  for (const id of [...order].reverse()) {
    for (const kind of REQUEST_KINDS) {
      const own = nodeTicks[id]?.latencyMs ?? 0;
      const share = outcomes.get(id)?.syncForwardShare[kind] ?? 0;
      const sent = [...(routed.get(id)?.get(kind) ?? new Map<string, number>())].filter(([to]) => !skip(to));
      const total = sent.reduce((a, [, x]) => a + x, 0);
      let downstream = 0;
      if (total > 0) {
        for (const [to, rps] of sent) downstream += (rps / total) * (memo.get(`${to}|${kind}`) ?? 0);
      } else {
        // Pas de trafic ce tick : on suppose une répartition égale, pour que la latence reste définie.
        // Un appel coupé par le disjoncteur échoue tout de suite : il n'attend pas l'aval.
        const targets = (routes.get(id)?.forward[kind] ?? []).filter((t) => !open.get(id)?.has(t) && !skip(t));
        if (targets.length > 0) {
          downstream = targets.reduce((a, to) => a + (memo.get(`${to}|${kind}`) ?? 0), 0) / targets.length;
        }
      }
      memo.set(`${id}|${kind}`, own + share * downstream);
    }
  }
  return (id, kind) => memo.get(`${id}|${kind}`) ?? 0;
}

function sumFailures(f: Record<FailureReason, number>): number {
  return Object.values(f).reduce((a, x) => a + x, 0);
}

function gauge(value: number, limit: number): Gauge {
  return { value, limit, margin: limit > 0 ? (limit - value) / limit : value > 0 ? -Infinity : 0 };
}

/** Percentile par rang le plus proche : sur 60 ticks, le p95 écarte les 3 pires. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

function lossReasonsFor(g: WaveResult['gauges'], billed: WaveResult['bill']): string[] {
  const reasons: string[] = [];
  if (g.cost.value > g.cost.limit) {
    const parts = [
      billed.autoscaling > 0 && `${fmt(billed.autoscaling)} d'autoscaling`,
      billed.migration > 0 && `${fmt(billed.migration)} de migration`,
    ].filter(Boolean);
    const detail = parts.length > 0 ? `, dont ${parts.join(' et ')}` : '';
    reasons.push(`Budget dépassé : ${fmt(g.cost.value)} / ${fmt(g.cost.limit)}${detail}`);
  }
  if (g.complexity.value > g.complexity.limit) {
    reasons.push(`Trop complexe : ${fmt(g.complexity.value)} / ${fmt(g.complexity.limit)} points`);
  }
  if (g.failureRate.value > g.failureRate.limit) {
    reasons.push(`SLA rompu : ${pct(g.failureRate.value)} d'échecs (max ${pct(g.failureRate.limit)})`);
  }
  if (g.latency.value > g.latency.limit) {
    reasons.push(`SLA rompu : latence p95 (approx.) ${fmt(g.latency.value)} ms (max ${fmt(g.latency.limit)} ms)`);
  }
  return reasons;
}

function invalidResult(
  wave: Wave,
  billed: WaveResult['bill'],
  complexity: number,
  errors: string[],
): WaveResult {
  return {
    won: false,
    lossReasons: errors.map((e) => `Architecture invalide : ${e}`),
    bill: billed,
    avgLatencyMs: 0,
    gauges: {
      cost: gauge(billed.fixed + billed.autoscaling + billed.migration, wave.budget),
      complexity: gauge(complexity, wave.complexityCap),
      failureRate: gauge(1, wave.sla.maxFailureRate),
      latency: gauge(0, wave.sla.maxP95LatencyMs),
    },
    offered: 0,
    failed: 0,
    failuresByReason: noFailures(),
    shed: 0,
    nodes: {},
    ticks: [],
    events: errors.map((message) => ({ type: 'invalid', message })),
  };
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const pct = (n: number) => `${(n * 100).toFixed(2)} %`;
