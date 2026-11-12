import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
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

describe('poser un bâtiment sur un chemin', () => {
  // Clients (0,0) → serveur (4,0) → banquier (8,0) : deux chemins tout droits.
  const line = (): Architecture => {
    let arch: Architecture = { nodes: [{ id: 'src', type: 'traffic-source', cell: { q: 0, r: 0 } }], links: [] };
    arch = ok(placeNode(arch, 'app-server', { q: 4, r: 0 }));
    arch = { ...arch, nodes: [...arch.nodes, { id: 'bank', type: 'payment-provider', cell: { q: 8, r: 0 } }, { id: 'db', type: 'database', cell: { q: 4, r: 3 } }] };
    for (const [from, to] of [['src', 'app-server'], ['app-server', 'bank'], ['app-server', 'db']] as const) arch = ok(connect(arch, from, to));
    return arch;
  };
  const pairs = (arch: Architecture) => arch.links.map((l) => `${l.from}→${l.to}`).sort();
  const onPath = (arch: Architecture, from: string, to: string) => arch.links.find((l) => l.from === from && l.to === to)!.path![2]!;

  it('une file posée entre le serveur et le banquier s’insère dans le lien', () => {
    const arch = line();
    const next = ok(placeNode(arch, 'message-queue', onPath(arch, 'app-server', 'bank'), catalog));
    expect(pairs(next)).toEqual(['app-server→db', 'app-server→message-queue', 'message-queue→bank', 'src→app-server'].sort());
    expect(next.links.every((l) => l.path && adjacent(l.path))).toBe(true);
  });

  it('un load balancer posé devant le serveur prend sa place sur la route', () => {
    const arch = line();
    const next = ok(placeNode(arch, 'load-balancer', onPath(arch, 'src', 'app-server'), catalog));
    expect(pairs(next)).toContain('src→load-balancer');
    expect(pairs(next)).toContain('load-balancer→app-server');
    expect(pairs(next)).not.toContain('src→app-server');
  });

  it('un cache est consulté, pas traversé : il se branche à côté du lien vers la base', () => {
    const arch = line();
    const next = ok(placeNode(arch, 'cache', onPath(arch, 'app-server', 'db'), catalog));
    expect(pairs(next)).toContain('app-server→cache');
    expect(pairs(next)).toContain('app-server→db');
  });

  it('une passerelle d’API posée devant le serveur s’insère sur la route des clients (C7)', () => {
    const arch = line();
    const next = ok(placeNode(arch, 'api-gateway', onPath(arch, 'src', 'app-server'), catalog));
    expect(pairs(next)).toContain('src→api-gateway');
    expect(pairs(next)).toContain('api-gateway→app-server');
    expect(pairs(next)).not.toContain('src→app-server');
  });

  it('entre le CDN et le load balancer, la passerelle s’intercale ; entre le load balancer et un serveur mis à l’échelle, non (C7)', () => {
    let arch: Architecture = { nodes: [{ id: 'src', type: 'traffic-source', cell: { q: 0, r: 0 } }], links: [] };
    arch = ok(placeNode(arch, 'cdn', { q: 2, r: 0 }));
    arch = ok(placeNode(arch, 'load-balancer', { q: 6, r: 0 }));
    arch = ok(placeNode(arch, 'app-server', { q: 6, r: 4 }));
    arch = ok(placeNode(arch, 'database', { q: 3, r: 4 }));
    for (const [from, to] of [['src', 'cdn'], ['cdn', 'load-balancer'], ['load-balancer', 'app-server'], ['app-server', 'database']] as const) arch = ok(connect(arch, from, to));
    arch = { ...arch, nodes: arch.nodes.map((n) => (n.id === 'app-server' ? { ...n, upgrades: { 'horizontal-scaling': 2 } } : n)) };
    const front = ok(placeNode(arch, 'api-gateway', onPath(arch, 'cdn', 'load-balancer'), catalog));
    expect(pairs(front)).toEqual(['app-server→database', 'cdn→api-gateway', 'api-gateway→load-balancer', 'load-balancer→app-server', 'src→cdn'].sort());
    // Le scaling exige que tout le trafic du serveur vienne d'un load balancer : le lien reste.
    const behind = ok(placeNode(arch, 'api-gateway', onPath(arch, 'load-balancer', 'app-server'), catalog));
    expect(pairs(behind)).toEqual(pairs(arch));
  });

  it('un bâtiment qui ne peut pas s’intercaler laisse le lien et le fait contourner', () => {
    const arch = line();
    const cell = onPath(arch, 'app-server', 'db');
    // Une file ne peut pas alimenter une base : le chemin fait un détour.
    const next = ok(placeNode(arch, 'message-queue', cell, catalog));
    expect(pairs(next)).toEqual(pairs(arch));
    expect(next.links.find((l) => l.to === 'db')!.path!.some((c) => hexKey(c) === hexKey(cell))).toBe(false);
  });
});

describe('le consommateur d’une file (ticket n° 1)', () => {
  const start: Architecture = { nodes: [{ id: 'src', type: 'traffic-source', cell: { q: 0, r: 0 } }], links: [] };
  const built = (type: string) => {
    let arch = ok(placeNode(start, 'message-queue', { q: 3, r: 0 }));
    arch = ok(placeNode(arch, type, { q: 5, r: 0 }));
    return arch;
  };

  it('relier une file à un serveur d’application est refusé, avec la raison', () => {
    const r = connect(built('app-server'), 'message-queue', 'app-server', catalog);
    expect(r).toEqual({ ok: false, reason: 'Message queue ne peut pas alimenter Application server : une file se vide par un worker, pas par un serveur d’application ni une base.' });
  });

  it('un pub/sub non plus', () => {
    let arch = ok(placeNode(start, 'pubsub', { q: 3, r: 0 }));
    arch = ok(placeNode(arch, 'app-server', { q: 5, r: 0 }));
    const r = connect(arch, 'pubsub', 'app-server', catalog);
    expect(r.ok).toBe(false);
  });

  it('une file se relie à un worker', () => {
    expect(connect(built('worker'), 'message-queue', 'worker', catalog).ok).toBe(true);
  });
});
