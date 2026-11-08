import { BOARD } from '../data/board.ts';
import type { Architecture, ArchLink, ArchNode, BoardCell } from '../engine/types.ts';
import { findPath, hexDistance, hexKey } from '../render/hex.ts';
import { layoutArchitecture } from '../render/layout.ts';
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
  const owner = occupied(arch).get(hexKey(cell));
  if (owner && owner !== except) return 'Cette case est déjà occupée.';
  return undefined;
}

/** Chemin le plus court entre deux bâtiments, en contournant tous les autres. */
function route(arch: Architecture, from: string, to: string): BoardCell[] | undefined {
  const a = arch.nodes.find((n) => n.id === from)?.cell;
  const b = arch.nodes.find((n) => n.id === to)?.cell;
  if (!a || !b) return undefined;
  const blocked = new Set([...occupied(arch).keys()].filter((k) => k !== hexKey(a) && k !== hexKey(b)));
  return findPath(a, b, blocked, insideBoard);
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

const crosses = (l: ArchLink, cell: BoardCell) => l.path?.some((c) => hexKey(c) === hexKey(cell)) ?? false;

export function placeNode(arch: Architecture, type: string, cell: BoardCell): BoardResult {
  const refused = freeForBuilding(arch, cell);
  if (refused) return { ok: false, reason: refused };
  const next: Architecture = { ...arch, nodes: [...arch.nodes, { id: nextNodeId(arch, type), type, cell }] };
  // Un chemin qui passait par cette case la contourne désormais.
  return { ok: true, arch: reroute(next, (l) => crosses(l, cell)) };
}

export function moveNode(arch: Architecture, id: string, cell: BoardCell): BoardResult {
  const refused = freeForBuilding(arch, cell, id);
  if (refused) return { ok: false, reason: refused };
  const next: Architecture = { ...arch, nodes: arch.nodes.map((n) => (n.id === id ? { ...n, cell } : n)) };
  return { ok: true, arch: reroute(next, (l) => l.from === id || l.to === id || crosses(l, cell)) };
}

export function connect(arch: Architecture, from: string, to: string): BoardResult {
  if (from === to) return { ok: false, reason: 'Un bâtiment ne se relie pas à lui-même.' };
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
export function autoPlace(arch: Architecture): Architecture {
  const misplaced = new Set(arch.nodes.filter((n) => !n.cell || !insideBoard(n.cell)).map((n) => n.id));
  const strays = (l: ArchLink) => !l.path || misplaced.has(l.from) || misplaced.has(l.to) || l.path.some((c) => !insideBoard(c));
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
