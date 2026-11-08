import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { migrationCost } from '../src/engine/budget.ts';
import { newGame, playWave, rewindTo } from '../src/engine/game.ts';
import { scoreWave } from '../src/engine/score.ts';
import type { Architecture, Gauge, WaveResult } from '../src/engine/types.ts';

const withUpgrades = (arch: Architecture, id: string, upgrades: Record<string, number>): Architecture => ({
  ...arch,
  nodes: arch.nodes.map((n) => (n.id === id ? { ...n, upgrades } : n)),
});

describe('migrationCost', () => {
  it('ajouter ne coûte rien', () => {
    expect(migrationCost(A.minimal, A.withCache, catalog)).toBe(0);
  });

  it('retirer un composant coûte sa valeur d’achat', () => {
    expect(migrationCost(A.withCache, A.minimal, catalog)).toBe(15);
  });

  it('changer le type d’un nœud compte comme un retrait', () => {
    const swapped: Architecture = {
      ...A.minimal,
      nodes: A.minimal.nodes.map((n) => (n.id === 'app' ? { ...n, type: 'cache' } : n)),
    };
    expect(migrationCost(A.minimal, swapped, catalog)).toBe(20);
  });

  it('réduire les instances est gratuit', () => {
    expect(migrationCost(A.scaled(4), A.scaled(2), catalog)).toBe(0);
  });

  it('retirer un réplica coûte chaque niveau retiré', () => {
    const two = withUpgrades(A.minimal, 'db', { 'read-replica': 2 });
    expect(migrationCost(two, A.withReplica, catalog)).toBe(40);
    expect(migrationCost(two, A.minimal, catalog)).toBe(80);
  });

  it('changer de palier de rate limiting est gratuit, le désactiver coûte', () => {
    const t3 = A.scaled(3, { rateLimitTier: 3 });
    expect(migrationCost(t3, A.scaled(3, { rateLimitTier: 1 }), catalog)).toBe(0);
    expect(migrationCost(t3, A.scaled(3), catalog)).toBe(5);
  });

  it('retirer un nœud fait payer ses évolutions selon leurs règles', () => {
    const replicated = withUpgrades(A.minimal, 'db', { 'read-replica': 1 });
    const noDb: Architecture = { nodes: replicated.nodes.filter((n) => n.id !== 'db'), links: [] };
    expect(migrationCost(replicated, noDb, catalog)).toBe(50 + 40);
  });
});

describe('scoreWave', () => {
  const g = (margin: number): Gauge => ({ value: 0, limit: 1, margin });
  const result = (won: boolean, margins: number[]) =>
    ({
      won,
      gauges: { cost: g(margins[0]!), complexity: g(margins[1]!), failureRate: g(margins[2]!), latency: g(margins[3]!) },
    }) as WaveResult;
  const scoring = { maxPoints: 100, replayPenalty: 0.2 };

  it('vaut la moyenne des marges bornées à [0, 1]', () => {
    expect(scoreWave(result(true, [0.2, 0.4, 1, 0.2]), 0, scoring)).toBeCloseTo(45);
    // Une marge négative ne peut pas exister sur une vague gagnée, mais elle reste bornée.
    expect(scoreWave(result(true, [1.5, -1, 1, 1]), 0, scoring)).toBeCloseTo(75);
  });

  it('retire 20 % par rejeu, sans passer sous zéro', () => {
    expect(scoreWave(result(true, [1, 1, 1, 1]), 2, scoring)).toBeCloseTo(60);
    expect(scoreWave(result(true, [1, 1, 1, 1]), 7, scoring)).toBe(0);
  });

  it('vaut zéro pour une vague perdue', () => {
    expect(scoreWave(result(false, [1, 1, 1, 1]), 0, scoring)).toBe(0);
  });
});

describe('playWave', () => {
  const scoring = { maxPoints: 100, replayPenalty: 0.2 };

  it('rejoue la vague perdue depuis l’architecture validée, puis avance', () => {
    let state = newGame();
    ({ state } = playWave(state, urlShortener, A.minimal, catalog, scoring));
    expect(state.waveIndex).toBe(1);
    expect(state.committed).toBe(A.minimal);

    const lost = playWave(state, urlShortener, A.minimal, catalog, scoring);
    expect(lost.result.won).toBe(false);
    expect(lost.state.waveIndex).toBe(1);
    expect(lost.state.replays).toBe(1);
    expect(lost.state.committed).toBe(A.minimal);

    const won = playWave(lost.state, urlShortener, A.withCache, catalog, scoring);
    expect(won.state.waveIndex).toBe(2);
    expect(won.state.replays).toBe(0);
    expect(won.score).toBeCloseTo(scoreWave(won.result, 1, scoring));
  });

  it('facture la migration depuis l’architecture validée', () => {
    let state = newGame();
    ({ state } = playWave(state, urlShortener, A.minimal, catalog, scoring));
    ({ state } = playWave(state, urlShortener, A.withReplica, catalog, scoring));
    const { result } = playWave(state, urlShortener, A.scaled(3), catalog, scoring);
    expect(result.bill.migration).toBe(40);
  });

  it('joue le scénario de bout en bout avec les réponses attendues', () => {
    const answers = [
      A.minimal,
      A.withCache,
      A.scaled(3),
      A.scaled(3, { rateLimitTier: A.TIER_40 }),
      A.queuedClicks(4),
    ];
    let state = newGame();
    for (const arch of answers) ({ state } = playWave(state, urlShortener, arch, catalog, scoring));
    expect(state.finished).toBe(true);
    expect(state.scores).toHaveLength(5);
    expect(state.scores.every((s) => s > 0)).toBe(true);
    expect(() => playWave(state, urlShortener, A.minimal, catalog, scoring)).toThrow();
  });

  it('revient à une vague antérieure avec son architecture, au prix d’un rejeu', () => {
    // Parcours CDN : il gagne les vagues 3 et 4, puis la vague 5 est ingagnable depuis là.
    const answers = [A.minimal, A.withCache, A.withCdn(), A.withCdn({ rateLimitTier: A.TIER_40 })];
    let state = newGame();
    for (const arch of answers) ({ state } = playWave(state, urlShortener, arch, catalog, scoring));
    expect(state.waveIndex).toBe(4);

    const back = rewindTo(state, 2);
    expect(back.waveIndex).toBe(2);
    expect(back.committed).toBe(A.withCache);
    expect(back.scores).toEqual(state.scores.slice(0, 2));
    expect(back.replays).toBe(1);

    let replay = back;
    for (const arch of [A.scaled(3), A.scaled(3, { rateLimitTier: A.TIER_40 }), A.queuedClicks(3)]) {
      ({ state: replay } = playWave(replay, urlShortener, arch, catalog, scoring));
    }
    expect(replay.finished).toBe(true);
    expect(replay.history).toHaveLength(6);
  });

  it('refuse de sauter à une vague pas encore atteinte', () => {
    expect(() => rewindTo(newGame(), 1)).toThrow();
  });
});
