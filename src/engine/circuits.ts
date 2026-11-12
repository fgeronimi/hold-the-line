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

/**
 * Délais d'attente du tick (M12) : pour chaque serveur qui en a un, les dépendances directes
 * qui ne répondront pas à temps. Un circuit déjà ouvert passe avant : il coupe sans attendre.
 */
export function callTimeouts(w: World, incidents: IncidentState, open: Map<string, Set<string>>): Map<string, { ms: number; cut: Set<string> }> {
  const timeouts = new Map<string, { ms: number; cut: Set<string> }>();
  for (const node of w.nodes.values()) {
    const ms = activeEffect(w.upgrades.get(node.id)!, 'callTimeout')?.timeoutMs;
    if (ms === undefined) continue;
    const targets = new Set(REQUEST_KINDS.flatMap((k) => w.routes.get(node.id)!.forward[k]));
    const cut = [...targets].filter((t) => !open.get(node.id)?.has(t) && latencyOf(w, incidents, t) > ms);
    timeouts.set(node.id, { ms, cut: new Set(cut) });
  }
  return timeouts;
}

/**
 * Ce qu'un appel direct de ce type fait attendre en aval : le temps d'occupation d'un fil.
 * Un circuit coupé ne fait rien attendre. Une dépendance tombée fait attendre ce qu'elle met à
 * dire non : peu si ses instances refusent, jusqu'au délai du client si elle se tait (M12),
 * borné par le délai d'attente du serveur s'il en a un.
 */
export function syncWait(w: World, now: Now, id: string, kind: RequestKind): { ms: number; dependency?: string } {
  let worst: { ms: number; dependency?: string } = { ms: 0 };
  const cap = now.timeouts.get(id)?.ms ?? Infinity;
  for (const t of w.routes.get(id)!.forward[kind]) {
    if (now.open.get(id)?.has(t)) continue;
    const ms = Math.min(latencyOf(w, now.incidents, t), cap);
    if (ms > worst.ms) worst = { ms, dependency: t };
  }
  return worst;
}
