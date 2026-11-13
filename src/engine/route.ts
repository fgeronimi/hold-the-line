import { addStream, classOf, isEvent, type Flow, type Stream } from './flow.ts';
import { fail, failStream, lose, tally } from './ledger.ts';
import type { NodeRoutes, RouteTable } from './routing.ts';
import { REQUEST_KINDS, type ArchNode, type Catalog, type ComponentDef, type RequestKind, type TickMetrics } from './types.ts';
import { activeEffect, hasEffect, type NodeUpgrades } from './upgrades.ts';
import { defOf, type Now, type World } from './world.ts';

/** Débit envoyé par nœud, par type et par voisin pendant le tick : pondère les latences. */
export type Routed = Map<string, Map<RequestKind, Map<string, number>>>;

/** Ce que le routage d'un tick remplit : l'entrée de chaque nœud, et ce qui a circulé. */
export interface Delivery {
  inbound: Map<string, Flow>;
  routed: Routed;
  /** Appels abandonnés par un délai d'attente, par nœud, type et dépendance : ils ont attendu (M12). */
  waited: Routed;
  /**
   * Requêtes du client envoyées par nœud, par classe (`classOf`) et par voisin : les chemins
   * dont la latence se mesure, avec leur débit (M4).
   */
  classes: Map<string, Map<string, Map<string, number>>>;
  /** Requêtes du client abandonnées par le délai d'attente de chaque nœud, par classe : elles ont attendu (M4, M12). */
  classWaited: Map<string, Map<string, number>>;
  /** Chaque nœud et type sans route n'est signalé qu'une fois par vague. */
  reportedNoRoute: Set<string>;
}

/** Ce qu'un nœud fait des événements async : les publier, les consommer, avec quelles protections. */
export interface MessagingRoles {
  /** Serveur qui publie vers une file ou un pub/sub : exposé à la perte à la publication. */
  publisher: boolean;
  /** Base à outbox où ce serveur écrit : ses événements passent par elle et ne se perdent plus. */
  outbox?: string;
  /** Service consommateur idempotent : il écarte les doublons, avec sa propre mémoire des clés. */
  idempotent: boolean;
  /** Bases où ce nœud écrit : l'outbox est cherchée parmi elles. */
  writeTargets: string[];
}

export function messagingRoles(
  node: ArchNode,
  nodes: Map<string, ArchNode>,
  catalog: Catalog,
  routes: RouteTable,
  upgrades: Map<string, NodeUpgrades>,
): MessagingRoles {
  const own = routes.get(node.id)!;
  const behaviorOf = (id: string) => catalog.components[nodes.get(id)?.type ?? '']?.behavior;
  const has = (id: string, effect: 'outbox' | 'idempotence') => {
    const ups = upgrades.get(id);
    return !!ups && hasEffect(ups, effect);
  };
  const service = catalog.components[node.type]?.behavior === 'service';
  const writeTargets = own.forward.write.filter((id) => behaviorOf(id) === 'database');
  const outbox = writeTargets.find((id) => has(id, 'outbox'));
  return {
    publisher: service && own.forward.async.some((id) => behaviorOf(id) === 'queue' || behaviorOf(id) === 'pubsub'),
    ...(outbox ? { outbox } : {}),
    idempotent: service && has(node.id, 'idempotence'),
    writeTargets,
  };
}

/** Voisins transmis d'un nœud, avec les types que le routage leur envoie. */
export function consumersOf(routes: NodeRoutes): { id: string; kinds: RequestKind[] }[] {
  const byId = new Map<string, RequestKind[]>();
  for (const kind of REQUEST_KINDS) {
    for (const id of routes.forward[kind]) byId.set(id, [...(byId.get(id) ?? []), kind]);
  }
  return [...byId].map(([id, kinds]) => ({ id, kinds }));
}

export function linkTraffic(routed: Routed): TickMetrics['links'] {
  const links: TickMetrics['links'] = {};
  for (const [from, byKind] of routed) {
    for (const [kind, byTo] of byKind) {
      for (const [to, rps] of byTo) (links[`${from}→${to}`] ??= {})[kind] = rps;
    }
  }
  return links;
}

// Une donnée qui doit être à jour ne se lit pas en cache.
function hitRateAt(w: World, now: Now, cacheId: string, s: Stream): number {
  const src = w.sourcesById.get(s.source);
  return src?.longTail || src?.consistent ? 0 : (defOf(w, cacheId).hitRate ?? 0) * now.incidents.hitFactor(w.nodes.get(cacheId)!.type);
}

/**
 * Ce que pèse une absence en base pendant une ruée : recalculée `herd` fois sans verrou ; avec
 * un verrou de recalcul, une seule fois par page, et les lecteurs d'une même page attendent ce
 * recalcul, si bien que la base ne voit que la part distincte des absences. Hors ruée, 1.
 */
function missWorkAt(w: World, now: Now, cacheId: string): number {
  const herd = now.incidents.herd(w.nodes.get(cacheId)!.type);
  if (herd <= 1) return 1;
  return activeEffect(w.upgrades.get(cacheId)!, 'coalescing')?.distinctShare ?? herd;
}

export function route(id: string, def: ComponentDef, passed: Flow, w: World, now: Now, out: Delivery): void {
  const ctx = now.ledger;
  const routes = w.routes.get(id)!;
  const roles = w.roles.get(id)!;
  const type = w.nodes.get(id)!.type;
  /** Service qui doit recevoir chaque événement : ce qui lui parvient compte comme livré. */
  const consumer = w.consumers.has(id);
  /** Dépendances coupées par le circuit breaker de ce nœud : leurs appels échouent tout de suite. */
  const open = now.open.get(id);
  const cut = now.timeouts.get(id)?.cut;
  const send = (to: string, s: Stream, rps: number) => {
    if (rps <= 0) return;
    addStream(out.inbound.get(to)!, { ...s, rps });
    const byKind = out.routed.get(id) ?? new Map<RequestKind, Map<string, number>>();
    const byTo = byKind.get(s.kind) ?? new Map<string, number>();
    byTo.set(to, (byTo.get(to) ?? 0) + rps);
    byKind.set(s.kind, byTo);
    out.routed.set(id, byKind);
    const cls = classOf(s);
    if (cls === undefined) return;
    const byClass = out.classes.get(id) ?? new Map<string, Map<string, number>>();
    const sent = byClass.get(cls) ?? new Map<string, number>();
    sent.set(to, (sent.get(to) ?? 0) + rps);
    byClass.set(cls, sent);
    out.classes.set(id, byClass);
  };

  for (const original of passed.values()) {
    let s = original;
    if (consumer && isEvent(s)) ctx.asyncTally.delivered += s.rps;

    if (s.kind === 'async' && def.behavior === 'service') {
      if (s.duplicate) {
        // Un doublon reconnu est écarté ; sinon il est traité une seconde fois, et c'est l'erreur.
        // La clé déjà vue est gardée par le service lui-même : pas de base partagée (S10).
        if (roles.idempotent) {
          tally(ctx, id, 'deduplicated', s.rps);
          continue;
        }
        tally(ctx, id, 'duplicates', s.rps);
        fail(ctx, id, 'duplicate', s.rps);
        continue;
      }
      if (!def.terminalFor.includes(s.kind)) {
        if (roles.publisher && roles.outbox) {
          send(roles.outbox, { ...s, kind: 'write', internal: true }, s.rps);
        } else if (roles.publisher) {
          const lost = s.rps * Math.min(1, now.incidents.share(type, 'publish-loss'));
          if (lost > 0) {
            tally(ctx, id, 'lost', lost);
            fail(ctx, id, 'lost-event', lost, lost);
            lose(ctx, id, s, lost);
            s = { ...s, rps: s.rps - lost };
          }
        }
      }
    }
    if (def.terminalFor.includes(s.kind)) continue;

    // Cache-aside : chaque cache consulté sert sa part, le reste repart d'ici.
    let remaining = s.rps;
    const lookups = routes.lookup[s.kind];
    // Le pire des caches consultés : une ruée sans verrou sur l'un l'emporte sur le verrou d'un autre.
    const missWork = lookups.length > 0 ? Math.max(...lookups.map((c) => missWorkAt(w, now, c))) : 1;
    for (const cache of lookups) {
      const consulted = s.rps / lookups.length;
      const hits = consulted * hitRateAt(w, now, cache, s);
      send(cache, s, hits);
      remaining -= hits;
    }
    // Une ruée recalcule chaque absence plusieurs fois, un verrou une seule fois par page : la
    // base fait `missWork` fois le travail, mais chaque client n'attend qu'une réponse (le lot
    // divise le travail, comme celui d'une file, et les échecs se comptent toujours en requêtes).
    if (missWork !== 1) s = { ...s, batch: s.batch / missWork };

    const targets = routes.forward[s.kind];
    if (targets.length === 0) {
      failStream(ctx, id, 'no-route', s, remaining);
      const key = `${id}|${s.kind}`;
      if (remaining > 0 && !out.reportedNoRoute.has(key)) {
        out.reportedNoRoute.add(key);
        ctx.events.push({ type: 'no-route', tick: ctx.tick, node: id, kind: s.kind });
      }
      continue;
    }
    // Une file partage les messages entre ses voisins ; un pub/sub les copie à chacun.
    const each = def.fanOut ? remaining : remaining / targets.length;
    const duplicated = s.kind === 'async' && !s.duplicate ? Math.min(1, now.incidents.share(type, 'duplicate-delivery')) : 0;
    for (const to of targets) {
      if (open?.has(to)) {
        failStream(ctx, id, 'circuit-open', s, each);
        continue;
      }
      // Le délai d'attente abandonne l'appel : il a attendu, puis échoue chez l'appelant (M12).
      if (cut?.has(to)) {
        failStream(ctx, id, 'timed-out', s, each);
        const byKind = out.waited.get(id) ?? new Map<RequestKind, Map<string, number>>();
        const byTo = byKind.get(s.kind) ?? new Map<string, number>();
        byTo.set(to, (byTo.get(to) ?? 0) + each);
        byKind.set(s.kind, byTo);
        out.waited.set(id, byKind);
        const cls = classOf(s);
        if (cls !== undefined && each > 0) {
          const byClass = out.classWaited.get(id) ?? new Map<string, number>();
          byClass.set(cls, (byClass.get(cls) ?? 0) + each);
          out.classWaited.set(id, byClass);
        }
        continue;
      }
      send(to, s, each);
      if (duplicated > 0) send(to, { ...s, duplicate: true }, each * duplicated);
    }
  }
}
