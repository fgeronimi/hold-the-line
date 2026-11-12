import { addStream, isEvent, sumRps, type Flow, type Stream } from '../flow.ts';
import { fail, tally } from '../ledger.ts';
import { consumersOf } from '../route.ts';
import { REQUEST_KINDS, type ArchNode, type ComponentDef, type RequestKind } from '../types.ts';
import { withEffect } from '../upgrades.ts';
import { defOf, instancesNow, type Now, type World } from '../world.ts';
import { ratio, serveShared, type NodeOutcome } from './common.ts';

/**
 * Une file accepte vite, stocke, puis relâche au rythme que ses consommateurs
 * peuvent absorber. Ce qui sort est découplé : l'amont n'attend pas l'aval.
 */
export function processQueue(node: ArchNode, def: ComponentDef, incoming: Flow, w: World, now: Now): NodeOutcome {
  const capacity = def.capacity * instancesNow(w, now.incidents, node);
  const { passed: accepted, demand } = serveShared(node.id, incoming, def, capacity, w, now.ledger);

  // Un message accepté ici est acquitté par la file d'où il venait : il n'appartient plus qu'à celle-ci.
  const backlog = w.backlogs.get(node.id) ?? new Map<string, Stream>();
  for (const s of accepted.values()) addStream(backlog, stored(s, 1));

  const batch = def.batchSize ?? 1;
  const passed: Flow = new Map();
  for (const kind of REQUEST_KINDS) {
    const pending = sumRps(backlog, (s) => s.kind === kind);
    if (pending === 0) continue;
    const drain = Math.min(pending, drainCapacity(node.id, kind, batch, w, now));
    const share = drain / pending;
    for (const s of [...backlog.values()].filter((x) => x.kind === kind)) {
      const out = s.rps * share;
      addStream(passed, { ...s, batch: s.batch * batch, rps: out, queue: node.id });
      s.rps -= out;
    }
  }
  w.backlogs.set(node.id, backlog);

  return {
    passed,
    utilization: ratio(demand, capacity),
  };
}

/** Le message tel que la file le garde : sans marque d'origine, avant son regroupement en lots. */
function stored(s: Stream, batch: number): Stream {
  return { kind: s.kind, source: s.source, batch: s.batch / batch, rps: s.rps, ...(s.duplicate ? { duplicate: true } : {}) };
}

/**
 * Fin du tick, une fois l'aval passé : ce qu'il n'a pas pu traiter revient dans la file
 * (M1), puis la file déborde si son arriéré, retours compris, dépasse ce qu'elle garde.
 * Un message rendu compte comme les autres : la file qui ne se vide pas assez vite déborde.
 */
export function settleQueues(w: World, now: Now): void {
  const ctx = now.ledger;
  for (const [id, backlog] of w.backlogs) {
    const def = defOf(w, id);
    for (const s of w.requeued.get(id)?.values() ?? []) {
      addStream(backlog, stored(s, def.batchSize ?? 1));
      tally(ctx, id, 'requeued', s.rps);
    }

    let maxBacklog = def.maxBacklog ?? Infinity;
    for (const { effect, level } of withEffect(w.upgrades.get(id)!, 'retention')) maxBacklog += effect.perLevel * level;
    const waiting = sumRps(backlog);
    if (waiting > maxBacklog) {
      const lost = waiting - maxBacklog;
      fail(ctx, id, 'queue-overflow', lost, (lost * sumRps(backlog, isEvent)) / waiting);
      ctx.events.push({ type: 'queue-overflow', tick: ctx.tick, node: id, lostRps: lost });
      for (const s of backlog.values()) s.rps *= maxBacklog / waiting;
    }
    for (const [k, s] of backlog) if (s.rps <= 1e-9) backlog.delete(k);
  }
  w.requeued.clear();
}

/** Messages par seconde que les consommateurs d'une file peuvent absorber pour ce type. */
function drainCapacity(queueId: string, kind: RequestKind, batch: number, w: World, now: Now): number {
  let total = 0;
  for (const c of consumersOf(w.routes.get(queueId)!)) {
    if (!c.kinds.includes(kind)) continue;
    const def = defOf(w, c.id);
    const perBatch = def.workPerRequest[kind] ?? 0;
    const instances = instancesNow(w, now.incidents, w.nodes.get(c.id)!);
    const quota = def.maxRps !== undefined ? def.maxRps * instances : Infinity;
    if (perBatch === 0) {
      if (quota === Infinity) return Infinity;
      total += quota;
      continue;
    }
    total += Math.min(((def.capacity * instances) / perBatch) * batch, quota);
  }
  return total;
}
