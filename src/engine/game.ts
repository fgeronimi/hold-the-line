import { scoreWave, type Scoring } from './score.ts';
import { simulateWave } from './simulate.ts';
import type { Architecture, Catalog, Scenario, WaveResult } from './types.ts';

export interface GameState {
  waveIndex: number;
  /** Architecture de fin de la dernière vague gagnée : point de départ de la suivante et de ses rejeux. */
  committed: Architecture;
  /** Vagues perdues sur la vague en cours. */
  replays: number;
  scores: number[];
  finished: boolean;
}

export function newGame(): GameState {
  return { waveIndex: 0, committed: { nodes: [], links: [] }, replays: 0, scores: [], finished: false };
}

/**
 * Décision E4 : une vague perdue se rejoue sans limite depuis `committed` ;
 * seule la victoire fait avancer la partie.
 */
export function playWave(
  state: GameState,
  scenario: Scenario,
  arch: Architecture,
  catalog: Catalog,
  scoring: Scoring,
): { state: GameState; result: WaveResult; score: number } {
  const wave = scenario.waves[state.waveIndex];
  if (state.finished || !wave) throw new Error('La partie est terminée');

  const result = simulateWave(arch, wave, catalog, state.committed);
  if (!result.won) {
    return { state: { ...state, replays: state.replays + 1 }, result, score: 0 };
  }

  const score = scoreWave(result, state.replays, scoring);
  const waveIndex = state.waveIndex + 1;
  return {
    state: {
      waveIndex,
      committed: arch,
      replays: 0,
      scores: [...state.scores, score],
      finished: waveIndex >= scenario.waves.length,
    },
    result,
    score,
  };
}
