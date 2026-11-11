import { BOARD } from '../data/board.ts';
import type { Architecture, ArchLink, ArchNode, BoardCell, Catalog } from '../engine/types.ts';
import { findPath, hexDistance, hexKey, hexSide } from '../render/hex.ts';
import { layoutArchitecture } from '../render/layout.ts';
import { bridge, isRiver, riverKeys } from '../render/terrain.ts';
import { downstreamRefusal } from '../engine/validate.ts';
import { draftInfo } from './draft.ts';
import { nextNodeId } from './editor.ts';

/**
 * Règles du plateau : où l'on peut bâtir, et le tracé des chemins. Pures, comme `editor.ts` :
 * l'interface ne fait que les appeler et afficher la raison d'un refus.
 */
export type BoardResult = { ok: true; arch: Architecture } | { ok: false; reason: string };

export function insideBoard(h: BoardCell): boolean {
  return hexDistance(h, BOARD.center) <= BOARD.radius;
}

/** Cases occupées par un bâtiment, et le bâtiment qui l'occupe. */
export function occupied(arch: Architecture): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of arch.nodes) if (n.cell) out.set(hexKey(n.cell), n.id);
  return out;
}

export function nodeAt(arch: Architecture, cell: BoardCell): ArchNode | undefined {
  const id = occupied(arch).get(hexKey(cell));
  return arch.nodes.find((n) => n.id === id);
}

function freeForBuilding(arch: Architecture, cell: BoardCell, except?: string): string | undefined {
  if (!insideBoard(cell)) return 'Hors du plateau.';
  if (isRiver(cell)) return 'On ne bâtit pas sur la rivière.';
  const owner = occupied(arch).get(hexKey(cell));
  if (owner && owner !== except) return 'Cette case est déjà occupée.';
  return undefined;
}

/** Chemin le plus court entre deux bâtiments, en contournant tous les autres. */
function route(arch: Architecture, from: string, to: string): BoardCell[] | undefined {
  const a = arch.nodes.find((n) => n.id === from)?.cell;
  const b = arch.nodes.find((n) => n.id === to)?.cell;
  if (!a || !b) return undefined;
  // La rivière ne se franchit que par un pont, tout droit (voir `bridge`).
  const blocked = new Set([...occupied(arch).keys(), ...riverKeys()].filter((k) => k !== hexKey(a) && k !== hexKey(b)));
  return findPath(a, b, blocked, insideBoard, bridge);
}

/** Retrace les liens choisis ; un lien devenu impossible garde son ancien tracé. */
function reroute(arch: Architecture, which: (l: ArchLink) => boolean): Architecture {
  return {
    ...arch,
    links: arch.links.map((l) => {
      if (!which(l)) return l;
      const path = route(arch, l.from, l.to);
      return path ? { ...l, path } : l;
    }),
  };
}

/** La case `i` d'un chemin est un pont : il y entre et en sort tout droit, par un franchissement autorisé. */
function isBridge(path: BoardCell[], i: number): boolean {
  const before = path[i - 1];
  const after = path[i + 1];
  const side = before ? hexSide(before, path[i]!) : -1;
  if (!before || !after || side < 0) return false;
  const jump = bridge(before, side);
  return jump !== undefined && hexKey(jump.to) === hexKey(after);
}

const crosses = (l: ArchLink, cell: BoardCell) => l.path?.some((c) => hexKey(c) === hexKey(cell)) ?? false;

/**
 * Poser un bâtiment. Sur un chemin, il s'insère dans le lien quand il le peut : A → B devient
 * A → nouveau → B (une file entre le serveur et le banquier), ou, pour un cache qu'on
 * consulte sans le traverser, A → cache s'ajoute à côté de A → B. Sinon, et sans catalogue,
 * le chemin contourne la case.
 */
export function placeNode(arch: Architecture, type: string, cell: BoardCell, catalog?: Catalog): BoardResult {
  const refused = freeForBuilding(arch, cell);
  if (refused) return { ok: false, reason: refused };
  const id = nextNodeId(arch, type);
  let next: Architecture = { ...arch, nodes: [...arch.nodes, { id, type, cell }] };
  const crossed = arch.links.filter((l) => crosses(l, cell));
  const inserted = new Set<ArchLink>();
  if (catalog) {
    const flows = draftInfo(arch, catalog).flows;
    for (const l of crossed) {
      const candidate = insertInto(next, l, id, flows.get(`${l.from}→${l.to}`) ?? [], catalog);
      if (candidate) {
        next = candidate;
        inserted.add(l);
      }
    }
  }
  // Les nouveaux liens n'ont pas encore de tracé ; un chemin qui passait là contourne la case.
  return { ok: true, arch: reroute(next, (l) => !l.path || (crosses(l, cell) && !inserted.has(l))) };
}

/** Le lien `l` passe désormais par le bâtiment `id`, si c'est sensé et que l'architecture reste valide. */
function insertInto(arch: Architecture, l: ArchLink, id: string, carried: string[], catalog: Catalog): Architecture | undefined {
  const node = arch.nodes.find((n) => n.id === id)!;
  const def = catalog.components[node.type];
  if (!def || !carried.some((k) => (def.accepts as string[]).includes(k))) return undefined;
  const has = (from: string, to: string) => arch.links.some((x) => x.from === from && x.to === to);
  // Consulté, pas traversé : le cache se branche à côté du lien, qui reste.
  const links = def.lookaside
    ? [...arch.links, ...(has(l.from, id) ? [] : [{ from: l.from, to: id }])]
    : [...arch.links.filter((x) => x !== l), { from: l.from, to: id }, { from: id, to: l.to }];
  const candidate: Architecture = { ...arch, links };
  if (!draftInfo(candidate, catalog).validation.ok && draftInfo(arch, catalog).validation.ok) return undefined;
  // Il doit vraiment recevoir ce qui passait, et, s'il est traversé, le transmettre à l'arrivée.
  const flows = draftInfo(candidate, catalog).flows;
  if ((flows.get(`${l.from}→${id}`) ?? []).length === 0) return undefined;
  if (!def.lookaside && (flows.get(`${id}→${l.to}`) ?? []).length === 0) return undefined;
  return candidate;
}

export function moveNode(arch: Architecture, id: string, cell: BoardCell): BoardResult {
  const refused = freeForBuilding(arch, cell, id);
  if (refused) return { ok: false, reason: refused };
  const next: Architecture = { ...arch, nodes: arch.nodes.map((n) => (n.id === id ? { ...n, cell } : n)) };
  return { ok: true, arch: reroute(next, (l) => l.from === id || l.to === id || crosses(l, cell)) };
}

/**
 * Relie deux bâtiments. Avec le catalogue, un lien que le composant de départ refuse
 * (une file vers un serveur d'application) l'est dès le geste, avec sa raison.
 */
export function connect(arch: Architecture, from: string, to: string, catalog?: Catalog): BoardResult {
  if (from === to) return { ok: false, reason: 'Un bâtiment ne se relie pas à lui-même.' };
  const refused = catalog && linkRefusal(arch, from, to, catalog);
  if (refused) return { ok: false, reason: refused };
  if (arch.links.some((l) => l.from === from && l.to === to)) return { ok: false, reason: 'Ces deux bâtiments sont déjà reliés.' };
  const path = route(arch, from, to);
  if (!path) return { ok: false, reason: 'Aucun chemin possible : des bâtiments bloquent le passage.' };
  return { ok: true, arch: { ...arch, links: [...arch.links, { from, to, path }] } };
}

/**
 * Donne une case à chaque bâtiment qui n'en a pas, ou dont la case est sortie du plateau
 * (sauvegarde d'avant le plateau hexagonal), et un chemin à chaque lien qui n'en a pas ou
 * qui touche un bâtiment replacé. Sans effet sur une architecture déjà bien placée.
 */
/** La raison, pour le joueur, d'un lien que le composant de départ n'accepte pas. */
export function linkRefusal(arch: Architecture, from: string, to: string, catalog: Catalog): string | undefined {
  const a = arch.nodes.find((n) => n.id === from);
  const b = arch.nodes.find((n) => n.id === to);
  const da = a && catalog.components[a.type];
  const db = b && catalog.components[b.type];
  if (!da || !db || !downstreamRefusal(catalog, a.type, b.type)) return undefined;
  if (da.allowedDownstream?.length === 0) return `${da.techName} ne transmet rien : il est consulté, pas traversé.`;
  const why = da.downstreamRule ? ` : ${da.downstreamRule}` : '';
  return `${da.techName} ne peut pas alimenter ${db.techName}${why}.`;
}

export function autoPlace(arch: Architecture): Architecture {
  const misplaced = new Set(arch.nodes.filter((n) => !n.cell || !insideBoard(n.cell) || isRiver(n.cell)).map((n) => n.id));
  // Un chemin d'avant la rivière qui la longe ou la coupe hors d'un pont est retracé.
  const wet = (l: ArchLink) => l.path?.some((c, i) => isRiver(c) && !isBridge(l.path!, i)) ?? false;
  const strays = (l: ArchLink) =>
    !l.path || misplaced.has(l.from) || misplaced.has(l.to) || l.path.some((c) => !insideBoard(c)) || wet(l);
  if (misplaced.size === 0 && !arch.links.some(strays)) return arch;
  const kept: Architecture = {
    ...arch,
    nodes: arch.nodes.map((n): ArchNode => {
      if (!misplaced.has(n.id)) return n;
      const { cell: _dropped, ...rest } = n;
      return rest;
    }),
  };
  const layout = layoutArchitecture(kept);
  const placed: Architecture = {
    ...kept,
    nodes: kept.nodes.map((n) => (n.cell ? n : { ...n, cell: layout.cells[n.id]! })),
  };
  return reroute(placed, strays);
}
