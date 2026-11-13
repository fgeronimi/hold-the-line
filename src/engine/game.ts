import { bestStars, NO_STARS, starsFor, type Stars } from './score.ts';
import { simulateWave } from './simulate.ts';
import type { Architecture, Catalog, Scenario, WaveResult } from './types.ts';

export interface GameState {
  waveIndex: number;
  /** Architecture de fin de la dernière vague gagnée : point de départ de la suivante. */
  committed: Architecture;
  /** `history[i]` : architecture validée au début de la vague i, d'où se rejoue la vague i. */
  history: Architecture[];
  /** Essais perdus sur la vague en cours : chacun ouvre un indice (I14). */
  replays: number;
  /** Les meilleures étoiles de chaque vague tenue, objectif par objectif (E7). */
  stars: Stars[];
  finished: boolean;
  /**
   * Indices déjà donnés sur la vague en cours, par leur clé (`src/ui/hints.ts`). Optionnel,
   * lu avec `?? []` : une sauvegarde d'avant l'aide reste valide sans changer de clé.
   */
  hints?: string[];
  /** Un indice a été pris dans cette partie : le succès « sans indice » du scénario est perdu. */
  hinted?: boolean;
}

const EMPTY: Architecture = { nodes: [], links: [] };

export function newGame(): GameState {
  return { waveIndex: 0, committed: EMPTY, history: [EMPTY], replays: 0, stars: [], finished: false, hints: [] };
}

/** Indices qu'on peut encore demander sur la vague en cours : un par essai perdu (décision I14). */
export function hintsLeft(state: GameState): number {
  if (state.finished) return 0;
  return Math.max(0, state.replays - (state.hints?.length ?? 0));
}

/** Garde un indice donné ; sans droit restant, ou déjà donné, rien ne change. */
export function withHint(state: GameState, key: string): GameState {
  const given = state.hints ?? [];
  if (hintsLeft(state) <= 0 || given.includes(key)) return state;
  return { ...state, hints: [...given, key], hinted: true };
}

/**
 * Décision E4 : une vague perdue se rejoue sans limite depuis `committed` ;
 * seule la victoire fait avancer la partie. Perdre ne coûte rien (E9) : on n'y gagne que le
 * droit à un indice.
 */
export function playWave(
  state: GameState,
  scenario: Scenario,
  arch: Architecture,
  catalog: Catalog,
): { state: GameState; result: WaveResult; stars: Stars } {
  const wave = scenario.waves[state.waveIndex];
  if (state.finished || !wave) throw new Error('La partie est terminée');

  const result = simulateWave(arch, wave, catalog);
  if (!result.won) return { state: { ...state, replays: state.replays + 1 }, result, stars: NO_STARS };

  const stars = starsFor(result, arch, wave, catalog);
  const waveIndex = state.waveIndex + 1;
  return {
    state: {
      ...state,
      waveIndex,
      committed: arch,
      history: [...state.history, arch],
      replays: 0,
      stars: [...state.stars, stars],
      finished: waveIndex >= scenario.waves.length,
      hints: [],
    },
    result,
    stars,
  };
}

/**
 * Rejouer une vague déjà tenue (décision E10), sans rien effacer : une partie de travail,
 * placée au début de la vague k avec l'architecture validée alors. Ses indices et ses essais
 * perdus restent les siens ; la vraie partie n'en retient que les étoiles (`withReplayedStars`).
 */
export function practiceGame(state: GameState, k: number): GameState {
  if (k < 0 || k >= state.waveIndex) throw new Error(`Vague ${k + 1} pas encore tenue`);
  return {
    ...state,
    waveIndex: k,
    committed: state.history[k]!,
    history: state.history.slice(0, k + 1),
    replays: 0,
    stars: state.stars.slice(0, k),
    finished: false,
    hints: [],
  };
}

/** La vraie partie après un rejeu gagné de la vague k : chaque objectif atteint une fois le reste. */
export function withReplayedStars(state: GameState, k: number, stars: Stars): GameState {
  return { ...state, stars: state.stars.map((s, i) => (i === k ? bestStars(s, stars) : s)) };
}
