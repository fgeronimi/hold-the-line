import { addStream, sumRps, work, type Flow, type Stream } from '../flow.ts';
import { fail } from '../ledger.ts';
import type { ArchNode, ComponentDef } from '../types.ts';
import { instancesNow, type Now, type World } from '../world.ts';
import { allForwarded, ratio, serveWithin, type NodeOutcome } from './common.ts';

/**
 * Bordure (CDN) : sert une part des lectures sans les transmettre. Les tâches async
 * déclenchées par ces lectures-là n'ont jamais lieu, puisque le serveur ne les voit pas.
 */
export function processEdge(node: ArchNode, def: ComponentDef, incoming: Flow, w: World, now: Now): NodeOutcome {
  const capacity = def.capacity * instancesNow(w, now.incidents, node);
  const demand = work(incoming, def);
  const served = serveWithin(node.id, incoming, demand, capacity, now.ledger);
  const passed: Flow = new Map();
  for (const s of served.values()) {
    const hitRate = hitRateFor(s, def, w, now);
    if (s.kind === 'read') {
      addStream(passed, { ...s, rps: s.rps * (1 - hitRate) });
    } else if (s.kind === 'async') {
      fail(now.ledger, node.id, 'lost-at-edge', s.rps * hitRate, s.duplicate ? 0 : s.rps * hitRate);
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

/** Part des lectures servies qui continue vers l'aval, longue traîne comprise. */
function readShare(served: Flow, passed: Flow): number {
  const isRead = (s: Stream) => s.kind === 'read';
  const before = sumRps(served, isRead);
  return before > 0 ? sumRps(passed, isRead) / before : 0;
}

function hitRateFor(s: Stream, def: ComponentDef, w: World, now: Now): number {
  return w.sourcesById.get(s.source)?.longTail ? 0 : (def.hitRate ?? 0) * now.incidents.hitFactor(def.id);
}
