import type { BoardCell } from '../engine/types.ts';
import type { Point } from './layout.ts';

/**
 * Grille hexagonale « pointe en haut », en coordonnées axiales (q, r), alignée sur les
 * tuiles KayKit : 2 unités de large, 1,732 entre deux rangées. C'est la grille sur
 * laquelle le joueur posera ses bâtiments et tracera ses chemins.
 */
export type Hex = BoardCell;

export const HEX_WIDTH = 2;
/** Rayon : distance du centre à un sommet. */
export const HEX_SIZE = HEX_WIDTH / Math.sqrt(3);
export const HEX_ROW = HEX_SIZE * 1.5;

export function hexCenter(h: Hex): Point {
  return { x: HEX_WIDTH * (h.q + h.r / 2), z: HEX_ROW * h.r };
}

export function hexKey(h: Hex): string {
  return `${h.q},${h.r}`;
}

/** Case qui contient le point : arrondi en coordonnées cubiques, le seul qui soit exact. */
export function hexAt(p: Point): Hex {
  const r = p.z / HEX_ROW;
  const q = p.x / HEX_WIDTH - r / 2;
  return roundHex(q, r);
}

function roundHex(q: number, r: number): Hex {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  // `+ 0` normalise -0 en 0 : deux clés de la même case doivent être égales.
  return { q: rq + 0, r: rr + 0 };
}

export function hexDistance(a: Hex, b: Hex): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
}

const DIRECTIONS: Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export function hexNeighbours(h: Hex): Hex[] {
  return DIRECTIONS.map((d) => ({ q: h.q + d.q, r: h.r + d.r }));
}

/**
 * Chemin de cases adjacentes de `a` à `b`, en ligne droite sur la grille. Le léger
 * décalage évite que l'interpolation tombe pile sur une arête et hésite entre deux cases.
 */
export function hexLine(a: Hex, b: Hex): Hex[] {
  const n = hexDistance(a, b);
  const out: Hex[] = [];
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    out.push(roundHex(a.q + (b.q - a.q) * t + 1e-6, a.r + (b.r - a.r) * t + 1e-6));
  }
  return out;
}

/** Case libre la plus proche de `h`, en parcourant les anneaux autour d'elle. */
export function nearestFree(h: Hex, taken: Set<string>): Hex {
  if (!taken.has(hexKey(h))) return h;
  const seen = new Set([hexKey(h)]);
  let ring = [h];
  for (let radius = 1; radius < 50; radius++) {
    const next: Hex[] = [];
    for (const c of ring) {
      for (const n of hexNeighbours(c)) {
        const k = hexKey(n);
        if (seen.has(k)) continue;
        seen.add(k);
        if (!taken.has(k)) return n;
        next.push(n);
      }
    }
    ring = next;
  }
  return h;
}

/**
 * Plus court chemin de cases adjacentes de `a` à `b` (A*), sans passer par une case de
 * `blocked` — sauf l'arrivée, qui est le bâtiment visé. `inside` borne la recherche au
 * plateau. `undefined` si `b` est inaccessible.
 */
export function findPath(a: Hex, b: Hex, blocked: Set<string>, inside: (h: Hex) => boolean): Hex[] | undefined {
  const goal = hexKey(b);
  const open = new Map<string, { h: Hex; f: number }>([[hexKey(a), { h: a, f: hexDistance(a, b) }]]);
  const cost = new Map<string, number>([[hexKey(a), 0]]);
  const came = new Map<string, Hex>();

  while (open.size > 0) {
    // Le plateau compte quelques centaines de cases : un parcours linéaire suffit, sans tas.
    let bestKey = '';
    let best: { h: Hex; f: number } | undefined;
    for (const [k, v] of open) if (!best || v.f < best.f || (v.f === best.f && k < bestKey)) [bestKey, best] = [k, v];
    if (!best) break;
    open.delete(bestKey);
    if (bestKey === goal) {
      const path = [best.h];
      let k = bestKey;
      while (came.has(k)) {
        const prev = came.get(k)!;
        path.unshift(prev);
        k = hexKey(prev);
      }
      return path;
    }
    for (const n of hexNeighbours(best.h)) {
      const k = hexKey(n);
      if (k !== goal && (blocked.has(k) || !inside(n))) continue;
      const g = cost.get(bestKey)! + 1;
      if (g >= (cost.get(k) ?? Infinity)) continue;
      cost.set(k, g);
      came.set(k, best.h);
      open.set(k, { h: n, f: g + hexDistance(n, b) });
    }
  }
  return undefined;
}
