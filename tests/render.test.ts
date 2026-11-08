import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import { layoutArchitecture, pathLength, pointAlong, roadPath } from '../src/render/layout.ts';
import { failuresForTick, progressAt, trafficScale, tripDuration, vehiclesForTick } from '../src/render/traffic.ts';

describe('layoutArchitecture', () => {
  it('range les nœuds en colonnes selon leur profondeur', () => {
    const l = layoutArchitecture(A.scaled(3));
    expect(l.nodes.src!.x).toBeLessThan(l.nodes.lb!.x);
    expect(l.nodes.lb!.x).toBeLessThan(l.nodes.app!.x);
    // Le cache et la base sont tous deux juste après le serveur.
    expect(l.nodes.cache!.x).toBe(l.nodes.db!.x);
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

describe('chemins', () => {
  it('fait une baïonnette entre deux nœuds décalés', () => {
    const p = roadPath({ x: 0, z: 0 }, { x: 4, z: 2 });
    expect(p).toEqual([{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 4, z: 2 }]);
    expect(pathLength(p)).toBe(6);
  });

  it('suit le chemin à la bonne distance', () => {
    const p = roadPath({ x: 0, z: 0 }, { x: 4, z: 2 });
    expect(pointAlong(p, 0.5).point).toEqual({ x: 2, z: 1 });
    expect(pointAlong(p, 1).point).toEqual({ x: 4, z: 2 });
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
