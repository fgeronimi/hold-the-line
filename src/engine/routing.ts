import type { Architecture, Catalog, RequestKind } from './types.ts';
import { REQUEST_KINDS } from './types.ts';

/** Pour chaque nœud et chaque type de requête, les nœuds vers lesquels il l'envoie. */
export type RouteTable = Map<string, Record<RequestKind, string[]>>;

/**
 * Les liens ne portent pas de type : le joueur relie des composants, le moteur en déduit
 * le chemin. Un type va vers les voisins qui l'acceptent, en préférant le plus spécialisé
 * (le cache pour les lectures, la file pour l'async) ; à égalité, il est réparti également.
 */
export function routeTable(arch: Architecture, catalog: Catalog): RouteTable {
  const typeOf = new Map(arch.nodes.map((n) => [n.id, n.type]));
  const table: RouteTable = new Map();
  for (const node of arch.nodes) {
    const neighbours = arch.links
      .filter((l) => l.from === node.id)
      .map((l) => ({ id: l.to, def: catalog.components[typeOf.get(l.to) ?? ''] }));
    const routes = {} as Record<RequestKind, string[]>;
    for (const kind of REQUEST_KINDS) {
      const accepting = neighbours.filter((n) => n.def?.accepts.includes(kind));
      const best = Math.max(...accepting.map((n) => n.def?.routingPriority ?? 0));
      routes[kind] = accepting.filter((n) => (n.def?.routingPriority ?? 0) === best).map((n) => n.id);
    }
    table.set(node.id, routes);
  }
  return table;
}

export type LinkFlows = Map<string, RequestKind[]>;

/**
 * Les types qui circulent réellement sur chaque lien (clé `from→to`) : un nœud ne
 * transmet que ce qu'il reçoit, et la source émet tout. Sert à l'affichage ; un cache
 * relié à la base n'y envoie donc que des lectures.
 */
export function linkFlows(arch: Architecture, catalog: Catalog, table = routeTable(arch, catalog)): LinkFlows {
  const typeOf = new Map(arch.nodes.map((n) => [n.id, n.type]));
  const received = new Map<string, Set<RequestKind>>(arch.nodes.map((n) => [n.id, new Set()]));
  for (const n of arch.nodes) {
    if (catalog.components[n.type]?.behavior === 'source') received.set(n.id, new Set(REQUEST_KINDS));
  }
  const flows: LinkFlows = new Map();
  // Point fixe : au plus un tour par nœud suffit sur un graphe sans cycle.
  for (let round = 0; round <= arch.nodes.length; round++) {
    let changed = false;
    for (const l of arch.links) {
      const terminal = catalog.components[typeOf.get(l.from) ?? '']?.terminalFor ?? [];
      const kinds = REQUEST_KINDS.filter(
        (k) => received.get(l.from)?.has(k) && !terminal.includes(k) && table.get(l.from)?.[k].includes(l.to),
      );
      flows.set(`${l.from}→${l.to}`, kinds);
      const target = received.get(l.to);
      for (const k of kinds) {
        if (target && !target.has(k)) {
          target.add(k);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return flows;
}
