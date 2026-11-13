import { simulateWave } from '../engine/simulate.ts';
import type { Catalog, Scenario, WaveResult } from '../engine/types.ts';
import { choiceKey, enumerate, maxedChoice, reductions, strategyName, strategyParts, type BalanceSpace, type Choice } from './canonical.ts';

export interface StrategyGroup {
  strategy: string;
  parts: string[];
  winners: number;
  /**
   * Décision B2 : chaque architecture gagnante du groupe gagne encore une fois privée
   * d'un de ses éléments, qui ne sert donc à rien sur cette vague. Nomme le groupe
   * obtenu par ce retrait.
   */
  dominatedBy?: string;
  best: { choice: Choice; score: number; result: WaveResult };
}

export interface WaveReport {
  waveId: string;
  singleStrategy: boolean;
  candidates: number;
  /** Groupes gagnants, du meilleur score au moins bon. */
  groups: StrategyGroup[];
  /** Stratégies non dominées : les seules qui comptent pour le critère B1 (décision B2). */
  strategies: string[];
  /** Critère B1 : deux stratégies distinctes, sauf vague déclarée à réponse unique. */
  meetsStrategyCriterion: boolean;
}

export interface MassSimReport {
  waves: WaveReport[];
  /** Critère de sortie : aucune architecture ne doit gagner toutes les vagues. */
  universalWinners: Choice[];
  /** Critère B1 : au moins deux stratégies non dominées sur la majorité des vagues. */
  majorityHasTwoStrategies: boolean;
  /** Critère de sortie : l'architecture au maximum de tout perd chaque vague par le coût ou la complexité. */
  overprovisioned: { waveId: string; lossReasons: string[]; losesOnBudget: boolean }[];
}

/**
 * Joue chaque architecture canonique sur chaque vague, isolément : démolir est gratuit
 * (E8), une vague ne dépend donc pas de la précédente. On mesure ce qui peut gagner.
 */
/**
 * La qualité d'une gagnante, pour classer les stratégies entre elles : 100 × la moyenne de ses
 * marges bornées. Le jeu n'a plus de score (E9) ; l'équilibrage garde cette mesure pour ordonner.
 */
function quality(result: WaveResult): number {
  if (!result.won) return 0;
  const margins = Object.values(result.gauges).map((g) => Math.min(1, Math.max(0, g.margin)));
  return (100 * margins.reduce((a, m) => a + m, 0)) / margins.length;
}

export function runMassSim(scenario: Scenario, catalog: Catalog, space: BalanceSpace): MassSimReport {
  const candidates = [...enumerate(space)];
  const winsEverywhere = new Set(candidates.map((_, i) => i));

  // Gagnantes de chaque vague jouée sans `previous`, pour l'enchaînement.
  const waves = scenario.waves.map((wave): WaveReport => {
    const groups = new Map<string, StrategyGroup>();
    const winners = new Set<string>();
    const winningChoices = new Map<string, Choice[]>();
    candidates.forEach((c, i) => {
      const result = simulateWave(c.arch, wave, catalog);
      if (!result.won) {
        winsEverywhere.delete(i);
        return;
      }
      winners.add(choiceKey(space, c.choice));
      winningChoices.set(c.strategy, [...(winningChoices.get(c.strategy) ?? []), c.choice]);
      const score = quality(result);
      const group = groups.get(c.strategy);
      if (!group) {
        groups.set(c.strategy, {
          strategy: c.strategy,
          parts: c.parts,
          winners: 1,
          best: { choice: c.choice, score, result },
        });
      } else {
        group.winners++;
        if (score > group.best.score) group.best = { choice: c.choice, score, result };
      }
    });
    const sorted = [...groups.values()].sort((a, b) => b.best.score - a.best.score);
    for (const g of sorted) {
      let witness: Choice | undefined;
      const allReducible = (winningChoices.get(g.strategy) ?? []).every((choice) => {
        const reduced = reductions(space, choice).find((r) => winners.has(choiceKey(space, r)));
        witness ??= reduced;
        return reduced !== undefined;
      });
      if (allReducible && witness) g.dominatedBy = strategyName(strategyParts(space, witness));
    }
    const singleStrategy = wave.singleStrategy ?? false;
    const strategies = sorted.filter((g) => !g.dominatedBy).map((g) => g.strategy);
    return {
      waveId: wave.id,
      singleStrategy,
      candidates: candidates.length,
      groups: sorted,
      strategies,
      meetsStrategyCriterion: singleStrategy ? strategies.length === 1 : strategies.length >= 2,
    };
  });

  const withTwo = waves.filter((w) => w.strategies.length >= 2).length;
  return {
    waves,
    universalWinners: [...winsEverywhere].map((i) => candidates[i]!.choice),
    majorityHasTwoStrategies: withTwo > waves.length / 2,
    overprovisioned: scenario.waves.map((wave) => {
      const r = simulateWave(space.build(maxedChoice(space)), wave, catalog);
      return {
        waveId: wave.id,
        lossReasons: r.lossReasons,
        losesOnBudget: !r.won && (r.gauges.cost.margin < 0 || r.gauges.complexity.margin < 0),
      };
    }),
  };
}

