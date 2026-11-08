import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { scoring } from '../src/data/scoring.ts';
import { newGame, playWave } from '../src/engine/game.ts';
import { starCount, starsFor } from '../src/engine/score.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import type { Incident, Wave } from '../src/engine/types.ts';

const wave = (id: string) => urlShortener.waves.find((w) => w.id === id)!;
const launch = wave('launch');
const crash: Incident = { id: 'crash', title: 'Panne', component: 'app-server', from: 10, until: 12, effect: { type: 'instance-down', count: 1 } };
const withIncidents = (w: Wave, incidents: Incident[]): Wave => ({ ...w, incidents });

describe('incidents', () => {
  it('un serveur unique qui tombe ne sert plus rien pendant la panne', () => {
    const r = simulateWave(A.minimal, withIncidents(launch, [crash]), catalog);
    expect(r.ticks[10]!.nodes.app).toMatchObject({ down: 1, failed: 100 });
    expect(r.ticks[10]!.incidents).toEqual(['crash']);
    expect(r.ticks[12]!.nodes.app!.failed).toBe(0);
    expect(r.events.filter((e) => e.type.startsWith('incident'))).toEqual([
      { type: 'incident-start', tick: 10, incident: 'crash' },
      { type: 'incident-end', tick: 12, incident: 'crash' },
    ]);
  });

  it('une instance de plus encaisse la panne', () => {
    const r = simulateWave(A.scaled(1), withIncidents(launch, [crash]), catalog);
    expect(r.ticks[10]!.nodes.app!.failed).toBe(0);
  });

  it('un cache froid renvoie ses lectures vers la base, puis se réchauffe', () => {
    const cold: Incident = { id: 'cold', title: 'Cache froid', component: 'cache', from: 30, until: 33, effect: { type: 'cold-cache' } };
    const r = simulateWave(A.withCache, withIncidents(wave('read-surge'), [cold]), catalog);
    const toDb = (t: number) => r.ticks[t]!.links['app→db']!.read!;
    expect(toDb(30)).toBeCloseTo(900);
    expect(toDb(31)).toBeLessThan(toDb(30));
    expect(toDb(33)).toBeCloseTo(45);
  });

  it('les incidents du scénario n’empêchent pas les réponses attendues', () => {
    expect(simulateWave(A.withCache, wave('read-surge'), catalog).won).toBe(true);
    expect(simulateWave(A.withCdn(), wave('marketing-peak'), catalog).won).toBe(true);
  });
});

describe('étoiles', () => {
  it('une par objectif : tenir, du premier coup, sous le seuil d’économie', () => {
    const r = simulateWave(A.withCache, wave('read-surge'), catalog, A.minimal);
    expect(starsFor(r, 0, wave('read-surge'))).toEqual({ held: true, firstTry: true, thrifty: true });
    const replica = simulateWave(A.withReplica, wave('read-surge'), catalog, A.minimal);
    expect(starCount(starsFor(replica, 1, wave('read-surge')))).toBe(1);
  });

  it('la partie garde les étoiles de chaque vague tenue', () => {
    const { state } = playWave(newGame(), urlShortener, A.minimal, catalog, scoring);
    expect(state.stars).toEqual([3]);
  });
});
