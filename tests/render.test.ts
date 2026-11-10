import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import { HEX_WIDTH, hexAt, hexCenter, hexDistance, hexKey, hexLine, nearestFree } from '../src/render/hex.ts';
import { layoutArchitecture, pathLength, pointAlong } from '../src/render/layout.ts';
import { journeyAt, journeyDuration, journeysForTick, outcomeOf, trafficScale, tripDuration, type Journey } from '../src/render/traffic.ts';

describe('layoutArchitecture', () => {
  it('range les nœuds en colonnes selon leur profondeur', () => {
    const l = layoutArchitecture(A.scaled(3));
    expect(l.nodes.src!.x).toBeLessThan(l.nodes.lb!.x);
    expect(l.nodes.lb!.x).toBeLessThan(l.nodes.app!.x);
    // Le cache et la base sont tous deux juste après le serveur, à une case près : le calage
    // sur la grille peut décaler un nœud vers la case libre voisine.
    expect(Math.abs(l.nodes.cache!.x - l.nodes.db!.x)).toBeLessThanOrEqual(HEX_WIDTH);
    expect(l.nodes.cache!.z).not.toBe(l.nodes.db!.z);
  });

  it('trace une route par lien, avec la clé des ticks', () => {
    const l = layoutArchitecture(A.queuedClicks(0));
    expect(l.roads.map((r) => r.key).sort()).toEqual(A.queuedClicks(0).links.map((x) => `${x.from}→${x.to}`).sort());
  });

  it('place le worker après la file', () => {
    const l = layoutArchitecture(A.queuedClicks(0));
    expect(l.nodes.worker!.x).toBeGreaterThan(l.nodes.queue!.x);
  });
});

describe('grille hexagonale', () => {
  it('retrouve la case de son propre centre', () => {
    for (const h of [{ q: 0, r: 0 }, { q: 3, r: -2 }, { q: -4, r: 5 }]) expect(hexAt(hexCenter(h))).toEqual(h);
  });

  it('trace une ligne de cases adjacentes', () => {
    const line = hexLine({ q: 0, r: 0 }, { q: 4, r: -3 });
    expect(line[0]).toEqual({ q: 0, r: 0 });
    expect(line.at(-1)).toEqual({ q: 4, r: -3 });
    for (let i = 1; i < line.length; i++) expect(hexDistance(line[i - 1]!, line[i]!)).toBe(1);
  });

  it('trouve la case libre la plus proche', () => {
    const taken = new Set([hexKey({ q: 0, r: 0 })]);
    const free = nearestFree({ q: 0, r: 0 }, taken);
    expect(hexDistance(free, { q: 0, r: 0 })).toBe(1);
  });

  it('place chaque nœud sur sa propre case, et chaque lien sur des cases adjacentes', () => {
    const l = layoutArchitecture(A.queuedClicks(3));
    const keys = Object.values(l.cells).map(hexKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const road of l.roads) {
      expect(road.cells[0]).toEqual(l.cells[road.from]);
      expect(road.cells.at(-1)).toEqual(l.cells[road.to]);
      for (let i = 1; i < road.cells.length; i++) expect(hexDistance(road.cells[i - 1]!, road.cells[i]!)).toBe(1);
    }
  });
});

describe('chemins', () => {
  it('suit le chemin à la bonne distance', () => {
    const p = [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }];
    expect(pathLength(p)).toBe(4);
    expect(pointAlong(p, 0.5).point).toEqual({ x: 2, z: 0 });
    expect(pointAlong(p, 1).point).toEqual({ x: 2, z: 2 });
    expect(pointAlong(p, 0).point).toEqual({ x: 0, z: 0 });
  });
});

describe('trajets', () => {
  const result = simulateWave(A.scaled(3), urlShortener.waves[2]!, catalog);
  const scale = trafficScale(result.ticks);
  const linkFrom = (link: string) => link.split('→')[0]!;
  const linkTo = (link: string) => link.split('→')[1]!;

  /** Les tronçons s'enchaînent : chacun part de là où le précédent est arrivé. */
  function chained(j: Journey): boolean {
    let at = linkFrom(j.legs[0]!.link);
    for (const leg of j.legs) {
      const [a, b] = leg.back ? [linkTo(leg.link), linkFrom(leg.link)] : [linkFrom(leg.link), linkTo(leg.link)];
      if (a !== at) return false;
      at = b;
    }
    return true;
  }

  it('part des hameaux, va jusqu’au bâtiment qui sert la requête, et revient aux hameaux', () => {
    const journeys = journeysForTick(result.ticks[0]!, 0, scale).filter((j) => j.kind === 'read' && !j.failedFrom);
    expect(journeys.length).toBeGreaterThan(0);
    for (const j of journeys) {
      expect(chained(j)).toBe(true);
      expect(linkFrom(j.legs[0]!.link)).toBe('src');
      expect(linkFrom(j.legs.at(-1)!.link)).toBe('src');
      const half = j.legs.length / 2;
      expect(j.legs.slice(0, half).every((l) => !l.back)).toBe(true);
      expect(j.legs.slice(half).every((l) => l.back)).toBe(true);
    }
  });

  it('une lecture va au carnet en cas de succès, aux archives en cas d’absence, dans les bonnes proportions', () => {
    const ends = result.ticks
      .flatMap((t, i) => journeysForTick(t, i, scale))
      .filter((j) => j.kind === 'read' && !j.failedFrom)
      .map((j) => linkTo(j.legs[j.legs.length / 2 - 1]!.link));
    const hits = ends.filter((e) => e === 'cache').length;
    const misses = ends.filter((e) => e === 'db').length;
    expect(hits + misses).toBe(ends.length);
    // 95 % de succès dans le catalogue : les absences sont rares mais présentes.
    expect(hits / ends.length).toBeGreaterThan(0.85);
    expect(misses).toBeGreaterThan(0);
  });

  it('un clic async part sans revenir', () => {
    const clicks = simulateWave(A.queuedClicks(4), urlShortener.waves[4]!, catalog);
    const journeys = journeysForTick(clicks.ticks[0]!, 0, trafficScale(clicks.ticks)).filter((j) => j.kind === 'async');
    expect(journeys.length).toBeGreaterThan(0);
    expect(journeys.every((j) => j.legs.every((l) => !l.back) && chained(j))).toBe(true);
    expect(journeys.some((j) => j.legs.some((l) => l.link === 'app→queue'))).toBe(true);
  });

  it('une requête refusée fait demi-tour depuis le bâtiment qui la refuse', () => {
    const lost = simulateWave(A.scaled(1), urlShortener.waves[2]!, catalog);
    const failed = journeysForTick(lost.ticks[30]!, 30, trafficScale(lost.ticks)).filter((j) => j.failedFrom !== undefined && !j.hostile);
    expect(failed.length).toBeGreaterThan(0);
    for (const j of failed) {
      expect(chained(j)).toBe(true);
      expect(j.legs.length).toBe(j.failedFrom! * 2);
      // Le refus a lieu au bout de l'aller : c'est le bâtiment saturé.
      expect(lost.ticks[30]!.nodes[linkTo(j.legs[j.failedFrom! - 1]!.link)]!.failed).toBeGreaterThan(0);
    }
  });

  it('les pillards sont refoulés à la porte qui les limite', () => {
    const limited = simulateWave(A.scaled(3, { rateLimitTier: A.TIER_40 }), urlShortener.waves[3]!, catalog);
    const hostiles = journeysForTick(limited.ticks[10]!, 10, trafficScale(limited.ticks)).filter((j) => j.hostile);
    expect(hostiles.length).toBeGreaterThan(0);
    expect(hostiles.every((j) => j.legs.map((l) => l.link).join() === 'src→lb,src→lb' && j.failedFrom === 1)).toBe(true);
  });

  it('suit le voyageur tronçon par tronçon, et le retourne au retour', () => {
    const j: Journey = { kind: 'read', start: 2, legs: [{ link: 'a→b', back: false, duration: 1 }, { link: 'a→b', back: true, duration: 1 }] };
    expect(journeyDuration(j)).toBe(2);
    expect(journeyAt(j, 1.9)).toBeUndefined();
    expect(journeyAt(j, 2.25)).toEqual({ link: 'a→b', f: 0.25, returning: false, failed: false });
    expect(journeyAt(j, 3.25)).toEqual({ link: 'a→b', f: 0.75, returning: true, failed: false });
    expect(journeyAt(j, 4)).toBeUndefined();
    expect(journeyAt({ ...j, failedFrom: 1 }, 3.5)?.failed).toBe(true);
  });

  it('donne l’issue d’un trajet : +1 aux hameaux au retour, −1 là où la requête est refusée', () => {
    const legs = [
      { link: 'src→app', back: false, duration: 1 },
      { link: 'app→cache', back: false, duration: 0.5 },
      { link: 'app→cache', back: true, duration: 0.5 },
      { link: 'src→app', back: true, duration: 1 },
    ];
    // Servie : le +1 apparaît aux hameaux, quand la réponse revient.
    expect(outcomeOf({ kind: 'read', start: 3, legs })).toEqual({ node: 'src', at: 6, result: 'served' });
    // Un async ne revient pas : il compte au bout de son aller.
    expect(outcomeOf({ kind: 'async', start: 3, legs: legs.slice(0, 2) })).toEqual({ node: 'cache', at: 4.5, result: 'served' });
    expect(outcomeOf({ kind: 'read', start: 3, legs: [legs[0]!, legs[3]!], failedFrom: 1 })).toEqual({ node: 'app', at: 4, result: 'refused' });
    expect(outcomeOf({ kind: 'read', start: 0, legs: [legs[0]!, legs[3]!], failedFrom: 1, hostile: true })?.result).toBe('repelled');
  });

  it('ralentit les voyageurs vers un nœud lent', () => {
    expect(tripDuration(200)).toBeGreaterThan(tripDuration(10));
    expect(tripDuration(10_000)).toBe(3);
  });

  it('le pic de la campagne fait partir bien plus de voyageurs que le calme', () => {
    const counts = result.ticks.map((t, i) => journeysForTick(t, i, scale).length);
    expect(Math.max(...counts)).toBeGreaterThan(counts[0]! * 2);
  });
});

describe('trajets des incidents du grand marché', () => {
  const journeysOf = async (archOpts: { idempotence?: boolean; outbox?: boolean }, waveId: string) => {
    const { market } = await import('../src/data/scenarios/market.ts');
    const M = await import('../src/data/scenarios/market.archetypes.ts');
    const result = simulateWave(M.fannedOut(archOpts), market.waves.find((w) => w.id === waveId)!, catalog);
    const scale = trafficScale(result.ticks);
    return result.ticks.flatMap((t, i) => journeysForTick(t, i, scale));
  };

  it('un message livré deux fois a sa copie, traitée ou écartée selon l’idempotence', async () => {
    const without = await journeysOf({}, 'double-delivery');
    expect(without.some((j) => j.copy === 'twice')).toBe(true);
    expect(without.some((j) => j.copy === 'ignored')).toBe(false);
    const copy = without.find((j) => j.copy)!;
    expect(outcomeOf(copy)!.result).toBe('twice');
    expect(journeyAt(copy, copy.start + 0.01)!.split).toBeGreaterThanOrEqual(0);
    const withIt = await journeysOf({ idempotence: true }, 'double-delivery');
    expect(withIt.some((j) => j.copy === 'ignored')).toBe(true);
  });

  it('un événement perdu s’évapore à mi-chemin et compte comme un refus du serveur', async () => {
    const lost = (await journeysOf({ idempotence: true }, 'lost-orders')).find((j) => j.lost)!;
    expect(lost).toBeDefined();
    const last = lost.legs.at(-1)!;
    expect(journeyDuration(lost)).toBeCloseTo(lost.legs.slice(0, -1).reduce((a, l) => a + l.duration, 0) + last.duration / 2);
    expect(journeyAt(lost, lost.start + journeyDuration(lost) - 0.01)!.vanish).toBeGreaterThan(0.9);
    expect(outcomeOf(lost)).toMatchObject({ result: 'refused', node: last.link.split('→')[0] });
    expect((await journeysOf({ idempotence: true, outbox: true }, 'lost-orders')).some((j) => j.lost)).toBe(false);
  });

  it('une requête refusée rebondit à la porte avant de repartir', () => {
    const j: Journey = { kind: 'read', start: 0, legs: [{ link: 'a→b', back: false, duration: 1 }, { link: 'a→b', back: true, duration: 1 }], failedFrom: 1 };
    expect(journeyAt(j, 1.1)!.bounce).toBeCloseTo(0.4);
    expect(journeyAt(j, 1.5)!.bounce).toBeUndefined();
  });
});
