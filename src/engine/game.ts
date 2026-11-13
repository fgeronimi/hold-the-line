import { scoreWave, starCount, starsFor, type Scoring } from './score.ts';
import { simulateWave } from './simulate.ts';
import type { Architecture, Catalog, Scenario, WaveResult } from './types.ts';

export interface GameState {
  waveIndex: number;
  /** Architecture de fin de la dernière vague gagnée : point de départ de la suivante et de ses rejeux. */
  committed: Architecture;
  /** `history[i]` : architecture validée au début de la vague i, pour pouvoir y revenir. */
  history: Architecture[];
  /** Vagues perdues sur la vague en cours. */
  replays: number;
  scores: number[];
  /** Étoiles gagnées par vague tenue, de 1 à 3. */
  stars: number[];
  finished: boolean;
  /**
   * Indices déjà donnés sur la vague en cours, par leur clé (`src/ui/hints.ts`). Optionnel,
   * lu avec `?? []` : une sauvegarde d'avant l'aide reste valide sans changer de clé.
   */
  hints?: string[];
}

const EMPTY: Architecture = { nodes: [], links: [] };

export function newGame(): GameState {
  return { waveIndex: 0, committed: EMPTY, history: [EMPTY], replays: 0, scores: [], stars: [], finished: false, hints: [] };
}

/**
 * Indices qu'on peut encore demander sur la vague en cours : un par essai perdu (décision
 * I14). L'aide ne coûte rien de plus que l'essai perdu qui l'a ouverte, que E5 pénalise déjà.
 */
export function hintsLeft(state: GameState): number {
  if (state.finished) return 0;
  return Math.max(0, state.replays - (state.hints?.length ?? 0));
}

/** Garde un indice donné ; sans droit restant, ou déjà donné, rien ne change. */
export function withHint(state: GameState, key: string): GameState {
  const given = state.hints ?? [];
  if (hintsLeft(state) <= 0 || given.includes(key)) return state;
  return { ...state, hints: [...given, key] };
}

/**
 * Revenir au début d'une vague déjà jouée, avec l'architecture validée à ce moment-là.
 * Sans ça, un choix passé peut rendre une vague impossible à gagner, et la partie bloque
 * (un CDN posé en vague 3 rend la vague 5 ingagnable). Le retour compte comme un rejeu
 * de la vague visée : le choix passé se paie, mais ne bloque plus.
 */
export function rewindTo(state: GameState, waveIndex: number): GameState {
  const committed = state.history[waveIndex];
  if (!committed || waveIndex > state.waveIndex) throw new Error(`Vague ${waveIndex + 1} pas encore atteinte`);
  return {
    waveIndex,
    committed,
    history: state.history.slice(0, waveIndex + 1),
    replays: 1,
    scores: state.scores.slice(0, waveIndex),
    stars: state.stars.slice(0, waveIndex),
    finished: false,
    hints: [],
  };
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

  const result = simulateWave(arch, wave, catalog);
  if (!result.won) {
    return { state: { ...state, replays: state.replays + 1 }, result, score: 0 };
  }

  const score = scoreWave(result, state.replays, scoring);
  const waveIndex = state.waveIndex + 1;
  return {
    state: {
      waveIndex,
      committed: arch,
      history: [...state.history, arch],
      replays: 0,
      scores: [...state.scores, score],
      stars: [...state.stars, starCount(starsFor(result, state.replays, wave))],
      finished: waveIndex >= scenario.waves.length,
      hints: [],
    },
    result,
    score,
  };
}
