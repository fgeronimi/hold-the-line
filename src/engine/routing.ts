import type { Architecture, Catalog, RequestKind } from './types.ts';
import { REQUEST_KINDS } from './types.ts';

export interface NodeRoutes {
  /** Voisins consultés d'abord (cache-aside) : ils servent une part, le reste repart d'ici. */
  lookup: Record<RequestKind, string[]>;
  /** Voisins vers lesquels le type est transmis, une fois les consultations faites. */
  forward: Record<RequestKind, string[]>;
}

export type RouteTable = Map<string, NodeRoutes>;

/**
 * Les liens ne portent pas de type : le joueur relie des composants, le moteur en déduit
 * le chemin. Un type est d'abord présenté aux voisins consultés qui l'acceptent (un cache
 * pour les lectures) ; ce qu'ils ne servent pas va au voisin transmis le plus spécialisé
 * qui l'accepte (la file avant la base pour l'async). À égalité, réparti également.
 */
export function routeTable(arch: Architecture, catalog: Catalog): RouteTable {
  const typeOf = new Map(arch.nodes.map((n) => [n.id, n.type]));
  const table: RouteTable = new Map();
  for (const node of arch.nodes) {
    const neighbours = arch.links
      .filter((l) => l.from === node.id)
      .map((l) => ({ id: l.to, def: catalog.components[typeOf.get(l.to) ?? ''] }));
    const lookup = {} as Record<RequestKind, string[]>;
    const forward = {} as Record<RequestKind, string[]>;
    for (const kind of REQUEST_KINDS) {
      const accepting = neighbours.filter((n) => n.def?.accepts.includes(kind));
      lookup[kind] = accepting.filter((n) => n.def?.lookaside).map((n) => n.id);
      const direct = accepting.filter((n) => !n.def?.lookaside);
      const best = Math.max(...direct.map((n) => n.def?.routingPriority ?? 0));
      forward[kind] = direct.filter((n) => (n.def?.routingPriority ?? 0) === best).map((n) => n.id);
    }
    table.set(node.id, { lookup, forward });
  }
  return table;
}

export type LinkFlows = Map<string, RequestKind[]>;

/**
 * Les types qui circulent réellement sur chaque lien (clé `from→to`) : un nœud ne
 * transmet que ce qu'il reçoit, et la source émet tout. Sert à l'affichage.
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
      const routes = table.get(l.from);
      const kinds = REQUEST_KINDS.filter(
        (k) =>
          received.get(l.from)?.has(k) &&
          !terminal.includes(k) &&
          (routes?.lookup[k].includes(l.to) || routes?.forward[k].includes(l.to)),
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
