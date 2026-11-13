import { answersOf } from '../data/balance-space.ts';
import { CONCEPT_ACHIEVEMENTS, type Achievement } from '../data/achievements.ts';
import type { GameState } from '../engine/game.ts';
import { NO_STARS, starCount, type Stars } from '../engine/score.ts';
import { simulateWave } from '../engine/simulate.ts';
import type { Catalog, Scenario } from '../engine/types.ts';
import { earned } from './achievements.ts';

/** Ce que le bilan dit d'une vague tenue. */
export interface WaveReview {
  index: number;
  title: string;
  stars: Stars;
  /** Les notions dont la parade a joué dans l'architecture validée à la fin de la vague. */
  applied: Achievement[];
  /** Celles qu'aucune vague précédente n'avait appliquées : ce que la vague a ajouté. */
  fresh: Achievement[];
  /** Les notions qu'apportent les autres réponses attendues, et pas celle du joueur. */
  alternatives: Achievement[];
}

export interface ScenarioReview {
  waves: WaveReview[];
  stars: number;
  maxStars: number;
  /** Les vagues sans leurs trois étoiles : elles se rejouent (E10). */
  incomplete: WaveReview[];
}

const byId = new Map(CONCEPT_ACHIEVEMENTS.map((a) => [a.id, a]));
const concepts = (ids: Iterable<string>) => CONCEPT_ACHIEVEMENTS.filter((a) => new Set(ids).has(a.id));

/** Une simulation par vague : le bilan est gardé tant que la partie et le calibrage ne changent pas. */
const memo = new WeakMap<GameState, { scenario: Scenario; catalog: Catalog; review: ScenarioReview }>();

/**
 * Le bilan d'un scénario (P4) : vague par vague, ce que l'architecture validée a appliqué et ce
 * qui tenait aussi. On rejoue chaque vague sur `history[i + 1]`, l'architecture gagnante, plutôt
 * que de lire les succès gardés : un succès ne s'y inscrit qu'une fois, dans le premier scénario
 * où il a été gagné.
 */
export function scenarioReview(game: GameState, scenario: Scenario, catalog: Catalog): ScenarioReview {
  const known = memo.get(game);
  if (known && known.scenario === scenario && known.catalog === catalog) return known.review;
  const waves = game.stars.map((stars, index): WaveReview => {
    const wave = scenario.waves[index]!;
    const arch = game.history[index + 1]!;
    const mine = new Set(earned(simulateWave(arch, wave, catalog), arch, wave, catalog));
    const others = new Set<string>();
    for (const answer of answersOf(scenario.id, index)) {
      for (const id of earned(simulateWave(answer, wave, catalog), answer, wave, catalog)) if (!mine.has(id) && byId.has(id)) others.add(id);
    }
    return { index, title: wave.title, stars: stars ?? NO_STARS, applied: concepts(mine), fresh: [], alternatives: concepts(others) };
  });
  const seen = new Set<string>();
  for (const w of waves) {
    w.fresh = w.applied.filter((a) => !seen.has(a.id));
    for (const a of w.applied) seen.add(a.id);
  }
  const review = {
    waves,
    stars: waves.reduce((a, w) => a + starCount(w.stars), 0),
    maxStars: scenario.waves.length * 3,
    incomplete: waves.filter((w) => starCount(w.stars) < 3),
  };
  memo.set(game, { scenario, catalog, review });
  return review;
}
