import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import { replayStats } from '../src/render/hud.ts';
import { JourneyWindow, OutcomeTally, RecentOutcomes, journeyDuration, journeysForTick, outcomeOf, trafficScale, type Outcome } from '../src/render/traffic.ts';

// Une vague chargée, avec refus et trajets de toutes sortes : de quoi comparer à l'ancien filtrage.
const result = simulateWave(A.scaled(1), urlShortener.waves[2]!, catalog);
const scale = trafficScale(result.ticks);
const timed = result.ticks.flatMap((t, i) => journeysForTick(t, i, scale)).map((j) => ({ j, end: j.start + journeyDuration(j) }));
const outcomes: Outcome[] = timed
  .map(({ j }) => outcomeOf(j))
  .filter((o): o is Outcome => o !== undefined)
  .sort((a, b) => a.at - b.at);

// L'ancien calcul, image par image : la référence.
const oldJourneys = (time: number) => timed.filter(({ j, end }) => j.start <= time && end > time).map(({ j }) => j);
const oldRecent = (time: number) => outcomes.filter((o) => o.at <= time && o.at > time - 1);
const oldStats = (time: number) => {
  const done = result.ticks.slice(0, Math.min(Math.floor(time) + 1, result.ticks.length));
  const last = done.at(-1);
  const counted = last?.countedSoFar ?? 0;
  const count = (r: Outcome['result']) => outcomes.filter((o) => o.result === r && o.at <= time).length;
  return {
    failureRate: counted > 0 ? last!.clientFailedSoFar / counted : 0,
    latencyMs: last?.slaLatencyMs ?? 0,
    served: count('served'),
    refused: count('refused'),
    repelled: count('repelled'),
  };
};

describe('sélection incrémentale du rejeu', () => {
  const journeys = new JourneyWindow(timed);
  const recent = new RecentOutcomes(outcomes);
  const tally = new OutcomeTally(outcomes);
  const check = (time: number) => {
    // Mêmes objets, même ordre que le filtre d'origine.
    const got = journeys.at(time);
    const want = oldJourneys(time);
    expect(got.length).toBe(want.length);
    expect(got.every((j, i) => j === want[i])).toBe(true);
    expect(recent.at(time)).toEqual(oldRecent(time));
    expect(replayStats(result, tally, time)).toEqual(oldStats(time));
  };

  it('a de quoi comparer : des trajets, des issues de plusieurs sortes', () => {
    expect(timed.length).toBeGreaterThan(200);
    expect(outcomes.some((o) => o.result === 'served')).toBe(true);
    expect(outcomes.some((o) => o.result === 'refused')).toBe(true);
  });

  it('donne les mêmes trajets, issues et compteurs à des instants croissants, puis après un saut en arrière', () => {
    const end = result.ticks.length;
    for (let t = 0; t <= end; t += 0.37) check(t);
    check(end);
    check(end);
    check(12.5);
    for (let t = 12.5; t <= end; t += 1) check(t);
    check(0);
    check(33);
    check(33);
    check(5.2);
    check(40);
  });

  it('compte comme avant avec un tableau d’issues non trié', () => {
    const shuffled = [...outcomes].reverse();
    for (const t of [0, 3.3, 20, 60]) expect(replayStats(result, shuffled, t)).toEqual(oldStats(t));
  });
});
