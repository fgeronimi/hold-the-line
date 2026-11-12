import { migrationCost, totals } from './budget.ts';
import { callTimeouts, openCircuits } from './circuits.ts';
import { addStream, isEvent, sumRps, type Flow } from './flow.ts';
import { activeAt, incidentState } from './incidents.ts';
import { judgeLatency, latencyObjectives, latencyPoints, loadedLatency, tickLatencyOf, weightedMean, type LatencyPoint } from './latency.ts';
import { noFailures, nonZero, sumFailures, type Ledger } from './ledger.ts';
import { lossMessages } from './messages.ts';
import { factorAt } from './profile.ts';
import { processNode, type NodeOutcome } from './nodes/index.ts';
import { blockedForGood, settleQueues } from './nodes/queue.ts';
import { planRetries, retriesAt, retryPlan, sumKinds, type RetryPlan } from './retries.ts';
import { linkTraffic, messagingRoles, route, type Delivery } from './route.ts';
import { routeTable } from './routing.ts';
import type {
  ArchNode,
  Architecture,
  Catalog,
  ComponentDef,
  Incident,
  NodeSummary,
  NodeTick,
  TickMetrics,
  Wave,
  WaveResult,
} from './types.ts';
import { REQUEST_KINDS } from './types.ts';
import { hasEffect, instancesOf, resolveUpgrades } from './upgrades.ts';
import { validateArchitecture } from './validate.ts';
import { gauge, invalidResult, lossesFor } from './verdict.ts';
import { defOf, isDown, latencyOf, type Now, type World } from './world.ts';

export { envelopeAt } from './profile.ts';

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
  const routes = routeTable(arch, catalog);
  const upgrades = new Map(arch.nodes.map((n) => [n.id, resolveUpgrades(n, catalog)]));
  const retries = retryPlan(wave, upgrades.get(validation.sourceId)!);
  const w: World = {
    catalog,
    nodes,
    routes,
    upgrades,
    roles: new Map(arch.nodes.map((n) => [n.id, messagingRoles(n, nodes, catalog, routes, upgrades)])),
    sourcesById: new Map(wave.sources.map((s) => [s.id, s])),
    consumers: new Set(wave.consumers ?? []),
    retrying: new Set(retries.retrying.map((s) => s.id)),
    backlogs: new Map(),
    requeued: new Map(),
    deadLetters: new Map(),
    autoscalers: new Map(),
  };

  const saturated = new Set<string>();
  const summaries = new Map<string, NodeSummary>(
    [...nodes.keys()].map((id) => [id, { peakUtilization: 0, failed: 0, saturatedTicks: 0 }]),
  );

  const failures = noFailures();
  const events: WaveResult['events'] = [];
  const shed = { value: 0 };
  const asyncTally = { failed: 0, delivered: 0 };
  const fanOut = w.consumers.size;
  let asyncInjected = 0;
  let undeliveredSoFar = 0;
  const ticks: TickMetrics[] = [];
  const reportedNoRoute = new Set<string>();
  const reportedBlocked = new Set<string>();

  let offeredTotal = 0;
  /** Les chemins servis de chaque tick, avec leur débit : la distribution du p95 de la vague (M4). */
  const servedPaths: LatencyPoint[][] = [];
  let countedSoFar = 0;
  /** Arrivées cumulées de chaque file, tick par tick : de quoi dater son plus vieux message (M13). */
  const arrivals = new Map<string, number[]>();
  let clientFailedSoFar = 0;
  /** Échecs comptés par le SLA, en requêtes : une copie d'événement pèse 1 / abonnés (B9). */
  let slaFailed = 0;
  // Un événement que k services sur n n'ont pas reçu compte pour k / n d'échec : une commande
  // à moitié livrée est à moitié en échec, et le taux ne dépasse jamais 100 % (B9).
  const copyWeight = fanOut > 1 ? 1 / fanOut : 1;
  let active: Incident[] = [];
  const [general, ...ownObjectives] = latencyObjectives(wave.sla);

  for (let tick = 0; tick < wave.ticks; tick++) {
    const factor = factorAt(wave, tick);
    const was = new Set(active.map((i) => i.id));
    active = activeAt(wave.incidents, tick);
    for (const i of active) if (!was.has(i.id)) events.push({ type: 'incident-start', tick, incident: i.id });
    for (const id of was) if (!active.some((i) => i.id === id)) events.push({ type: 'incident-end', tick, incident: id });
    const ledger: Ledger = { tick, failures, nodeFailed: new Map(), nodeShed: new Map(), nodeTally: new Map(), events, shed, asyncTally, clientFailed: new Map(), classLost: new Map() };
    const failedBefore = sumFailures(failures);
    const eventsFailedBefore = asyncTally.failed;
    const undeliveredBefore = failures.undelivered;

    const { injected, retried } = inject(wave, retries, tick, factor);
    const delivery: Delivery = {
      inbound: new Map<string, Flow>([...nodes.keys()].map((id) => [id, new Map()])),
      routed: new Map(),
      waited: new Map(),
      classes: new Map(),
      classWaited: new Map(),
      reportedNoRoute,
    };
    delivery.inbound.set(validation.sourceId, injected);
    asyncInjected += sumRps(injected, isEvent);
    const offered = sumRps(injected);
    offeredTotal += offered;

    const incidents = incidentState(active, tick);
    const open = openCircuits(w, incidents);
    const now: Now = { ledger, incidents, open, timeouts: callTimeouts(w, incidents, open) };
    const outcomes = new Map<string, NodeOutcome>();
    const nodeTicks: Record<string, NodeTick> = {};

    for (const id of validation.order) {
      const node = nodes.get(id)!;
      const def = defOf(w, id);
      const incoming = delivery.inbound.get(id)!;
      const outcome = processNode(node, def, incoming, w, now);
      outcomes.set(id, outcome);
      route(id, def, outcome.passed, w, now, delivery);
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
    }
    // Les files reprennent ce que l'aval n'a pas traité avant que le tick soit relevé.
    settleQueues(w, now);
    for (const id of validation.order) {
      summaries.get(id)!.failed += ledger.nodeFailed.get(id) ?? 0;
      const age = w.backlogs.has(id) ? oldestAge(arrivals, id, tick, sumRps(delivery.inbound.get(id)!), sumRps(w.backlogs.get(id)!)) : undefined;
      nodeTicks[id] = nodeTickOf(w, now, nodes.get(id)!, defOf(w, id), delivery.inbound.get(id)!, outcomes.get(id)!, age);
    }

    const paths = latencyPoints(w, {
      sourceId: validation.sourceId,
      injected,
      classes: delivery.classes,
      lost: ledger.classLost,
      waited: delivery.classWaited,
      timeoutMs: (id) => now.timeouts.get(id)?.ms ?? 0,
      // Une dépendance qui se tait fait attendre chaque appel jusqu'au délai du client (M12).
      silent: (id) => isDown(w, incidents, id) && latencyOf(w, incidents, id) > defOf(w, id).latencyMs,
      nodeTicks,
    });
    servedPaths.push(paths);

    // Ce qui manque aux abonnés attendus, une fois retirés les échecs déjà comptés et ce
    // qui attend encore en file : compté au fil des ticks, pour que le rejeu le montre.
    if (fanOut > 0) {
      // Seul ce qui attend dans une file vidée par un consommateur arrivera un jour ; pas dans
      // une file qu'un message empoisonné bloque pour de bon (S25).
      const waiting = [...w.backlogs]
        .filter(([id]) => routes.get(id)!.forward.async.length > 0 && !blockedForGood(w, id))
        .reduce((a, [, b]) => a + sumRps(b, isEvent), 0);
      const missing = Math.max(0, asyncInjected * fanOut - asyncTally.delivered - asyncTally.failed - waiting);
      if (missing > undeliveredSoFar) failures.undelivered += missing - undeliveredSoFar;
      undeliveredSoFar = Math.max(undeliveredSoFar, missing);
    }

    // Chaque source relance ses propres échecs, ceux que le client voit (M10).
    if (retries.retrying.length > 0) planRetries(retries, wave.ticks, tick, factor, ledger.clientFailed);

    const failedNow = sumFailures(failures) - failedBefore;
    const copiesFailedNow = asyncTally.failed - eventsFailedBefore + failures.undelivered - undeliveredBefore;
    const slaFailedNow = failedNow - copiesFailedNow * (1 - copyWeight);
    slaFailed += slaFailedNow;
    const shedNow = Object.values(nodeTicks).reduce((a, n) => a + (n.shed ?? 0), 0);
    const shown = tickLatencyOf(paths, general!, wave.sla);
    ticks.push({
      tick,
      offered,
      failed: failedNow,
      // Déduites à l'injection, comme le rejeu les a toujours affichées (voir `TickMetrics`).
      countedSoFar: (countedSoFar += offered - shedNow - retried),
      clientFailedSoFar: (clientFailedSoFar += slaFailedNow - retried),
      avgLatencyMs: weightedMean(paths),
      slaLatencyMs: shown.p95Ms,
      answeredRps: shown.answeredRps,
      slowRps: shown.slowRps,
      ...(ownObjectives.length > 0
        ? { latencyByKind: Object.fromEntries(ownObjectives.map((o) => [o.kind!, tickLatencyOf(paths, o, wave.sla)])) }
        : {}),
      nodes: nodeTicks,
      links: linkTraffic(delivery.routed),
      ...(active.length > 0 ? { incidents: active.map((i) => i.id) } : {}),
      ...(retried > 0 ? { retries: retried } : {}),
    });
  }

  for (const id of saturated) events.push({ type: 'saturation-end', tick: wave.ticks, node: id });
  for (const i of active) events.push({ type: 'incident-end', tick: wave.ticks, incident: i.id });

  for (const a of w.autoscalers.values()) billed.autoscaling += (a.instanceTicks * a.instanceCost) / wave.ticks;

  // Un échec relancé n'est pas vu du client : sa relance compte à sa place, réussie ou non.
  const failed = slaFailed - retries.total;
  const counted = offeredTotal - shed.value - retries.total;
  const failureRate = counted > 0 ? failed / counted : 0;
  const avgLatency = weightedMean(servedPaths.flat());

  // Chaque objectif de latence juge ses réponses (M4) ; la jauge retient le plus serré.
  const verdicts = judgeLatency(servedPaths, wave.sla);
  const latencyGauges = verdicts.map((v) => ({ v, g: gauge(v.p95Ms, v.objective.limitMs) }));
  const binding = latencyGauges.reduce((worst, x) => (x.g.margin < worst.g.margin ? x : worst));
  const gauges = {
    cost: gauge(billed.fixed + billed.autoscaling + billed.migration, wave.budget),
    complexity: gauge(complexity, wave.complexityCap),
    failureRate: gauge(failureRate, wave.sla.maxFailureRate),
    latency: binding.g,
  };
  const losses = lossesFor(gauges, billed, verdicts);
  const breaches = verdicts.flatMap((v) => (v.breachTick !== undefined ? [v.breachTick] : []));
  const latencyBreach = breaches.length > 0 ? Math.min(...breaches) : undefined;
  const byKind = latencyGauges.filter((x) => x.v.objective.kind !== undefined);

  return {
    won: losses.length === 0,
    lossReasons: lossMessages(losses),
    losses,
    bill: billed,
    avgLatencyMs: avgLatency,
    gauges,
    ...(byKind.length > 0 ? { latencyByKind: Object.fromEntries(byKind.map((x) => [x.v.objective.kind!, x.g])) } : {}),
    offered: offeredTotal,
    failed,
    failuresByReason: failures,
    shed: shed.value,
    ...(fanOut > 0 ? { delivery: { expected: asyncInjected * fanOut, delivered: asyncTally.delivered } } : {}),
    nodes: Object.fromEntries(summaries),
    ticks,
    events,
    ...(latencyBreach !== undefined ? { latencyBreachTick: latencyBreach } : {}),
  };
}

/** Le trafic neuf du tick, plus les relances prévues pour lui (S19). */
function inject(wave: Wave, retries: RetryPlan, tick: number, factor: number): { injected: Flow; retried: number } {
  const injected: Flow = new Map();
  let retried = 0;
  for (const src of wave.sources) {
    // Une relance refait la même requête, du même type, avec son événement (M10).
    const again = retriesAt(retries, src.id, tick);
    retried += sumKinds(again);
    for (const kind of REQUEST_KINDS) {
      addStream(injected, { kind, source: src.id, batch: 1, rps: (src.rps[kind] ?? 0) * factor + again[kind] });
    }
  }
  return { injected, retried };
}

/**
 * Âge du plus vieux message d'une file, en ticks (M13). La file est servie dans l'ordre :
 * ce qui en est sorti, c'est le début de ses arrivées cumulées. Le plus vieux message encore
 * là est donc arrivé au premier tick où les arrivées cumulées dépassent les sorties.
 */
function oldestAge(arrivals: Map<string, number[]>, id: string, tick: number, arrived: number, waiting: number): number {
  const cumulative = arrivals.get(id) ?? [];
  cumulative[tick] = (cumulative[tick - 1] ?? 0) + arrived;
  arrivals.set(id, cumulative);
  // Moins d'un message : la file est vide, à l'arrondi près.
  if (waiting < 1) return 0;
  const left = cumulative[tick]! - waiting;
  const first = cumulative.findIndex((a) => a > left + 1e-9);
  return first < 0 ? 0 : tick - first;
}

function nodeTickOf(w: World, now: Now, node: ArchNode, def: ComponentDef, incoming: Flow, outcome: NodeOutcome, backlogAge?: number): NodeTick {
  const id = node.id;
  const { ledger, incidents, open } = now;
  const down = incidents.down(node.type);
  const ups = w.upgrades.get(id)!;
  return {
    rps: sumRps(incoming),
    utilization: outcome.utilization,
    // Un composant sans instance en service ne fait pas la queue : il dit non, ou se tait (M12).
    latencyMs: isDown(w, incidents, id) ? latencyOf(w, incidents, id) : loadedLatency(latencyOf(w, incidents, id), outcome.utilization),
    failed: ledger.nodeFailed.get(id) ?? 0,
    ...(w.backlogs.has(id) ? { backlog: sumRps(w.backlogs.get(id)!) } : {}),
    ...(backlogAge ? { backlogAge } : {}),
    ...(w.deadLetters.get(id) ? { deadLetters: w.deadLetters.get(id)! } : {}),
    ...(outcome.instances !== undefined ? { instances: outcome.instances } : {}),
    ...(outcome.starting ? { starting: outcome.starting } : {}),
    ...(ledger.nodeShed.has(id) ? { shed: ledger.nodeShed.get(id)! } : {}),
    // Une dépendance fermée a toutes ses instances hors service, pas une infinité ; celles de
    // l'autoscaling tombent aussi (M2).
    ...(down > 0 ? { down: Math.min(down, instancesOf(ups) + (w.autoscalers.get(id)?.active ?? 0)) } : {}),
    ...nonZero(ledger.nodeTally.get(id)),
    ...(outcome.threads !== undefined ? { threads: outcome.threads } : {}),
    ...(outcome.blockedBy ? { waitingOn: outcome.blockedBy } : {}),
    ...(open.has(id) ? { open: [...open.get(id)!] } : {}),
    ...(def.behavior === 'database' && hasEffect(ups, 'readReplicas') && incidents.partitioned(node.type) ? { partitioned: true } : {}),
  };
}
