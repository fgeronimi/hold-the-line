import { addStream, type Flow } from '../flow.ts';
import { fail } from '../ledger.ts';
import { SYNC_KINDS, type ArchNode, type ComponentDef } from '../types.ts';
import { withEffect } from '../upgrades.ts';
import { instancesNow, type Now, type World } from '../world.ts';
import { allForwarded, ratio, serveShared, type NodeOutcome } from './common.ts';

export function processBalancer(node: ArchNode, def: ComponentDef, incoming: Flow, w: World, now: Now): NodeOutcome {
  let flow = incoming;
  for (const { effect, level } of withEffect(w.upgrades.get(node.id)!, 'rateLimit')) {
    const limit = effect.tiersPerClientRps[level - 1];
    if (limit === undefined) continue;
    flow = applyRateLimit(node.id, flow, limit, w, now);
  }
  const capacity = def.capacity * instancesNow(w, now.incidents, node);
  const { passed, demand } = serveShared(node.id, flow, def, capacity, w, now.ledger);
  return {
    passed,
    utilization: ratio(demand, capacity),
    syncForwardShare: allForwarded(),
  };
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
    const rejected = rps - allowed;
    keepShare.set(sourceId, allowed / rps);
    if (src?.abusive) {
      ctx.shed.value += rejected;
      ctx.nodeShed.set(nodeId, (ctx.nodeShed.get(nodeId) ?? 0) + rejected);
    }
    else fail(ctx, nodeId, 'rate-limited', rejected);
    ctx.events.push({ type: 'rate-limited', tick: ctx.tick, node: nodeId, source: sourceId, rejectedRps: rejected });
  }
  for (const s of flow.values()) {
    const keep = keepShare.get(s.source) ?? 1;
    addStream(out, { ...s, rps: s.rps * keep });
    // L'async suit le sort de sa requête (C5) : écarté avec un abusif, en échec avec un client légitime.
    const lost = SYNC_KINDS.includes(s.kind) ? 0 : s.rps * (1 - keep);
    if (lost <= 0) continue;
    if (w.sourcesById.get(s.source)?.abusive) {
      ctx.shed.value += lost;
      ctx.nodeShed.set(nodeId, (ctx.nodeShed.get(nodeId) ?? 0) + lost);
    } else fail(ctx, nodeId, 'rate-limited', lost, s.duplicate ? 0 : lost);
  }
  return out;
}
