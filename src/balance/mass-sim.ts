import { scoreWave, type Scoring } from '../engine/score.ts';
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

/** Un départ de l'enchaînement : une réponse attendue de la vague précédente. */
export interface ChainStart {
  /** Rang de la réponse dans `Wave.answers` de la vague précédente. */
  answerIndex: number;
  /** Architectures de l'espace qui gagnent la vague jouées depuis ce départ. */
  winners: number;
  /** La moins chère des gagnantes, migration comprise ; absente si aucune ne gagne. */
  cheapest?: { choice: Choice; cost: number; migration: number; limit: number };
}

export interface ChainReport {
  /** La vague jouée, et celle dont on part. */
  waveId: string;
  fromWaveId: string;
  starts: ChainStart[];
}

export interface MassSimReport {
  waves: WaveReport[];
  /**
   * Contrôle d'enchaînement (décision B7) : depuis chaque réponse attendue de la vague
   * n - 1, au moins une architecture de l'espace doit gagner la vague n.
   */
  chaining: ChainReport[];
  /** Critère de sortie : aucune architecture ne doit gagner toutes les vagues. */
  universalWinners: Choice[];
  /** Critère B1 : au moins deux stratégies non dominées sur la majorité des vagues. */
  majorityHasTwoStrategies: boolean;
  /** Critère de sortie : l'architecture au maximum de tout perd chaque vague par le coût ou la complexité. */
  overprovisioned: { waveId: string; lossReasons: string[]; losesOnBudget: boolean }[];
}

/**
 * Joue chaque architecture canonique sur chaque vague, isolément : sans architecture
 * précédente, donc sans coût de migration. On mesure ce qui peut gagner, pas un parcours.
 */
export function runMassSim(scenario: Scenario, catalog: Catalog, space: BalanceSpace, scoring: Scoring): MassSimReport {
  const candidates = [...enumerate(space)];
  const winsEverywhere = new Set(candidates.map((_, i) => i));

  // Gagnantes de chaque vague jouée sans `previous`, pour l'enchaînement.
  const winnerIndexes: number[][] = [];

  const waves = scenario.waves.map((wave, waveIndex): WaveReport => {
    const groups = new Map<string, StrategyGroup>();
    const winners = new Set<string>();
    const winningChoices = new Map<string, Choice[]>();
    const wonHere: number[] = [];
    winnerIndexes[waveIndex] = wonHere;
    candidates.forEach((c, i) => {
      const result = simulateWave(c.arch, wave, catalog);
      if (!result.won) {
        winsEverywhere.delete(i);
        return;
      }
      wonHere.push(i);
      winners.add(choiceKey(space, c.choice));
      winningChoices.set(c.strategy, [...(winningChoices.get(c.strategy) ?? []), c.choice]);
      const score = scoreWave(result, 0, scoring);
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

  const chaining = scenario.waves.flatMap((wave, n): ChainReport[] => {
    const from = scenario.waves[n - 1];
    if (!from?.answers?.length) return [];
    const starts = from.answers.map((answer, answerIndex): ChainStart => {
      const previous = space.build(answer);
      let winners = 0;
      let cheapest: ChainStart['cheapest'];
      // `previous` n'entre que dans la jauge de coût, en ajoutant une migration positive
      // ou nulle (voir `simulateWave`) : gagner avec `previous` suppose de gagner sans.
      // Seules les gagnantes de la vague jouée isolément sont donc à rejouer. Les ids de
      // nœuds sont stables d'un choix à l'autre (un seul `build` par espace, ids fixes),
      // ce qui rend la migration juste : un id qui change est bien un autre bâtiment.
      for (const i of winnerIndexes[n] ?? []) {
        const c = candidates[i]!;
        const r = simulateWave(c.arch, wave, catalog, previous);
        if (!r.won) continue;
        winners++;
        if (!cheapest || r.gauges.cost.value < cheapest.cost) {
          cheapest = { choice: c.choice, cost: r.gauges.cost.value, migration: r.bill.migration, limit: r.gauges.cost.limit };
        }
      }
      return { answerIndex, winners, ...(cheapest ? { cheapest } : {}) };
    });
    return [{ waveId: wave.id, fromWaveId: from.id, starts }];
  });

  const withTwo = waves.filter((w) => w.strategies.length >= 2).length;
  return {
    waves,
    chaining,
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

