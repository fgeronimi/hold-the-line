import { BOARD } from '../data/board.ts';
import type { Architecture } from '../engine/types.ts';
import { HEX_ROW, HEX_WIDTH, hexAt, hexCenter, hexKey, hexLine, nearestFree, type Hex } from './hex.ts';

export interface Point {
  x: number;
  z: number;
}

export interface Road {
  /** Clé `from→to`, la même que celle des liens dans les ticks. */
  key: string;
  from: string;
  to: string;
  /** Cases traversées, du nœud de départ au nœud d'arrivée inclus. */
  cells: Hex[];
  /** Centres de ces cases : le trajet des véhicules. */
  path: Point[];
}

export interface Layout {
  nodes: Record<string, Point>;
  /** Case occupée par chaque nœud. */
  cells: Record<string, Hex>;
  roads: Road[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** Écart visé entre colonnes et entre nœuds d'une colonne, avant calage sur la grille. */
const SPACING = { x: 6, z: 3.5 };

/**
 * Place la cité sur la grille hexagonale : une colonne par profondeur dans le graphe (le
 * plus long chemin depuis la source), le trafic s'écoule vers +x. Dans une colonne, chaque
 * nœud vise la hauteur moyenne de ses parents, puis se cale sur la case libre la plus
 * proche. Chaque lien devient un chemin de cases adjacentes.
 */
export function layoutArchitecture(arch: Architecture): Layout {
  const parents = new Map(arch.nodes.map((n) => [n.id, [] as string[]]));
  for (const l of arch.links) parents.get(l.to)?.push(l.from);

  const depth = new Map<string, number>();
  const depthOf = (id: string, seen = new Set<string>()): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0; // Cycle : l'architecture est invalide, on place quand même.
    seen.add(id);
    const ps = parents.get(id) ?? [];
    const d = ps.length === 0 ? 0 : 1 + Math.max(...ps.map((p) => depthOf(p, seen)));
    depth.set(id, d);
    return d;
  };
  for (const n of arch.nodes) depthOf(n.id);

  const columns = new Map<number, string[]>();
  for (const n of arch.nodes) {
    const d = depth.get(n.id)!;
    columns.set(d, [...(columns.get(d) ?? []), n.id]);
  }

  const nodes: Record<string, Point> = {};
  const cells: Record<string, Hex> = {};
  const taken = new Set<string>();
  // Les bâtiments posés par le joueur gardent leur case ; les autres se placent autour.
  for (const n of arch.nodes) {
    if (!n.cell) continue;
    cells[n.id] = n.cell;
    nodes[n.id] = hexCenter(n.cell);
    taken.add(hexKey(n.cell));
  }
  for (const d of [...columns.keys()].sort((a, b) => a - b)) {
    const ids = columns.get(d)!.filter((id) => !cells[id]);
    const wanted = (id: string) => {
      const ps = (parents.get(id) ?? []).map((p) => nodes[p]).filter((p): p is Point => p !== undefined);
      return ps.length > 0 ? ps.reduce((a, p) => a + p.z, 0) / ps.length : 0;
    };
    const sorted = [...ids].sort((a, b) => wanted(a) - wanted(b) || a.localeCompare(b));
    sorted.forEach((id, i) => {
      const cell = nearestFree(hexAt({ x: d * SPACING.x, z: (i - (sorted.length - 1) / 2) * SPACING.z }), taken);
      taken.add(hexKey(cell));
      cells[id] = cell;
      nodes[id] = hexCenter(cell);
    });
  }

  const roads = arch.links
    .filter((l) => cells[l.from] && cells[l.to])
    .map((l): Road => {
      const line = l.path && l.path.length > 1 ? l.path : hexLine(cells[l.from]!, cells[l.to]!);
      return { key: `${l.from}→${l.to}`, from: l.from, to: l.to, cells: line, path: line.map(hexCenter) };
    });

  const xs = Object.values(nodes).map((p) => p.x);
  const zs = Object.values(nodes).map((p) => p.z);
  const center = hexCenter(BOARD.center);
  return {
    nodes,
    cells,
    roads,
    // Le cadre couvre tout le plateau jouable, pour que la vue ne saute pas à chaque construction.
    bounds: {
      minX: Math.min(center.x - BOARD.radius * HEX_WIDTH, ...xs),
      maxX: Math.max(center.x + BOARD.radius * HEX_WIDTH, ...xs),
      minZ: Math.min(center.z - BOARD.radius * HEX_ROW, ...zs),
      maxZ: Math.max(center.z + BOARD.radius * HEX_ROW, ...zs),
    },
  };
}

export function pathLength(path: Point[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.z - path[i - 1]!.z);
  return total;
}

/** Position à la fraction `f` (0 → 1) du chemin, et direction du segment courant. */
export function pointAlong(path: Point[], f: number): { point: Point; angle: number } {
  const total = pathLength(path);
  let remaining = Math.min(Math.max(f, 0), 1) * total;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (remaining <= seg || i === path.length - 1) {
      const t = seg === 0 ? 0 : Math.min(remaining / seg, 1);
      return { point: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, angle: Math.atan2(b.x - a.x, b.z - a.z) };
    }
    remaining -= seg;
  }
  return { point: path[0]!, angle: 0 };
}
