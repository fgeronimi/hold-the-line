import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import { HEX_WIDTH, hexAt, hexCenter, hexDistance, hexKey, hexLine, nearestFree } from '../src/render/hex.ts';
import { layoutArchitecture, pathLength, pointAlong } from '../src/render/layout.ts';
import { failuresForTick, isReturning, progressAt, trafficScale, tripDuration, vehiclesForTick } from '../src/render/traffic.ts';

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

describe('trafic', () => {
  const result = simulateWave(A.scaled(3), urlShortener.waves[2]!, catalog);
  const scale = trafficScale(result.ticks);

  it('donne au lien le plus chargé le maximum de véhicules', () => {
    const counts = result.ticks.map((t, i) => vehiclesForTick(t, i, scale, new Set()).length);
    // Le pic de la campagne (×5) fait partir bien plus de véhicules que le calme.
    expect(Math.max(...counts)).toBeGreaterThan(counts[0]! * 2);
    for (const t of result.ticks) {
      for (const v of vehiclesForTick(t, 0, scale, new Set())) expect(v.start).toBeLessThan(1);
    }
  });

  it('montre au moins un véhicule sur un lien peu utilisé', () => {
    const tick = { ...result.ticks[0]!, links: { 'app→db': { write: 0.001 } } };
    expect(vehiclesForTick(tick, 0, scale, new Set())).toHaveLength(1);
  });

  it('ralentit les véhicules vers un nœud lent', () => {
    expect(tripDuration(200)).toBeGreaterThan(tripDuration(10));
    expect(tripDuration(10_000)).toBe(3);
  });

  it('fait faire l’aller-retour aux consultations du cache', () => {
    const tick = result.ticks[0]!;
    const toCache = vehiclesForTick(tick, 0, scale, new Set(['app→cache'])).find((v) => v.link === 'app→cache')!;
    expect(toCache.roundTrip).toBe(true);
    expect(progressAt(toCache, toCache.start + toCache.duration * 0.5)).toBeCloseTo(0.5);
    expect(progressAt(toCache, toCache.start + toCache.duration * 1.5)).toBeCloseTo(0.5);
    expect(progressAt(toCache, toCache.start + toCache.duration * 2)).toBeUndefined();
    expect(progressAt(toCache, toCache.start - 0.1)).toBeUndefined();
    expect(isReturning(toCache, toCache.start + toCache.duration * 0.5)).toBe(false);
    expect(isReturning(toCache, toCache.start + toCache.duration * 1.5)).toBe(true);
  });

  it('fait faire demi-tour aux requêtes en échec, sur la route d’arrivée la plus chargée', () => {
    const lost = simulateWave(A.scaled(1), urlShortener.waves[2]!, catalog);
    const peak = lost.ticks[30]!;
    const wrecks = failuresForTick(peak, 30, trafficScale(lost.ticks));
    expect(wrecks.length).toBeGreaterThan(0);
    expect(wrecks.every((v) => v.failed && v.roundTrip && v.link === 'lb→app')).toBe(true);
    expect(failuresForTick(result.ticks[0]!, 0, scale)).toEqual([]);
  });

  it('repousse le trafic abusif à la porte qui le limite', () => {
    const limited = simulateWave(A.scaled(3, { rateLimitTier: A.TIER_40 }), urlShortener.waves[3]!, catalog);
    const tick = limited.ticks[10]!;
    expect(tick.nodes.lb!.shed).toBeGreaterThan(0);
    const hostiles = failuresForTick(tick, 10, trafficScale(limited.ticks)).filter((v) => v.hostile);
    expect(hostiles.length).toBeGreaterThan(0);
    expect(hostiles.every((v) => v.link === 'src→lb' && v.roundTrip)).toBe(true);
  });
});
