import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import { SCENARIOS } from '../src/data/scenarios/index.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { scoring } from '../src/data/scoring.ts';
import { hintsLeft, newGame, playWave } from '../src/engine/game.ts';
import { setAt } from '../src/ui/calibration.ts';
import { choices, gameOf, isStore, readStore, startOf, withFixtures, withGame, type Store } from '../src/ui/session.ts';

const EMPTY: Store = { saves: {} };
/** Ce que le stockage rend : la sauvegarde passée par JSON, comme dans le navigateur. */
const throughStorage = (store: Store): unknown => JSON.parse(JSON.stringify(store));

describe('la partie gardée', () => {
  it('une partie neuve part de la source et des services déjà en place', () => {
    const market = SCENARIOS[1]!.scenario;
    const picked = gameOf(EMPTY, market.id);
    expect(picked.game).toEqual(newGame());
    expect(picked.calibrated).toBe(false);
    expect(picked.draft.nodes.map((n) => n.id)).toEqual(startOf(market).nodes.map((n) => n.id));
    expect(picked.draft.nodes.every((n) => n.cell)).toBe(true);
  });

  it('une sauvegarde de la forme actuelle se recharge à l’identique', () => {
    const { calibrated: _, ...picked } = gameOf(EMPTY, urlShortener.id);
    const { state: game } = playWave(picked.game, picked.scenario, A.minimal, picked.catalog, scoring);
    const played = { ...picked, game, draft: gameOf(EMPTY, urlShortener.id).draft };
    const store = withGame(EMPTY, played, false);
    const reloaded = readStore(throughStorage(store));
    expect(reloaded).toEqual(store);
    const again = gameOf(reloaded, urlShortener.id);
    expect(again.game).toEqual(game);
    expect(again.draft).toEqual(played.draft);
    expect(reloaded.current).toBe(urlShortener.id);
  });

  it('catalogue et scénario ne sont gardés que s’ils ont été calibrés', () => {
    const { calibrated: _, ...picked } = gameOf(EMPTY, urlShortener.id);
    expect(withGame(EMPTY, picked, false).saves[urlShortener.id]).not.toHaveProperty('calibration');
    const tuned = { ...picked, catalog: setAt(picked.catalog, 'components.cache.hitRate', 0.5) };
    const store = readStore(throughStorage(withGame(EMPTY, tuned, true)));
    const again = gameOf(store, urlShortener.id);
    expect(again.calibrated).toBe(true);
    expect(again.catalog.components.cache!.hitRate).toBe(0.5);
    // Sans calibrage, le catalogue vient du code, en copie.
    const plain = gameOf(readStore(throughStorage(withGame(EMPTY, picked, false))), urlShortener.id);
    expect(plain.catalog).toEqual(catalog);
    expect(plain.catalog).not.toBe(catalog);
  });

  it('une sauvegarde d’avant l’aide, sans le champ `hints`, se recharge', () => {
    const { hints: _dropped, ...old } = { ...newGame(), replays: 2 };
    const store = readStore({ current: urlShortener.id, saves: { [urlShortener.id]: { game: old, draft: A.minimal } } });
    const again = gameOf(store, urlShortener.id);
    expect(again.game).toEqual(old);
    expect(hintsLeft(again.game)).toBe(2);
    // Un brouillon d'avant le plateau reçoit ses cases.
    expect(again.draft.nodes.every((n) => n.cell)).toBe(true);
  });

  it('une forme inconnue ou corrompue est ignorée sans planter', () => {
    for (const raw of [undefined, null, 'texte', 42, [], {}, { saves: [] }, { saves: 3 }, { saves: {}, current: 7 }]) {
      expect(isStore(raw)).toBe(false);
      expect(readStore(raw)).toEqual({ saves: {} });
    }
    const store = readStore({
      current: urlShortener.id,
      saves: {
        [urlShortener.id]: { game: { waveIndex: 'deux' }, draft: A.minimal },
        market: { game: newGame(), draft: 'pas un brouillon' },
        resilience: 5,
        tournament: { game: newGame(), draft: A.minimal, calibration: { catalog: {} } },
      },
    });
    expect(store.saves).toEqual({});
    expect(() => gameOf(store, urlShortener.id)).not.toThrow();
    expect(gameOf(store, urlShortener.id).game).toEqual(newGame());
  });

  it('une partie valide survit à côté d’une partie abîmée', () => {
    const store = readStore({ saves: { [urlShortener.id]: { game: newGame(), draft: A.minimal }, market: null } });
    expect(Object.keys(store.saves)).toEqual([urlShortener.id]);
  });

  it('un scénario inconnu retombe sur le premier', () => {
    expect(gameOf(EMPTY, 'disparu').scenario.id).toBe(SCENARIOS[0]!.scenario.id);
  });

  it('les services en place arrivés après coup rejoignent une partie commencée', () => {
    const market = SCENARIOS[1]!.scenario;
    const draft = withFixtures({ nodes: [{ id: 'src', type: 'traffic-source' }], links: [] }, market);
    expect(draft.nodes.length).toBe(1 + (market.fixtures?.length ?? 0));
    expect(withFixtures(draft, market)).toBe(draft);
  });

  it('l’écran de choix lit la progression de chaque partie', () => {
    const game = { ...newGame(), waveIndex: 2, stars: [3, 2] };
    const list = choices({ saves: { [urlShortener.id]: { game, draft: A.minimal } } });
    expect(list.find((c) => c.id === urlShortener.id)).toMatchObject({ reached: 2, stars: 5, finished: false, waves: urlShortener.waves.length });
    expect(list.find((c) => c.id !== urlShortener.id)).toMatchObject({ reached: 0, stars: 0 });
  });
});
