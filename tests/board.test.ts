import { describe, expect, it } from 'vitest';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import type { Architecture } from '../src/engine/types.ts';
import { findPath, hexDistance, hexKey, type Hex } from '../src/render/hex.ts';
import { layoutArchitecture } from '../src/render/layout.ts';
import { autoPlace, connect, insideBoard, moveNode, nodeAt, occupied, placeNode, type BoardResult } from '../src/ui/board.ts';

const anywhere = () => true;

function adjacent(path: Hex[]): boolean {
  return path.every((c, i) => i === 0 || hexDistance(path[i - 1]!, c) === 1);
}

function ok(r: BoardResult): Architecture {
  if (!r.ok) throw new Error(r.reason);
  return r.arch;
}

describe('findPath', () => {
  it('va tout droit quand rien ne gêne', () => {
    const path = findPath({ q: 0, r: 0 }, { q: 4, r: 0 }, new Set(), anywhere)!;
    expect(path).toHaveLength(5);
    expect(adjacent(path)).toBe(true);
  });

  it('contourne une case bloquée', () => {
    const blocked = new Set([hexKey({ q: 2, r: 0 })]);
    const path = findPath({ q: 0, r: 0 }, { q: 4, r: 0 }, blocked, anywhere)!;
    expect(path.some((c) => hexKey(c) === hexKey({ q: 2, r: 0 }))).toBe(false);
    expect(adjacent(path)).toBe(true);
    expect(path.at(-1)).toEqual({ q: 4, r: 0 });
  });

  it('entre dans la case d’arrivée même si elle est bloquée', () => {
    const path = findPath({ q: 0, r: 0 }, { q: 2, r: 0 }, new Set([hexKey({ q: 2, r: 0 })]), anywhere);
    expect(path?.at(-1)).toEqual({ q: 2, r: 0 });
  });

  it('renvoie undefined quand l’arrivée est encerclée', () => {
    const goal = { q: 5, r: 0 };
    const ring = [
      { q: 6, r: 0 },
      { q: 6, r: -1 },
      { q: 5, r: -1 },
      { q: 4, r: 0 },
      { q: 4, r: 1 },
      { q: 5, r: 1 },
    ];
    const inside = (h: Hex) => Math.abs(h.q) < 10 && Math.abs(h.r) < 10;
    expect(findPath({ q: 0, r: 0 }, goal, new Set(ring.map(hexKey)), inside)).toBeUndefined();
  });
});

describe('plateau', () => {
  const start: Architecture = { nodes: [{ id: 'src', type: 'traffic-source', cell: { q: 0, r: 0 } }], links: [] };

  it('pose un bâtiment sur une case libre du plateau', () => {
    const arch = ok(placeNode(start, 'app-server', { q: 3, r: 0 }));
    expect(nodeAt(arch, { q: 3, r: 0 })?.type).toBe('app-server');
    expect(occupied(arch).size).toBe(2);
  });

  it('refuse une case occupée ou hors plateau', () => {
    expect(placeNode(start, 'app-server', { q: 0, r: 0 })).toEqual({ ok: false, reason: 'Cette case est déjà occupée.' });
    expect(insideBoard({ q: 0, r: 40 })).toBe(false);
    expect(placeNode(start, 'app-server', { q: 0, r: 40 }).ok).toBe(false);
  });

  it('relie deux bâtiments par des cases adjacentes, en contournant les autres', () => {
    let arch = ok(placeNode(start, 'app-server', { q: 4, r: 0 }));
    arch = ok(placeNode(arch, 'cache', { q: 2, r: 0 }));
    arch = ok(connect(arch, 'src', 'app-server'));
    const path = arch.links[0]!.path!;
    expect(path[0]).toEqual({ q: 0, r: 0 });
    expect(path.at(-1)).toEqual({ q: 4, r: 0 });
    expect(adjacent(path)).toBe(true);
    expect(path.some((c) => hexKey(c) === hexKey({ q: 2, r: 0 }))).toBe(false);
  });

  it('refuse un lien en double ou vers soi-même', () => {
    let arch = ok(placeNode(start, 'app-server', { q: 3, r: 0 }));
    arch = ok(connect(arch, 'src', 'app-server'));
    expect(connect(arch, 'src', 'app-server').ok).toBe(false);
    expect(connect(arch, 'src', 'src').ok).toBe(false);
  });

  it('retrace les chemins d’un bâtiment déplacé', () => {
    let arch = ok(placeNode(start, 'app-server', { q: 3, r: 0 }));
    arch = ok(connect(arch, 'src', 'app-server'));
    arch = ok(moveNode(arch, 'app-server', { q: 3, r: 2 }));
    const path = arch.links[0]!.path!;
    expect(path.at(-1)).toEqual({ q: 3, r: 2 });
    expect(adjacent(path)).toBe(true);
  });

  it('fait contourner une nouvelle construction posée sur un chemin', () => {
    let arch = ok(placeNode(start, 'app-server', { q: 4, r: 0 }));
    arch = ok(connect(arch, 'src', 'app-server'));
    arch = ok(placeNode(arch, 'cache', { q: 2, r: 0 }));
    expect(arch.links[0]!.path!.some((c) => hexKey(c) === hexKey({ q: 2, r: 0 }))).toBe(false);
  });

  it('place automatiquement un brouillon d’avant le plateau, une seule fois', () => {
    const placed = autoPlace(A.queuedClicks(3));
    expect(placed.nodes.every((n) => n.cell)).toBe(true);
    expect(placed.links.every((l) => l.path && adjacent(l.path))).toBe(true);
    expect(autoPlace(placed)).toBe(placed);
  });

  it('le plateau est un hexagone dont les clients occupent la pointe gauche', () => {
    expect(insideBoard({ q: 0, r: 0 })).toBe(true);
    expect(insideBoard({ q: -1, r: 0 })).toBe(false);
    expect(insideBoard({ q: 18, r: 0 })).toBe(true);
    expect(insideBoard({ q: 9, r: -9 })).toBe(true);
    expect(insideBoard({ q: 0, r: -1 })).toBe(false);
  });

  it('replace un bâtiment resté hors du plateau, et retrace ses chemins', () => {
    let arch = ok(placeNode(start, 'app-server', { q: 3, r: 0 }));
    arch = ok(connect(arch, 'src', 'app-server'));
    const stray: Architecture = { ...arch, nodes: arch.nodes.map((n) => (n.id === 'app-server' ? { ...n, cell: { q: 0, r: -5 } } : n)) };
    const fixed = autoPlace(stray);
    expect(fixed.nodes.every((n) => insideBoard(n.cell!))).toBe(true);
    expect(fixed.links[0]!.path!.every(insideBoard)).toBe(true);
    expect(adjacent(fixed.links[0]!.path!)).toBe(true);
  });

  it('la mise en page respecte les cases et les chemins posés', () => {
    let arch = ok(placeNode(start, 'app-server', { q: 5, r: -2 }));
    arch = ok(connect(arch, 'src', 'app-server'));
    const layout = layoutArchitecture(arch);
    expect(layout.cells['app-server']).toEqual({ q: 5, r: -2 });
    expect(layout.roads[0]!.cells).toEqual(arch.links[0]!.path);
  });
});
