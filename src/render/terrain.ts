import { BOARD, RIVER } from '../data/board.ts';
import { hexDistance, hexKey, hexSide, hexStep, type Crossing, type Hex } from './hex.ts';

/**
 * Le terrain : la rivière, et le choix des tuiles KayKit de route et de rivière. Une tuile
 * relie certains côtés de sa case (bit `i` = côté `i` de `hexNeighbours`) ; tournée de
 * k × 60°, elle relie ces côtés décalés de k. Pur : se teste sans scène.
 */

/** Côtés reliés par chaque tuile posée sans rotation, relevés sur les modèles. */
const ROAD_TILES: Record<string, number> = {
  hex_road_A: mask(0, 3),
  hex_road_B: mask(1, 3),
  hex_road_C: mask(2, 3),
  hex_road_D: mask(1, 3, 5),
  hex_road_E: mask(0, 1, 3),
  hex_road_F: mask(0, 3, 5),
  hex_road_G: mask(2, 3, 4),
  hex_road_H: mask(0, 2, 3, 4),
  hex_road_I: mask(1, 2, 4, 5),
  hex_road_J: mask(0, 3, 4, 5),
  hex_road_K: mask(1, 2, 3, 4, 5),
  hex_road_L: mask(0, 1, 2, 3, 4, 5),
  hex_road_M: mask(3),
};
const RIVER_TILES: Record<string, number> = Object.fromEntries(
  Object.entries(ROAD_TILES)
    .filter(([name]) => name !== 'hex_road_M')
    .map(([name, m]) => [name.replace('road', 'river'), m]),
);
/** Rivière droite côtés 0-3, chemin droit côtés 2-5 (A) ou 1-4 (B). */
const CROSSING_TILES: Record<string, { river: number; road: number }> = {
  hex_river_crossing_A: { river: mask(0, 3), road: mask(2, 5) },
  hex_river_crossing_B: { river: mask(0, 3), road: mask(1, 4) },
};

export const BRIDGE_MODEL = 'building_bridge_A';
/**
 * Axe du pont KayKit posé sans rotation, en radians depuis +x vers +z : 60°, l'axe des
 * côtés 2-5. Mesuré sur les sommets du modèle (axe principal), pas à l'œil.
 */
const BRIDGE_AXIS = Math.PI / 3;

/**
 * Rotation y qui aligne le pont sur le chemin. Three tourne un axe d'angle α en α − θ :
 * on veut α − θ = l'angle du chemin.
 */
export function bridgeRotation(roadSides: number): number {
  const side = [0, 1, 2].find((s) => roadSides & (1 << s) || roadSides & (1 << (s + 3)))!;
  return BRIDGE_AXIS - SIDE_ANGLE[side]!;
}

/** Angle de chaque côté, depuis +x vers +z, sur la grille « pointe en haut ». */
const SIDE_ANGLE = [0, -Math.PI / 3, (-2 * Math.PI) / 3, Math.PI, (2 * Math.PI) / 3, Math.PI / 3];
export const TERRAIN_MODELS = [...Object.keys(ROAD_TILES), ...Object.keys(RIVER_TILES), ...Object.keys(CROSSING_TILES), BRIDGE_MODEL];

export function mask(...sides: number[]): number {
  return sides.reduce((m, s) => m | (1 << (((s % 6) + 6) % 6)), 0);
}

export function rotateMask(m: number, k: number): number {
  let out = 0;
  for (let i = 0; i < 6; i++) if (m & (1 << i)) out |= 1 << ((i + k) % 6);
  return out;
}

export interface Tile {
  model: string;
  /** Nombre de sixièmes de tour : la rotation y vaut `turns × 60°`. */
  turns: number;
}

function match(tiles: Record<string, number>, wanted: number): Tile | undefined {
  for (const [model, base] of Object.entries(tiles)) {
    for (let turns = 0; turns < 6; turns++) if (rotateMask(base, turns) === wanted) return { model, turns };
  }
  return undefined;
}

export const roadTile = (sides: number) => match(ROAD_TILES, sides);
export const riverTile = (sides: number) => match(RIVER_TILES, sides);

/** Tuile d'un pont : la rivière droite traversée par un chemin droit. */
export function crossingTile(river: number, road: number): Tile | undefined {
  for (const [model, t] of Object.entries(CROSSING_TILES)) {
    for (let turns = 0; turns < 6; turns++) {
      if (rotateMask(t.river, turns) === river && rotateMask(t.road, turns) === road) return { model, turns };
    }
  }
  return undefined;
}

/** Cases de la rivière et les côtés qu'elle relie ; ses deux bouts sortent du plateau. */
export function riverCells(): Map<string, { cell: Hex; sides: number }> {
  const cells: Hex[] = [RIVER.from];
  const dirs: number[] = [];
  for (const run of RIVER.runs) {
    for (let i = 0; i < run.length; i++) {
      cells.push(hexStep(cells.at(-1)!, run.dir));
      dirs.push(run.dir);
    }
  }
  const out = new Map<string, { cell: Hex; sides: number }>();
  cells.forEach((cell, i) => {
    const into = i === 0 ? dirs[0]! : dirs[i - 1]!;
    const onward = i === cells.length - 1 ? dirs.at(-1)! : dirs[i]!;
    out.set(hexKey(cell), { cell, sides: mask(into + 3, onward) });
  });
  return out;
}

const RIVER_CELLS = riverCells();

export const isRiver = (h: Hex) => RIVER_CELLS.has(hexKey(h));
export const riverKeys = () => new Set(RIVER_CELLS.keys());

/**
 * Un chemin franchit la rivière tout droit, sur une case où elle coule droit : c'est là
 * qu'on sait poser un pont. Le détour coûte un peu, pour que les chemins ne la traversent
 * que s'il le faut.
 */
export const bridge: Crossing = (from, dir) => {
  const via = hexStep(from, dir);
  const river = RIVER_CELLS.get(hexKey(via));
  if (!river || !crossingTile(river.sides, mask(dir, dir + 3))) return undefined;
  const to = hexStep(via, dir);
  if (isRiver(to) || hexDistance(to, BOARD.center) > BOARD.radius) return undefined;
  return { via, to, cost: 3 };
};

/** Côtés reliés par les chemins, case par case. */
export function roadSides(paths: Hex[][]): Map<string, { cell: Hex; sides: number }> {
  const out = new Map<string, { cell: Hex; sides: number }>();
  const add = (cell: Hex, side: number) => {
    const k = hexKey(cell);
    const entry = out.get(k) ?? { cell, sides: 0 };
    if (side >= 0) entry.sides |= 1 << side;
    out.set(k, entry);
  };
  for (const path of paths) {
    path.forEach((cell, i) => {
      if (i > 0) add(cell, hexSide(cell, path[i - 1]!));
      if (i < path.length - 1) add(cell, hexSide(cell, path[i + 1]!));
    });
  }
  return out;
}
