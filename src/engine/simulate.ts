import { migrationCost, totals } from './budget.ts';
import { openCircuits } from './circuits.ts';
import { addStream, isEvent, sumRps, type Flow } from './flow.ts';
import { activeAt, incidentState } from './incidents.ts';
import { breachTick, loadedLatency, P95, percentile, tickLatency } from './latency.ts';
import { noFailures, nonZero, sumFailures, type Ledger } from './ledger.ts';
import { lossMessages } from './messages.ts';
import { factorAt } from './profile.ts';
import { processNode, type NodeOutcome } from './nodes/index.ts';
import { planRetries, retryPlan, syncOf, type RetryPlan } from './retries.ts';
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
import { REQUEST_KINDS, SYNC_KINDS } from './types.ts';
import { hasEffect, instancesOf, resolveUpgrades } from './upgrades.ts';
import { validateArchitecture } from './validate.ts';
import { gauge, invalidResult, lossesFor } from './verdict.ts';
import { defOf, latencyOf, type Now, type World } from './world.ts';

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
    timeouts: retries.retrying.length > 0,
    backlogs: new Map(),
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
  let syncWeightedLatency = 0;
  let syncOffered = 0;
  let countedSoFar = 0;
  let clientFailedSoFar = 0;
  let active: Incident[] = [];

  for (let tick = 0; tick < wave.ticks; tick++) {
    const factor = factorAt(wave, tick);
    const was = new Set(active.map((i) => i.id));
    active = activeAt(wave.incidents, tick);
    for (const i of active) if (!was.has(i.id)) events.push({ type: 'incident-start', tick, incident: i.id });
    for (const id of was) if (!active.some((i) => i.id === id)) events.push({ type: 'incident-end', tick, incident: id });
    const ledger: Ledger = { tick, failures, nodeFailed: new Map(), nodeShed: new Map(), nodeTally: new Map(), events, shed, asyncTally };
    const failedBefore = sumFailures(failures);

    const { injected, retried } = inject(wave, retries, tick, factor);
    const asyncFailedBefore = asyncTally.failed;
    const staleBefore = failures['stale-read'];
    const delivery: Delivery = {
      inbound: new Map<string, Flow>([...nodes.keys()].map((id) => [id, new Map()])),
      routed: new Map(),
      reportedNoRoute,
    };
    delivery.inbound.set(validation.sourceId, injected);
    asyncInjected += sumRps(injected, isEvent);
    const offered = sumRps(injected);
    offeredTotal += offered;

    const incidents = incidentState(active, tick);
    const now: Now = { ledger, incidents, open: openCircuits(w, incidents) };
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
      summary.failed += ledger.nodeFailed.get(id) ?? 0;

      nodeTicks[id] = nodeTickOf(w, now, node, def, incoming, outcome);
    }

    const latency = tickLatency(w, { order: validation.order, routes, routed: delivery.routed, outcomes, nodeTicks, open: now.open }, validation.sourceId, injected);
    syncWeightedLatency += latency.avg * latency.syncRps;
    syncOffered += latency.syncRps;

    // Ce qui manque aux abonnés attendus, une fois retirés les échecs déjà comptés et ce
    // qui attend encore en file : compté au fil des ticks, pour que le rejeu le montre.
    if (fanOut > 0) {
      // Seul ce qui attend dans une file vidée par un consommateur arrivera un jour.
      const waiting = [...w.backlogs]
        .filter(([id]) => routes.get(id)!.forward.async.length > 0)
        .reduce((a, [, b]) => a + sumRps(b, isEvent), 0);
      const missing = Math.max(0, asyncInjected * fanOut - asyncTally.delivered - asyncTally.failed - waiting);
      if (missing > undeliveredSoFar) failures.undelivered += missing - undeliveredSoFar;
      undeliveredSoFar = Math.max(undeliveredSoFar, missing);
    }

    if (retries.retrying.length > 0) {
      // Une lecture périmée n'est pas une erreur pour le client : il ne la relance pas.
      const syncFailed = Math.max(0, sumFailures(failures) - failedBefore - (asyncTally.failed - asyncFailedBefore) - (failures['stale-read'] - staleBefore));
      planRetries(retries, wave.ticks, tick, factor, syncFailed);
    }

    const failedNow = sumFailures(failures) - failedBefore;
    const shedNow = Object.values(nodeTicks).reduce((a, n) => a + (n.shed ?? 0), 0);
    ticks.push({
      tick,
      offered,
      failed: failedNow,
      // Déduites à l'injection, comme le rejeu les a toujours affichées (voir `TickMetrics`).
      countedSoFar: (countedSoFar += offered - shedNow - retried),
      clientFailedSoFar: (clientFailedSoFar += failedNow - retried),
      avgLatencyMs: latency.avg,
      slaLatencyMs: latency.sla,
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
  const failed = sumFailures(failures) - retries.total;
  const counted = offeredTotal - shed.value - retries.total;
  const failureRate = counted > 0 ? failed / counted : 0;
  const avgLatency = syncOffered > 0 ? syncWeightedLatency / syncOffered : 0;

  const slaLatencies = ticks.map((t) => t.slaLatencyMs);
  const gauges = {
    cost: gauge(billed.fixed + billed.autoscaling + billed.migration, wave.budget),
    complexity: gauge(complexity, wave.complexityCap),
    failureRate: gauge(failureRate, wave.sla.maxFailureRate),
    latency: gauge(percentile(slaLatencies, P95), wave.sla.maxP95LatencyMs),
  };
  const losses = lossesFor(gauges, billed);
  const latencyBreach = breachTick(slaLatencies, P95, wave.sla.maxP95LatencyMs);

  return {
    won: losses.length === 0,
    lossReasons: lossMessages(losses),
    losses,
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
    ...(latencyBreach !== undefined ? { latencyBreachTick: latencyBreach } : {}),
  };
}

/** Le trafic neuf du tick, plus les relances prévues pour lui (S19). */
function inject(wave: Wave, retries: RetryPlan, tick: number, factor: number): { injected: Flow; retried: number } {
  const injected: Flow = new Map();
  let retried = 0;
  for (const src of wave.sources) {
    // Une relance refait la même requête : elle suit la répartition lectures / écritures de sa source.
    const again = retries.at.get(src.id)?.[tick] ?? 0;
    retried += again;
    const sync = syncOf(src);
    for (const kind of REQUEST_KINDS) {
      const share = SYNC_KINDS.includes(kind) && sync > 0 ? (src.rps[kind] ?? 0) / sync : 0;
      addStream(injected, { kind, source: src.id, batch: 1, rps: (src.rps[kind] ?? 0) * factor + again * share });
    }
  }
  return { injected, retried };
}

function nodeTickOf(w: World, now: Now, node: ArchNode, def: ComponentDef, incoming: Flow, outcome: NodeOutcome): NodeTick {
  const id = node.id;
  const { ledger, incidents, open } = now;
  const down = incidents.down(node.type);
  const ups = w.upgrades.get(id)!;
  return {
    rps: sumRps(incoming),
    utilization: outcome.utilization,
    latencyMs: loadedLatency(latencyOf(w, incidents, id), outcome.utilization),
    failed: ledger.nodeFailed.get(id) ?? 0,
    ...(w.backlogs.has(id) ? { backlog: sumRps(w.backlogs.get(id)!) } : {}),
    ...(outcome.instances !== undefined ? { instances: outcome.instances } : {}),
    ...(outcome.starting ? { starting: outcome.starting } : {}),
    ...(ledger.nodeShed.has(id) ? { shed: ledger.nodeShed.get(id)! } : {}),
    // Une dépendance fermée a toutes ses instances hors service, pas une infinité.
    ...(down > 0 ? { down: Math.min(down, instancesOf(ups)) } : {}),
    ...nonZero(ledger.nodeTally.get(id)),
    ...(outcome.threads !== undefined ? { threads: outcome.threads } : {}),
    ...(outcome.blockedBy ? { waitingOn: outcome.blockedBy } : {}),
    ...(open.has(id) ? { open: [...open.get(id)!] } : {}),
    ...(def.behavior === 'database' && hasEffect(ups, 'readReplicas') && incidents.partitioned(node.type) ? { partitioned: true } : {}),
  };
}
