import { describe, expect, it } from 'vitest';
import { hexKey, hexSide, type Hex } from '../src/render/hex.ts';
import { bridgeRotation, crossingTile, mask, riverCells, riverTile, roadSides, roadTile, rotateMask } from '../src/render/terrain.ts';
import { autoPlace, connect, insideBoard, placeNode } from '../src/ui/board.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import type { Architecture } from '../src/engine/types.ts';

describe('tuiles de route et de rivière', () => {
  it('une tuile de route pour chacune des 63 combinaisons de côtés', () => {
    for (let m = 1; m < 64; m++) {
      const t = roadTile(m)!;
      expect(t).toBeDefined();
      expect(t.turns).toBeGreaterThanOrEqual(0);
    }
  });

  it('tourner une tuile décale les côtés qu’elle relie', () => {
    expect(rotateMask(mask(0, 3), 1)).toBe(mask(1, 4));
    expect(rotateMask(mask(5), 1)).toBe(mask(0));
    expect(roadTile(mask(1, 4))).toEqual({ model: 'hex_road_A', turns: 1 });
  });

  it('le pont est tourné dans l’axe du chemin', () => {
    // Axe du modèle à 60° ; après rotation θ, il pointe à 60° − θ.
    const axis = (sides: number) => Math.PI / 3 - bridgeRotation(sides);
    const sameAxis = (a: number, b: number) => Math.abs(Math.sin(a - b)) < 1e-9;
    const center = (q: number, r: number) => Math.atan2((Math.sqrt(3) / 2) * r, q + r / 2);
    expect(sameAxis(axis(mask(0, 3)), center(1, 0))).toBe(true);
    expect(sameAxis(axis(mask(1, 4)), center(1, -1))).toBe(true);
    expect(sameAxis(axis(mask(2, 5)), center(0, 1))).toBe(true);
  });

  it('un pont sur une rivière droite traversée par un chemin droit', () => {
    expect(crossingTile(mask(1, 4), mask(0, 3))?.model).toMatch(/crossing/);
    expect(crossingTile(mask(1, 4), mask(1, 4))).toBeUndefined();
  });
});

describe('rivière', () => {
  const river = [...riverCells().values()];

  it('traverse le plateau d’un bord à l’autre, case après case', () => {
    expect(river.every((c) => insideBoard(c.cell))).toBe(true);
    river.forEach((c, i) => {
      if (i > 0) expect(hexSide(river[i - 1]!.cell, c.cell)).toBeGreaterThanOrEqual(0);
      expect(riverTile(c.sides)).toBeDefined();
    });
  });

  it('on ne bâtit pas dessus', () => {
    const start: Architecture = { nodes: [{ id: 'src', type: 'traffic-source', cell: { q: 0, r: 0 } }], links: [] };
    expect(placeNode(start, 'app-server', river[3]!.cell)).toEqual({ ok: false, reason: 'On ne bâtit pas sur la rivière.' });
  });

  it('un chemin la franchit tout droit, par un pont', () => {
    const start: Architecture = { nodes: [{ id: 'src', type: 'traffic-source', cell: { q: 0, r: 0 } }], links: [] };
    let arch = (placeNode(start, 'app-server', { q: 16, r: 0 }) as { arch: Architecture }).arch;
    const linked = connect(arch, 'src', 'app-server');
    expect(linked.ok).toBe(true);
    arch = (linked as { arch: Architecture }).arch;
    const path = arch.links[0]!.path!;
    const wet = path.map((c, i) => ({ c, i })).filter(({ c }) => riverCells().has(hexKey(c)));
    expect(wet).toHaveLength(1);
    const { i } = wet[0]!;
    expect(hexSide(path[i - 1]!, path[i]!)).toBe(hexSide(path[i]!, path[i + 1]!));
    const sides = roadSides([path]).get(hexKey(path[i]!))!.sides;
    expect(crossingTile(riverCells().get(hexKey(path[i]!))!.sides, sides)).toBeDefined();
  });

  it('les architectures types se placent hors de l’eau, avec des chemins valides', () => {
    for (const arch of [A.queuedClicks(4), A.withCdn({ rateLimitTier: 3, queue: true }), A.autoscaled(1, 3)]) {
      const placed = autoPlace(arch);
      expect(placed.nodes.every((n) => !riverCells().has(hexKey(n.cell as Hex)))).toBe(true);
      expect(placed.links.every((l) => l.path && l.path.length > 1)).toBe(true);
    }
  });
});
