import { addStream, isEvent, isPoisoned, sumRps, type Flow, type Stream } from '../flow.ts';
import { fail, tally } from '../ledger.ts';
import { consumersOf } from '../route.ts';
import { REQUEST_KINDS, type ArchNode, type ComponentDef, type RequestKind } from '../types.ts';
import { activeEffect, withEffect } from '../upgrades.ts';
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
  const poison = Math.min(1, now.incidents.share(node.type, 'poison-message'));
  for (const s of accepted.values()) {
    const bad = isEvent(s) ? s.rps * poison : 0;
    addStream(backlog, stored({ ...s, rps: s.rps - bad }, 1));
    if (bad > 0) addStream(backlog, stored({ ...s, rps: bad, poisoned: 0 }, 1));
  }

  const batch = def.batchSize ?? 1;
  const passed: Flow = new Map();
  for (const kind of REQUEST_KINDS) {
    // La file sert dans l'ordre : tant qu'un message empoisonné revient en tête, son
    // consommateur plante dessus et rien de ce qui attend derrière ne part (S25).
    const blocked = [...backlog.values()].some((s) => s.kind === kind && isPoisoned(s));
    const releasable = (s: Stream) => s.kind === kind && (!blocked || isPoisoned(s));
    const pending = sumRps(backlog, releasable);
    if (pending === 0) continue;
    const drain = Math.min(pending, drainCapacity(node.id, kind, batch, w, now));
    const share = drain / pending;
    for (const s of [...backlog.values()].filter(releasable)) {
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
  return {
    kind: s.kind,
    source: s.source,
    batch: s.batch / batch,
    rps: s.rps,
    ...(s.duplicate ? { duplicate: true } : {}),
    ...(isPoisoned(s) ? { poisoned: s.poisoned } : {}),
  };
}

/**
 * Une file qui garde un message empoisonné sans file des lettres mortes ne relâchera plus
 * jamais rien (S25) : ce qui y attend n'arrivera pas, comme dans une file sans consommateur.
 */
export function blockedForGood(w: World, id: string): boolean {
  const backlog = w.backlogs.get(id);
  if (!backlog || activeEffect(w.upgrades.get(id)!, 'deadLetter')) return false;
  return [...backlog.values()].some((s) => isPoisoned(s) && s.rps > 1e-9);
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
    const deadLetter = activeEffect(w.upgrades.get(id)!, 'deadLetter');
    for (const s of w.requeued.get(id)?.values() ?? []) {
      tally(ctx, id, 'requeued', s.rps);
      // Après `maxReceives` essais ratés, le message est mis de côté : il ne bloque plus la file,
      // mais son travail n'est pas fait.
      if (deadLetter && isPoisoned(s) && s.poisoned! >= deadLetter.maxReceives) {
        fail(ctx, id, 'dead-lettered', s.rps, isEvent(s) ? s.rps : 0);
        tally(ctx, id, 'deadLettered', s.rps);
        w.deadLetters.set(id, (w.deadLetters.get(id) ?? 0) + s.rps);
        continue;
      }
      addStream(backlog, stored(s, def.batchSize ?? 1));
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
