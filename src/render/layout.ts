import type { Architecture } from '../engine/types.ts';

export interface Point {
  x: number;
  z: number;
}

export interface Road {
  /** Clé `from→to`, la même que celle des liens dans les ticks. */
  key: string;
  from: string;
  to: string;
  path: Point[];
}

export interface Layout {
  nodes: Record<string, Point>;
  roads: Road[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

const SPACING = { x: 5, z: 3.5 };

/**
 * Place la ville : une colonne par profondeur dans le graphe (le plus long chemin depuis
 * la source), le trafic s'écoule vers +x. Dans une colonne, chaque nœud est rangé à la
 * hauteur moyenne de ses parents, ce qui limite les croisements de routes.
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
  for (const d of [...columns.keys()].sort((a, b) => a - b)) {
    const ids = columns.get(d)!;
    const wanted = (id: string) => {
      const ps = (parents.get(id) ?? []).map((p) => nodes[p]).filter((p): p is Point => p !== undefined);
      return ps.length > 0 ? ps.reduce((a, p) => a + p.z, 0) / ps.length : 0;
    };
    const sorted = [...ids].sort((a, b) => wanted(a) - wanted(b) || a.localeCompare(b));
    sorted.forEach((id, i) => {
      nodes[id] = { x: d * SPACING.x, z: (i - (sorted.length - 1) / 2) * SPACING.z };
    });
  }

  const roads = arch.links
    .filter((l) => nodes[l.from] && nodes[l.to])
    .map((l): Road => ({ key: `${l.from}→${l.to}`, from: l.from, to: l.to, path: roadPath(nodes[l.from]!, nodes[l.to]!) }));

  const xs = Object.values(nodes).map((p) => p.x);
  const zs = Object.values(nodes).map((p) => p.z);
  return {
    nodes,
    roads,
    bounds: {
      minX: Math.min(0, ...xs),
      maxX: Math.max(0, ...xs),
      minZ: Math.min(0, ...zs),
      maxZ: Math.max(0, ...zs),
    },
  };
}

/** Route en baïonnette : droite si les deux nœuds sont alignés, sinon trois segments. */
export function roadPath(a: Point, b: Point): Point[] {
  if (a.z === b.z || a.x === b.x) return [a, b];
  const mx = (a.x + b.x) / 2;
  return [a, { x: mx, z: a.z }, { x: mx, z: b.z }, b];
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
