import { describe, expect, it } from 'vitest';
import { balanceSpaces } from '../src/data/balance-space.ts';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { newGame, playWave } from '../src/engine/game.ts';
import { starCount, starsFor } from '../src/engine/score.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import type { FailureReason, Incident, Wave } from '../src/engine/types.ts';

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

  it('un incident ne coûte rien à une réponse attendue, sauf le prix que sa parade annonce (X12)', () => {
    // Un disjoncteur coupe des appels, une file des lettres mortes met des messages de côté :
    // c'est ce qu'ils annoncent. Toute autre perte due à l'incident serait une parade qui ne
    // suffit pas, ou une vague tenue de justesse sans elle.
    const price: FailureReason[] = ['circuit-open', 'dead-lettered'];
    for (const { scenario, space } of balanceSpaces) {
      for (const w of scenario.waves.filter((x) => x.incidents?.length)) {
        for (const choice of w.answers ?? []) {
          const arch = space.build(choice);
          const hit = simulateWave(arch, w, catalog);
          const calm = simulateWave(arch, withIncidents(w, []), catalog);
          const label = `${scenario.id} ${w.id} ${JSON.stringify(choice)}`;
          expect(hit.won, label).toBe(true);
          if (hit.gauges.failureRate.value - calm.gauges.failureRate.value < 1e-9) continue;
          const lost = (Object.keys(hit.failuresByReason) as FailureReason[]).filter((k) => hit.failuresByReason[k] - calm.failuresByReason[k] > 1e-6);
          expect(lost.filter((k) => !price.includes(k)), label).toEqual([]);
        }
      }
    }
  });

  it('sans sa parade, un incident fait perdre la vague (X12)', () => {
    expect(simulateWave(A.withCache, wave('read-surge'), catalog).won).toBe(false);
    expect(simulateWave(A.withCache, withIncidents(wave('read-surge'), []), catalog).won).toBe(true);
    expect(simulateWave(A.withCdn(), wave('marketing-peak'), catalog).won).toBe(false);
    expect(simulateWave(A.withCdn(), withIncidents(wave('marketing-peak'), []), catalog).won).toBe(true);
  });
});

describe('étoiles', () => {
  it('une par objectif : tenir, rien de superflu, sous le seuil d’économie', () => {
    const r = simulateWave(A.withLockedCache, wave('read-surge'), catalog);
    expect(starsFor(r, A.withLockedCache, wave('read-surge'), catalog)).toEqual({ held: true, lean: true, thrifty: true });
    // Le réplica tient sans rien de trop, mais coûte plus que le seuil d'économie.
    const replica = simulateWave(A.withReplica, wave('read-surge'), catalog);
    expect(starsFor(replica, A.withReplica, wave('read-surge'), catalog)).toEqual({ held: true, lean: true, thrifty: false });
    expect(starCount(starsFor(replica, A.withReplica, wave('read-surge'), catalog))).toBe(2);
  });

  it('la partie garde les étoiles de chaque vague tenue', () => {
    const { state } = playWave(newGame(), urlShortener, A.minimal, catalog);
    expect(state.stars).toEqual([{ held: true, lean: true, thrifty: true }]);
  });
});
