import type { Wave, WaveResult } from './types.ts';

export interface Scoring {
  /** Points d'une vague gagnée avec une marge pleine sur toutes les jauges. */
  maxPoints: number;
  /** Part du score retirée par vague perdue avant la victoire. */
  replayPenalty: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Décision E5 : moyenne des marges bornées, moins une pénalité par rejeu. */
export function scoreWave(result: WaveResult, replays: number, scoring: Scoring): number {
  if (!result.won) return 0;
  const margins = Object.values(result.gauges).map((g) => clamp01(g.margin));
  const mean = margins.reduce((a, m) => a + m, 0) / margins.length;
  return scoring.maxPoints * mean * Math.max(0, 1 - scoring.replayPenalty * replays);
}

/** Les trois objectifs d'une vague (décision E7), chacun vaut une étoile. */
export interface Stars {
  held: boolean;
  firstTry: boolean;
  thrifty: boolean;
}

export function starsFor(result: WaveResult, replays: number, wave: Wave): Stars {
  const held = result.won;
  return {
    held,
    firstTry: held && replays === 0,
    thrifty: held && result.gauges.cost.value <= (wave.thriftyCost ?? wave.budget),
  };
}

export const starCount = (s: Stars) => Number(s.held) + Number(s.firstTry) + Number(s.thrifty);
