import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { newGame, playWave, type GameState } from '../src/engine/game.ts';
import type { Architecture } from '../src/engine/types.ts';
import { scenarioReview } from '../src/ui/review.ts';
import { renderDialog, type ViewState } from '../src/ui/views.ts';

/** Le raccourcisseur joué jusqu'au bout avec des réponses attendues ; la vague 3 en autoscaling, sans tout son superflu ôté. */
function finished(): GameState {
  const answers: Architecture[] = [
    A.minimal,
    A.withLockedCache,
    A.autoscaled(2, 3),
    A.scaled(4, { rateLimitTier: A.TIER_40 }),
    A.gated({ partnerTier: A.PARTNER_160, anonymousTier: A.ANONYMOUS_10, extraInstances: 4, replicas: 1 }),
    A.gated({ partnerTier: A.PARTNER_160, anonymousTier: A.ANONYMOUS_10, extraInstances: 4, replicas: 1, queue: true }),
  ];
  let game = newGame();
  for (const arch of answers) ({ state: game } = playWave(game, urlShortener, arch, catalog));
  return game;
}

const ids = (list: { id: string }[]) => list.map((a) => a.id);

describe('le bilan d’un scénario (P4)', () => {
  const game = finished();
  const review = scenarioReview(game, urlShortener, catalog);

  it('dit, vague par vague, ce que l’architecture validée a appliqué', () => {
    expect(game.finished).toBe(true);
    expect(review.waves).toHaveLength(urlShortener.waves.length);
    expect(ids(review.waves[1]!.applied)).toEqual(expect.arrayContaining(['cache', 'cold-cache', 'coalescing']));
    expect(ids(review.waves[5]!.applied)).toContain('queue-worker');
  });

  it('ne répète pas une notion déjà appliquée par une vague précédente', () => {
    expect(ids(review.waves[0]!.fresh)).toEqual(['client-server']);
    expect(ids(review.waves[1]!.fresh)).not.toContain('client-server');
    const all = review.waves.flatMap((w) => ids(w.fresh));
    expect(new Set(all).size).toBe(all.length);
  });

  it('montre les autres parades qui tenaient aussi', () => {
    expect(ids(review.waves[1]!.alternatives)).toEqual(expect.arrayContaining(['cdn', 'read-replica']));
    expect(ids(review.waves[1]!.alternatives)).not.toContain('cache');
  });

  it('compte les étoiles et liste les vagues qui en manquent', () => {
    expect(review.maxStars).toBe(18);
    expect(review.stars).toBe(game.stars.reduce((a, s) => a + Number(s.held) + Number(s.lean) + Number(s.thrifty), 0));
    expect(review.incomplete.map((w) => w.index)).toContain(2);
    expect(review.incomplete.every((w) => !(w.stars.held && w.stars.lean && w.stars.thrifty))).toBe(true);
  });

  it('se rend par-dessus le reste, avec un bouton pour rejouer chaque vague incomplète', () => {
    const view = {
      catalog,
      scenario: urlShortener,
      game,
      draft: A.minimal,
      attempts: [],
      achievements: {},
      tool: { kind: 'select' },
      history: { undo: 0, redo: 0 },
      phase: 'build',
      choices: [],
      showReview: true,
    } as unknown as ViewState;
    const html = renderDialog(view);
    expect(html).toContain('review-dialog');
    expect(html).toContain('data-action="replay-wave" data-wave="2"');
    expect(renderDialog({ ...view, showReview: false })).not.toContain('review-dialog');
  });
});
