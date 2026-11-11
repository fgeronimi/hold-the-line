import { addStream, filterFlow, work, type Flow, type Stream } from '../flow.ts';
import { fail, tally } from '../ledger.ts';
import { timedOut } from '../retries.ts';
import type { ArchNode, ComponentDef } from '../types.ts';
import { hasEffect, withEffect } from '../upgrades.ts';
import { instancesNow, type Now, type World } from '../world.ts';
import { allForwarded, failAll, ratio, serveWithin, type NodeOutcome } from './common.ts';

export function processDatabase(node: ArchNode, def: ComponentDef, incoming: Flow, w: World, now: Now): NodeOutcome {
  const ctx = now.ledger;
  const ups = w.upgrades.get(node.id)!;
  const primary = def.capacity * instancesNow(w, now.incidents, node);
  let replicaCapacity = 0;
  for (const { effect, level } of withEffect(ups, 'readReplicas')) replicaCapacity += effect.capacityPerReplica * level;

  // Tout ce qui n'est pas une lecture passe par le primaire ; les lectures prennent
  // la capacité qu'il lui reste, plus celle des réplicas.
  const isRead = (s: Stream) => s.kind === 'read';
  const notRead = (s: Stream) => !isRead(s);
  const writeFlow = filterFlow(incoming, notRead);
  const readFlow = filterFlow(incoming, isRead);

  const writeDemand = work(writeFlow, def);
  const servedWrites = serveWithin(node.id, writeFlow, timedOut(writeDemand, primary, w.timeouts), primary, ctx);
  const primaryLeft = Math.max(0, primary - Math.min(writeDemand, primary));

  const readDemand = work(readFlow, def);
  const readCapacity = primaryLeft + replicaCapacity;
  const consistent = (s: Stream) => !!w.sourcesById.get(s.source)?.consistent;
  const leaderReads = hasEffect(ups, 'leaderReads');
  const passed: Flow = new Map();
  for (const s of servedWrites.values()) addStream(passed, s);

  if (leaderReads && replicaCapacity > 0) {
    // Les lectures qui doivent être à jour prennent le primaire d'abord ; les autres se
    // partagent ce qui reste et les réplicas.
    const critical = filterFlow(readFlow, consistent);
    const others = filterFlow(readFlow, (s) => !consistent(s));
    const criticalDemand = work(critical, def);
    for (const s of serveWithin(node.id, critical, timedOut(criticalDemand, primaryLeft, w.timeouts), primaryLeft, ctx).values()) addStream(passed, s);
    const left = Math.max(0, primaryLeft - Math.min(criticalDemand, primaryLeft)) + replicaCapacity;
    const served = left > 0 ? serveWithin(node.id, others, timedOut(work(others, def), left, w.timeouts), left, ctx) : failAll(node.id, others, ctx);
    for (const s of served.values()) addStream(passed, s);
  } else {
    const servedReads =
      readCapacity > 0
        ? serveWithin(node.id, readFlow, timedOut(readDemand, readCapacity, w.timeouts), readCapacity, ctx)
        : failAll(node.id, readFlow, ctx);
    // Les lectures se répartissent selon la capacité : la part servie par des réplicas
    // coupés du primaire est périmée, un échec pour qui exige une donnée à jour.
    const staleShare = now.incidents.partitioned(node.type) && readCapacity > 0 ? replicaCapacity / readCapacity : 0;
    for (const s of servedReads.values()) {
      const stale = consistent(s) ? s.rps * staleShare : 0;
      if (stale > 0) {
        fail(ctx, node.id, 'stale-read', stale);
        tally(ctx, node.id, 'stale', stale);
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
