import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { hintsLeft, newGame, playWave, practiceGame, withHint, withReplayedStars } from '../src/engine/game.ts';
import { superfluous } from '../src/engine/lean.ts';
import { bestStars, NO_STARS, starCount } from '../src/engine/score.ts';
import type { Architecture } from '../src/engine/types.ts';

const readSurge = urlShortener.waves[1]!;
const withUpgrades = (arch: Architecture, id: string, upgrades: Record<string, number>): Architecture => ({
  ...arch,
  nodes: arch.nodes.map((n) => (n.id === id ? { ...n, upgrades } : n)),
});

describe('le superflu (étoile « rien de superflu »)', () => {
  it('une réponse attendue nue n’a rien de trop', () => {
    expect(superfluous(A.withCache, readSurge, catalog)).toEqual([]);
  });

  it('un cache et un réplica qui suffisent chacun seul sont tous deux signalés', () => {
    const both = withUpgrades(A.withCache, 'db', { 'read-replica': 1 });
    expect(superfluous(both, readSurge, catalog)).toEqual([{ node: 'cache' }, { node: 'db', upgrade: 'read-replica', level: 0 }]);
  });

  it('un cran d’instances en trop est nommé, avec le niveau qui suffit', () => {
    const marketing = urlShortener.waves[2]!;
    const spare = superfluous(A.scaled(4), marketing, catalog);
    expect(spare).toContainEqual({ node: 'app', upgrade: 'horizontal-scaling', level: 3 });
  });

  it('un bâtiment entier en trop l’est avec ses évolutions', () => {
    const extra = { ...A.withCache, nodes: [...A.withCache.nodes, { id: 'cdn', type: 'cdn' }], links: [...A.withCache.links] };
    expect(superfluous(extra, readSurge, catalog).filter((s) => s.node === 'cdn')).toEqual([{ node: 'cdn' }]);
  });
});

describe('les étoiles', () => {
  it('se réunissent objectif par objectif : chacun n’a besoin d’être atteint qu’une fois', () => {
    expect(bestStars(undefined, NO_STARS)).toEqual(NO_STARS);
    const a = { held: true, lean: true, thrifty: false };
    const b = { held: true, lean: false, thrifty: true };
    expect(bestStars(a, b)).toEqual({ held: true, lean: true, thrifty: true });
    expect(starCount(bestStars(a, b))).toBe(3);
  });
});

describe('playWave', () => {
  it('rejoue la vague perdue depuis l’architecture validée, puis avance', () => {
    let state = newGame();
    ({ state } = playWave(state, urlShortener, A.minimal, catalog));
    expect(state.waveIndex).toBe(1);
    expect(state.committed).toBe(A.minimal);

    const lost = playWave(state, urlShortener, A.minimal, catalog);
    expect(lost.result.won).toBe(false);
    expect(lost.stars).toEqual(NO_STARS);
    expect(lost.state.waveIndex).toBe(1);
    expect(lost.state.replays).toBe(1);
    expect(lost.state.committed).toBe(A.minimal);

    // Perdre ne coûte rien (E9) : la vague gagnée ensuite a toutes ses étoiles.
    const won = playWave(lost.state, urlShortener, A.withCache, catalog);
    expect(won.state.waveIndex).toBe(2);
    expect(won.state.replays).toBe(0);
    expect(won.stars).toEqual({ held: true, lean: true, thrifty: true });
    expect(won.state.stars[1]).toEqual(won.stars);
  });

  it('une vague tenue avec du superflu manque l’étoile « rien de superflu »', () => {
    let state = newGame();
    ({ state } = playWave(state, urlShortener, A.minimal, catalog));
    ({ state } = playWave(state, urlShortener, A.withCache, catalog));
    const { stars } = playWave(state, urlShortener, A.autoscaled(2, 3), catalog);
    expect(stars).toMatchObject({ held: true, lean: false });
  });

  it('joue le scénario de bout en bout avec les réponses attendues', () => {
    const answers = [
      A.minimal,
      A.withCache,
      A.scaled(3),
      A.scaled(4, { rateLimitTier: A.TIER_40 }),
      A.gated({ partnerTier: A.PARTNER_160, anonymousTier: A.ANONYMOUS_10, extraInstances: 4, replicas: 1 }),
      A.gated({ partnerTier: A.PARTNER_160, anonymousTier: A.ANONYMOUS_10, extraInstances: 4, replicas: 1, queue: true }),
    ];
    let state = newGame();
    for (const arch of answers) ({ state } = playWave(state, urlShortener, arch, catalog));
    expect(state.finished).toBe(true);
    expect(state.stars).toHaveLength(6);
    expect(state.stars.every((s) => s.held)).toBe(true);
    expect(() => playWave(state, urlShortener, A.minimal, catalog)).toThrow();
  });
});

describe('rejouer une vague tenue (E10)', () => {
  const played = () => {
    let state = newGame();
    ({ state } = playWave(state, urlShortener, A.minimal, catalog));
    ({ state } = playWave(state, urlShortener, A.withCache, catalog));
    // Vague 3 tenue avec un cran d'autoscaling en trop : l'étoile « rien de superflu » manque.
    ({ state } = playWave(state, urlShortener, A.autoscaled(2, 3), catalog));
    return state;
  };

  it('part de l’architecture validée au début de la vague, sans toucher à la vraie partie', () => {
    const real = played();
    const practice = practiceGame(real, 2);
    expect(practice.waveIndex).toBe(2);
    expect(practice.committed).toBe(A.withCache);
    expect(practice.replays).toBe(0);
    expect(real.waveIndex).toBe(3);
    expect(() => practiceGame(real, 3)).toThrow();
  });

  it('un rejeu gagné n’apporte que ses étoiles, gardées objectif par objectif', () => {
    const real = played();
    expect(real.stars[2]).toEqual({ held: true, lean: false, thrifty: false });
    const { stars } = playWave(practiceGame(real, 2), urlShortener, A.scaled(3), catalog);
    const after = withReplayedStars(real, 2, stars);
    expect(after.stars[2]).toEqual({ held: true, lean: true, thrifty: false });
    expect(after.waveIndex).toBe(real.waveIndex);
    expect(after.committed).toBe(real.committed);
    expect(after.history).toBe(real.history);
    // Un rejeu moins bon n'enlève rien.
    expect(withReplayedStars(after, 2, NO_STARS).stars[2]).toEqual(after.stars[2]);
  });
});

describe('indices gardés dans la partie', () => {
  it('un indice par essai perdu, jamais plus', () => {
    let state = newGame();
    expect(hintsLeft(state)).toBe(0);
    expect(withHint(state, 'a')).toBe(state);
    ({ state } = playWave(state, urlShortener, A.noDatabase, catalog));
    expect(hintsLeft(state)).toBe(1);
    state = withHint(state, 'a');
    expect(state.hints).toEqual(['a']);
    expect(state.hinted).toBe(true);
    expect(hintsLeft(state)).toBe(0);
    expect(withHint(state, 'b')).toBe(state);
    // Une vague encore perdue garde les indices et en ouvre un de plus.
    ({ state } = playWave(state, urlShortener, A.noDatabase, catalog));
    expect(state.hints).toEqual(['a']);
    expect(withHint(state, 'a')).toBe(state);
    expect(withHint(state, 'b').hints).toEqual(['a', 'b']);
  });

  it('vidés quand la vague est gagnée ; la partie se souvient qu’un indice a servi', () => {
    let state = newGame();
    ({ state } = playWave(state, urlShortener, A.noDatabase, catalog));
    state = withHint(state, 'a');
    ({ state } = playWave(state, urlShortener, A.minimal, catalog));
    expect(state.hints).toEqual([]);
    expect(hintsLeft(state)).toBe(0);
    expect(state.hinted).toBe(true);
  });

  it('une sauvegarde d’avant l’aide, sans le champ, reste lisible', () => {
    const { hints: _dropped, ...old } = { ...newGame(), replays: 2 };
    expect(hintsLeft(old)).toBe(2);
    expect(withHint(old, 'a').hints).toEqual(['a']);
  });
});
