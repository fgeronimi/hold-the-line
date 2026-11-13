import { describe, expect, it } from 'vitest';
import { answersOf } from '../src/data/balance-space.ts';
import { catalog } from '../src/data/catalog.ts';
import { CONCEPT_ACHIEVEMENTS, noHintId } from '../src/data/achievements.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { SCENARIOS } from '../src/data/scenarios/index.ts';
import { newGame } from '../src/engine/game.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import { earned, noHintEarned } from '../src/ui/achievements.ts';
import { readStore, withGame } from '../src/ui/session.ts';
import { SPRITE_NAMES } from '../src/ui/sprite.ts';
import { renderDialog, type ViewState } from '../src/ui/views.ts';

/** Chaque réponse attendue, jouée seule, avec les succès qu'elle débloque. */
const played = SCENARIOS.flatMap(({ scenario }) =>
  scenario.waves.flatMap((wave, i) =>
    answersOf(scenario.id, i).map((arch, k) => ({ label: `${scenario.id} ${wave.id} #${k + 1}`, ids: earned(simulateWave(arch, wave, catalog), arch, wave, catalog) })),
  ),
);

describe('les succès (I20)', () => {
  it('chaque réponse attendue de chaque vague en débloque au moins un', () => {
    for (const p of played) expect(p.ids.length, p.label).toBeGreaterThan(0);
  });

  it('chaque succès se gagne avec au moins une réponse attendue', () => {
    const seen = new Set(played.flatMap((p) => p.ids));
    expect(CONCEPT_ACHIEVEMENTS.map((a) => a.id).filter((id) => !seen.has(id))).toEqual([]);
  });

  it('une vague perdue ne débloque rien', () => {
    const lost = simulateWave(A.minimal, urlShortener.waves[1]!, catalog);
    expect(lost.won).toBe(false);
    expect(earned(lost, A.minimal, urlShortener.waves[1]!, catalog)).toEqual([]);
  });

  it('identifiants uniques, et un dessin du sprite pour chacun', () => {
    const ids = CONCEPT_ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of CONCEPT_ACHIEVEMENTS) expect((SPRITE_NAMES as readonly string[]).includes(a.icon), a.id).toBe(true);
  });

  it('« sans indice » se gagne en finissant le scénario sans en avoir pris', () => {
    expect(noHintEarned('market', true, undefined)).toEqual([noHintId('market')]);
    expect(noHintEarned('market', true, true)).toEqual([]);
    expect(noHintEarned('market', false, false)).toEqual([]);
  });

  it('se gardent dans le magasin, pour toutes les parties', () => {
    const state = { catalog, scenario: urlShortener, game: newGame(), draft: A.minimal, achievements: { cache: { scenario: 'url-shortener', wave: 1 } } };
    const store = withGame({ saves: {} }, state, false);
    const back = readStore(JSON.parse(JSON.stringify(store)));
    expect(back.achievements).toEqual({ cache: { scenario: 'url-shortener', wave: 1 } });
    // Une entrée abîmée est écartée, le reste est gardé.
    expect(readStore({ saves: {}, achievements: { cache: { scenario: 'x', wave: 1 }, broken: 3 } }).achievements).toEqual({ cache: { scenario: 'x', wave: 1 } });
  });

  it('la fenêtre montre les acquis et ce qui reste à découvrir', () => {
    const s = { showAchievements: true, achievements: { cache: { scenario: 'url-shortener', wave: 1 } }, choices: SCENARIOS.map(({ scenario }) => ({ id: scenario.id, subtitle: scenario.subtitle })) } as unknown as ViewState;
    const html = renderDialog(s);
    const total = CONCEPT_ACHIEVEMENTS.length + SCENARIOS.length;
    expect(html).toContain(`Succès · 1 / ${total}`);
    expect(html.match(/class="ach"/g)).toHaveLength(1);
    expect(html.match(/class="ach locked"/g)).toHaveLength(total - 1);
  });
});
