import { addStream, type Flow, type Stream } from '../flow.ts';
import { fail, lose } from '../ledger.ts';
import type { ArchNode, ComponentDef } from '../types.ts';
import { instancesNow, type Now, type World } from '../world.ts';
import { ratio, serveShared, type NodeOutcome } from './common.ts';

/**
 * Bordure (CDN) : sert une part des lectures sans les transmettre. Les tâches async
 * déclenchées par ces lectures-là n'ont jamais lieu, puisque le serveur ne les voit pas.
 */
export function processEdge(node: ArchNode, def: ComponentDef, incoming: Flow, w: World, now: Now): NodeOutcome {
  const capacity = def.capacity * instancesNow(w, now.incidents, node);
  const { passed: served, demand } = serveShared(node.id, incoming, def, capacity, w, now.ledger);
  const passed: Flow = new Map();
  for (const s of served.values()) {
    const hitRate = hitRateFor(s, def, w, now);
    if (s.kind === 'read') {
      addStream(passed, { ...s, rps: s.rps * (1 - hitRate) });
    } else if (s.kind === 'async') {
      fail(now.ledger, node.id, 'lost-at-edge', s.rps * hitRate, s.duplicate ? 0 : s.rps * hitRate);
      lose(now.ledger, node.id, s, s.rps * hitRate);
      addStream(passed, { ...s, rps: s.rps * (1 - hitRate) });
    } else {
      addStream(passed, s);
    }
  }
  return {
    passed,
    utilization: ratio(demand, capacity),
  };
}

// La bordure ne garde ni la longue traîne, ni une donnée qui doit être à jour (S21), ni les
// réponses d'une API non cachable (SC1).
function hitRateFor(s: Stream, def: ComponentDef, w: World, now: Now): number {
  const src = w.sourcesById.get(s.source);
  return src?.longTail || src?.consistent || src?.noEdgeCache ? 0 : (def.hitRate ?? 0) * now.incidents.hitFactor(def.id);
}
