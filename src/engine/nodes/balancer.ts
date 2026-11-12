import { addStream, scaleFlow, work, type Flow } from '../flow.ts';
import { failFlow, failStream } from '../ledger.ts';
import { SYNC_KINDS, type ArchNode, type ComponentDef } from '../types.ts';
import { activeEffect, withEffect } from '../upgrades.ts';
import { defOf, instancesNow, type Now, type World } from '../world.ts';
import { allForwarded, ratio, serveShared, type NodeOutcome } from './common.ts';
import { servingInstances } from './service.ts';

export function processBalancer(node: ArchNode, def: ComponentDef, incoming: Flow, w: World, now: Now): NodeOutcome {
  let flow = incoming;
  for (const { effect, level } of withEffect(w.upgrades.get(node.id)!, 'rateLimit')) {
    const limit = effect.tiersPerClientRps[level - 1];
    if (limit === undefined) continue;
    flow = applyRateLimit(node.id, flow, limit, w, now);
  }
  const shedding = activeEffect(w.upgrades.get(node.id)!, 'loadShedding');
  const capacity = def.capacity * instancesNow(w, now.incidents, node);
  const { passed, demand } = serveShared(node.id, flow, def, capacity, w, now.ledger);
  return {
    passed: shedding ? shedExcess(node.id, passed, shedding.targetUtilization, w, now) : passed,
    utilization: ratio(demand, capacity),
    syncForwardShare: allForwarded(),
  };
}

/**
 * Délestage (M11) : ne laisser entrer que ce que les serveurs derrière la porte servent sans
 * dépasser leur charge cible, instances tombées déduites et instances à la demande prêtes
 * comprises. Laisser entrer leur pleine capacité les tiendrait à 100 %, où la latence
 * explose : un délesteur réel coupe avant, sur la latence ou la longueur d'attente. Le reste
 * est refusé tout de suite, en échec `load-shed` à la porte : le client le voit et le
 * relance, mais aucun serveur ne travaille plus pour une requête déjà abandonnée.
 */
function shedExcess(nodeId: string, flow: Flow, target: number, w: World, now: Now): Flow {
  const targets = [...new Set(SYNC_KINDS.flatMap((k) => w.routes.get(nodeId)!.forward[k]))].filter(
    (id) => defOf(w, id).behavior === 'service',
  );
  if (targets.length === 0) return flow;
  const def = defOf(w, targets[0]!);
  const capacity = target * targets.reduce((a, id) => a + defOf(w, id).capacity * servingInstances(w.nodes.get(id)!, w, now), 0);
  const demand = work(flow, def);
  if (demand <= capacity) return flow;
  const keep = capacity / demand;
  failFlow(now.ledger, nodeId, 'load-shed', flow, 1 - keep);
  return scaleFlow(flow, keep);
}

function applyRateLimit(nodeId: string, flow: Flow, limitPerClient: number, w: World, now: Now): Flow {
  const ctx = now.ledger;
  const out: Flow = new Map();
  // L'async est un effet de bord des requêtes (un clic compté par redirection), pas une
  // requête du client : il n'entame pas son quota mais suit le sort de sa requête.
  const perSource = new Map<string, number>();
  for (const s of flow.values()) {
    if (SYNC_KINDS.includes(s.kind)) perSource.set(s.source, (perSource.get(s.source) ?? 0) + s.rps);
  }

  const keepShare = new Map<string, number>();
  for (const [sourceId, rps] of perSource) {
    const src = w.sourcesById.get(sourceId);
    const allowed = limitPerClient * (src?.clients ?? 1);
    if (rps <= allowed) {
      keepShare.set(sourceId, 1);
      continue;
    }
    keepShare.set(sourceId, allowed / rps);
    ctx.events.push({ type: 'rate-limited', tick: ctx.tick, node: nodeId, source: sourceId, rejectedRps: rps - allowed });
  }
  for (const s of flow.values()) {
    const keep = keepShare.get(s.source) ?? 1;
    addStream(out, { ...s, rps: s.rps * keep });
    // L'async suit le sort de sa requête (C5) : écarté avec un abusif, en échec avec un client légitime.
    const lost = s.rps * (1 - keep);
    if (lost <= 0) continue;
    if (w.sourcesById.get(s.source)?.abusive) {
      ctx.shed.value += lost;
      ctx.nodeShed.set(nodeId, (ctx.nodeShed.get(nodeId) ?? 0) + lost);
    } else failStream(ctx, nodeId, 'rate-limited', s, lost);
  }
  return out;
}
