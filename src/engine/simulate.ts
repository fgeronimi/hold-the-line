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
}

type Flow = Map<string, Stream>;

function streamKey(s: Pick<Stream, 'kind' | 'source' | 'batch'>): string {
  return `${s.kind}|${s.source}|${s.batch}`;
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

function loadedLatency(def: ComponentDef, utilization: number): number {
  return def.latencyMs / (1 - Math.min(utilization, MAX_UTILIZATION_FOR_LATENCY));
}

function factorAt(wave: Wave, tick: number): number {
  return wave.profile.find((seg) => tick < seg.until)?.factor ?? wave.profile.at(-1)?.factor ?? 1;
}

interface NodeOutcome {
  /** Flux servi par ce nœud et qui continue vers l'aval (avant routage). */
  passed: Flow;
  utilization: number;
  /** Part de chaque type servi qui poursuit sa route de façon synchrone. */
  syncForwardShare: Partial<Record<RequestKind, number>>;
  instances?: number;
}

interface AutoscaleState {
  instanceCost: number;
  active: number;
  pending: { readyAt: number; count: number }[];
  /** Somme sur les ticks des instances ajoutées en service : base de la facture. */
  instanceTicks: number;
}

interface TickContext {
  tick: number;
  failures: Record<FailureReason, number>;
  nodeFailed: Map<string, number>;
  events: SimEvent[];
  shed: { value: number };
}

const P95 = 0.95;

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
  const hitRateAt = (nodeId: string, s: Stream): number =>
    sourcesById.get(s.source)?.longTail ? 0 : (defOf(nodeId).hitRate ?? 0);

  const sourcesById = new Map(wave.sources.map((s) => [s.id, s]));
  const backlogs = new Map<string, Flow>();
  const autoscalers = new Map<string, AutoscaleState>();
  const saturated = new Set<string>();
  const summaries = new Map<string, NodeSummary>(
    [...nodes.keys()].map((id) => [id, { peakUtilization: 0, failed: 0, saturatedTicks: 0 }]),
  );

  const failures: Record<FailureReason, number> = {
    saturation: 0,
    'no-route': 0,
    'rate-limited': 0,
    'queue-overflow': 0,
    'lost-at-edge': 0,
  };
  const events: SimEvent[] = [];
  const shed = { value: 0 };
  const ticks: TickMetrics[] = [];
  const reportedNoRoute = new Set<string>();

  let offeredTotal = 0;
  let syncWeightedLatency = 0;
  let syncOffered = 0;

  for (let tick = 0; tick < wave.ticks; tick++) {
    const factor = factorAt(wave, tick);
    const nodeFailed = new Map<string, number>();
    const ctx: TickContext = { tick, failures, nodeFailed, events, shed };
    const failedBefore = sumFailures(failures);

    const inbound = new Map<string, Flow>([...nodes.keys()].map((id) => [id, new Map()]));
    const injected: Flow = new Map();
    for (const src of wave.sources) {
      for (const kind of REQUEST_KINDS) {
        addStream(injected, { kind, source: src.id, batch: 1, rps: (src.rps[kind] ?? 0) * factor });
      }
    }
    inbound.set(validation.sourceId, injected);
    const offered = sumRps(injected);
    offeredTotal += offered;

    const outcomes = new Map<string, NodeOutcome>();
    const nodeTicks: Record<string, NodeTick> = {};
    const routed: Routed = new Map();

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
        consumers: consumersOf(routes.get(id)!).map((c) => ({ ...c, def: defOf(c.id), node: nodes.get(c.id)! })),
      });
      outcomes.set(id, outcome);

      route(id, def, outcome.passed, routes.get(id)!, { inbound, ctx, reportedNoRoute, routed, hitRateAt });

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
        utilization: outcome.utilization,
        latencyMs: loadedLatency(def, outcome.utilization),
        failed: nodeFailed.get(id) ?? 0,
        ...(backlogs.has(id) ? { backlog: sumRps(backlogs.get(id)!) } : {}),
        ...(outcome.instances !== undefined ? { instances: outcome.instances } : {}),
      };
    }

    const pathLatency = computePathLatencies(validation.order, routes, routed, outcomes, nodeTicks);
    const injectedSync = SYNC_KINDS.map((k) => ({ k, rps: sumRps(injected, (s) => s.kind === k) }));
    const syncRps = injectedSync.reduce((a, x) => a + x.rps, 0);
    const tickLatency =
      syncRps > 0
        ? injectedSync.reduce((a, x) => a + x.rps * (pathLatency(validation.sourceId, x.k)), 0) / syncRps
        : 0;
    syncWeightedLatency += tickLatency * syncRps;
    syncOffered += syncRps;

    ticks.push({
      tick,
      offered,
      failed: sumFailures(failures) - failedBefore,
      avgLatencyMs: tickLatency,
      nodes: nodeTicks,
    });
  }

  for (const id of saturated) events.push({ type: 'saturation-end', tick: wave.ticks, node: id });

  for (const a of autoscalers.values()) billed.autoscaling += (a.instanceTicks * a.instanceCost) / wave.ticks;

  const failed = sumFailures(failures);
  const counted = offeredTotal - shed.value;
  const failureRate = counted > 0 ? failed / counted : 0;
  const avgLatency = syncOffered > 0 ? syncWeightedLatency / syncOffered : 0;

  const gauges = {
    cost: gauge(billed.fixed + billed.autoscaling + billed.migration, wave.budget),
    complexity: gauge(complexity, wave.complexityCap),
    failureRate: gauge(failureRate, wave.sla.maxFailureRate),
    latency: gauge(percentile(ticks.map((t) => t.avgLatencyMs), P95), wave.sla.maxP95LatencyMs),
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
  consumers: { kinds: RequestKind[]; def: ComponentDef; node: ArchNode }[];
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
  }
}

function allForwarded(): Partial<Record<RequestKind, number>> {
  return { read: 1, write: 1, async: 1 };
}

function instancesOf(node: ArchNode, catalog: Catalog): number {
  let extra = 0;
  for (const up of Object.values(catalog.upgrades)) {
    if (up.effect.type === 'instances' && up.appliesTo === node.type) extra += upgradeLevel(node, up.id);
  }
  return 1 + extra;
}

/** Sert ce qui tient dans la capacité, fait échouer le reste à parts égales. */
function serveWithin(nodeId: string, flow: Flow, demand: number, capacity: number, ctx: TickContext): Flow {
  if (demand <= capacity || demand === 0) return flow;
  const servedShare = capacity / demand;
  const lost = sumRps(flow) * (1 - servedShare);
  fail(ctx, nodeId, 'saturation', lost);
  return scaleFlow(flow, servedShare);
}

function fail(ctx: TickContext, nodeId: string, reason: FailureReason, rps: number): void {
  if (rps <= 0) return;
  ctx.failures[reason] += rps;
  ctx.nodeFailed.set(nodeId, (ctx.nodeFailed.get(nodeId) ?? 0) + rps);
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
  const capacity = def.capacity * instancesOf(node, env.catalog);
  const demand = work(flow, def);
  return {
    passed: serveWithin(node.id, flow, demand, capacity, env.ctx),
    utilization: demand / capacity,
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
    if (src?.abusive) env.ctx.shed.value += rejected;
    else fail(env.ctx, nodeId, 'rate-limited', rejected);
    env.ctx.events.push({ type: 'rate-limited', tick: env.ctx.tick, node: nodeId, source: sourceId, rejectedRps: rejected });
  }
  for (const s of flow.values()) addStream(out, { ...s, rps: s.rps * (keepShare.get(s.source) ?? 1) });
  return out;
}

function processService(node: ArchNode, def: ComponentDef, incoming: Flow, env: ProcessEnv): NodeOutcome {
  const base = instancesOf(node, env.catalog);
  const auto = autoscale(node, def, base, env);
  const instances = base + (auto?.active ?? 0);
  const capacity = def.capacity * instances;
  const demand = work(incoming, def);
  auto?.plan(demand);
  return {
    passed: serveWithin(node.id, incoming, demand, capacity, env.ctx),
    utilization: demand / capacity,
    syncForwardShare: allForwarded(),
    instances,
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
  const capacity = def.capacity * instancesOf(node, env.catalog);
  const demand = work(incoming, def);
  const served = serveWithin(node.id, incoming, demand, capacity, env.ctx);
  const passed: Flow = new Map();
  for (const s of served.values()) {
    const hitRate = hitRateFor(s, def, env);
    if (s.kind === 'read') {
      addStream(passed, { ...s, rps: s.rps * (1 - hitRate) });
    } else if (s.kind === 'async') {
      fail(env.ctx, node.id, 'lost-at-edge', s.rps * hitRate);
      addStream(passed, { ...s, rps: s.rps * (1 - hitRate) });
    } else {
      addStream(passed, s);
    }
  }
  return {
    passed,
    utilization: demand / capacity,
    syncForwardShare: { ...allForwarded(), read: readShare(served, passed) },
  };
}

/**
 * Cache-aside : le routage ne lui envoie que les lectures qu'il sert, il n'a donc qu'à
 * tenir la charge. Les absences ne passent jamais par lui ; seuls les succès comptent
 * dans sa charge, les consultations ratées sont négligées.
 */
function processCache(node: ArchNode, def: ComponentDef, incoming: Flow, env: ProcessEnv): NodeOutcome {
  const capacity = def.capacity * instancesOf(node, env.catalog);
  const demand = work(incoming, def);
  return {
    passed: serveWithin(node.id, incoming, demand, capacity, env.ctx),
    utilization: demand / capacity,
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
  return env.sourcesById.get(s.source)?.longTail ? 0 : (def.hitRate ?? 0);
}

function processDatabase(node: ArchNode, def: ComponentDef, incoming: Flow, env: ProcessEnv): NodeOutcome {
  const primary = def.capacity * instancesOf(node, env.catalog);
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
  const servedWrites = serveWithin(node.id, writeFlow, writeDemand, primary, env.ctx);
  const primaryLeft = Math.max(0, primary - Math.min(writeDemand, primary));

  const readDemand = work(readFlow, def);
  const readCapacity = primaryLeft + replicaCapacity;
  const servedReads =
    readCapacity > 0
      ? serveWithin(node.id, readFlow, readDemand, readCapacity, env.ctx)
      : failAll(node.id, readFlow, env.ctx);

  const passed: Flow = new Map();
  for (const s of servedWrites.values()) addStream(passed, s);
  for (const s of servedReads.values()) addStream(passed, s);

  const utilization = Math.max(
    writeDemand / primary,
    (writeDemand + readDemand) / (primary + replicaCapacity),
  );
  return { passed, utilization, syncForwardShare: allForwarded() };
}

function failAll(nodeId: string, flow: Flow, ctx: TickContext): Flow {
  fail(ctx, nodeId, 'saturation', sumRps(flow));
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
  const capacity = def.capacity * instancesOf(node, env.catalog);
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

  const maxBacklog = def.maxBacklog ?? Infinity;
  const waiting = sumRps(backlog);
  if (waiting > maxBacklog) {
    const lost = waiting - maxBacklog;
    fail(env.ctx, node.id, 'queue-overflow', lost);
    env.ctx.events.push({ type: 'queue-overflow', tick: env.ctx.tick, node: node.id, lostRps: lost });
    for (const s of backlog.values()) s.rps *= maxBacklog / waiting;
  }
  for (const [k, s] of backlog) if (s.rps <= 1e-9) backlog.delete(k);
  env.backlogs.set(node.id, backlog);

  return {
    passed,
    utilization: demand / capacity,
    syncForwardShare: { read: 0, write: 0, async: 0 },
  };
}

/** Messages par seconde que les consommateurs d'une file peuvent absorber pour ce type. */
function drainCapacity(kind: RequestKind, batch: number, env: ProcessEnv): number {
  let total = 0;
  for (const c of env.consumers) {
    if (!c.kinds.includes(kind)) continue;
    const perBatch = c.def.workPerRequest[kind] ?? 0;
    if (perBatch === 0) return Infinity;
    total += ((c.def.capacity * instancesOf(c.node, env.catalog)) / perBatch) * batch;
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

  for (const s of passed.values()) {
    if (def.terminalFor.includes(s.kind)) continue;

    // Cache-aside : chaque cache consulté sert sa part, le reste repart d'ici.
    let remaining = s.rps;
    const lookups = routes.lookup[s.kind];
    for (const cache of lookups) {
      const consulted = s.rps / lookups.length;
      const hits = consulted * env.hitRateAt(cache, s);
      send(cache, s, hits);
      remaining -= hits;
    }

    const targets = routes.forward[s.kind];
    if (targets.length === 0) {
      fail(env.ctx, id, 'no-route', remaining);
      const key = `${id}|${s.kind}`;
      if (remaining > 0 && !env.reportedNoRoute.has(key)) {
        env.reportedNoRoute.add(key);
        env.ctx.events.push({ type: 'no-route', tick: env.ctx.tick, node: id, kind: s.kind });
      }
      continue;
    }
    for (const to of targets) send(to, s, remaining / targets.length);
  }
}

/** Latence moyenne d'une requête depuis un nœud jusqu'au bout de son chemin synchrone. */
function computePathLatencies(
  order: string[],
  routes: RouteTable,
  routed: Routed,
  outcomes: Map<string, NodeOutcome>,
  nodeTicks: Record<string, NodeTick>,
): (id: string, kind: RequestKind) => number {
  const memo = new Map<string, number>();
  for (const id of [...order].reverse()) {
    for (const kind of REQUEST_KINDS) {
      const own = nodeTicks[id]?.latencyMs ?? 0;
      const share = outcomes.get(id)?.syncForwardShare[kind] ?? 0;
      const sent = routed.get(id)?.get(kind);
      const total = sent ? [...sent.values()].reduce((a, x) => a + x, 0) : 0;
      let downstream = 0;
      if (sent && total > 0) {
        for (const [to, rps] of sent) downstream += (rps / total) * (memo.get(`${to}|${kind}`) ?? 0);
      } else {
        // Pas de trafic ce tick : on suppose une répartition égale, pour que la latence reste définie.
        const targets = routes.get(id)?.forward[kind] ?? [];
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
  return f.saturation + f['no-route'] + f['rate-limited'] + f['queue-overflow'] + f['lost-at-edge'];
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
    failuresByReason: { saturation: 0, 'no-route': 0, 'rate-limited': 0, 'queue-overflow': 0, 'lost-at-edge': 0 },
    shed: 0,
    nodes: {},
    ticks: [],
    events: errors.map((message) => ({ type: 'invalid', message })),
  };
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const pct = (n: number) => `${(n * 100).toFixed(2)} %`;
