import type { IncidentState } from './incidents.ts';
import { REQUEST_KINDS, type RequestKind } from './types.ts';
import { activeEffect } from './upgrades.ts';
import { isDown, latencyOf, type Now, type World } from './world.ts';

/**
 * Circuits ouverts ce tick : les dépendances directes d'un serveur à disjoncteur qui
 * dépassent son délai, ou qui sont en panne.
 */
export function openCircuits(w: World, incidents: IncidentState): Map<string, Set<string>> {
  const open = new Map<string, Set<string>>();
  for (const node of w.nodes.values()) {
    const timeout = activeEffect(w.upgrades.get(node.id)!, 'circuitBreaker')?.timeoutMs;
    if (timeout === undefined) continue;
    const targets = new Set(REQUEST_KINDS.flatMap((k) => w.routes.get(node.id)!.forward[k]));
    const cut = [...targets].filter((t) => isDown(w, incidents, t) || latencyOf(w, incidents, t) > timeout);
    if (cut.length > 0) open.set(node.id, new Set(cut));
  }
  return open;
}

/** Ce qu'un appel direct de ce type attend en aval, hors circuits coupés et dépendances en panne (refus immédiat). */
export function syncWait(w: World, now: Now, id: string, kind: RequestKind): { ms: number; dependency?: string } {
  let worst: { ms: number; dependency?: string } = { ms: 0 };
  for (const t of w.routes.get(id)!.forward[kind]) {
    if (now.open.get(id)?.has(t) || isDown(w, now.incidents, t)) continue;
    const ms = latencyOf(w, now.incidents, t);
    if (ms > worst.ms) worst = { ms, dependency: t };
  }
  return worst;
}
