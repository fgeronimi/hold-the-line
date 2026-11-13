import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import { SCENARIOS } from '../src/data/scenarios/index.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { scoring } from '../src/data/scoring.ts';
import { hintsLeft, newGame, playWave } from '../src/engine/game.ts';
import { setAt } from '../src/ui/calibration.ts';
import { choices, gameOf, isStore, readStore, startOf, withFixtures, withGame, withInsertedWaves, withWorkers, type Store } from '../src/ui/session.ts';
import { validateArchitecture } from '../src/engine/validate.ts';
import type { Architecture } from '../src/engine/types.ts';

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

describe('le bâtiment Worker dans une partie en cours (ticket n° 1)', () => {
  // Avant le worker, le consommateur de la file était un second serveur d'application.
  const legacy = (arch: Architecture, instances = 0): Architecture => ({
    ...arch,
    nodes: arch.nodes.map((n) =>
      n.id === 'worker' ? { id: 'worker', type: 'app-server', ...(instances ? { upgrades: { 'horizontal-scaling': instances } } : {}) } : n,
    ),
  });

  it('un serveur dont tout le trafic vient d’une file devient un worker, ses instances avec lui', () => {
    const before = legacy(A.queuedClicks(3), 2);
    expect(validateArchitecture(before, catalog).ok).toBe(false);
    const after = withWorkers(before, catalog);
    expect(after.nodes.find((n) => n.id === 'worker')).toEqual({ id: 'worker', type: 'worker', upgrades: { 'worker-scaling': 2 } });
    // Le serveur de façade, lui, ne bouge pas.
    expect(after.nodes.find((n) => n.id === 'app')!.type).toBe('app-server');
    expect(validateArchitecture(after, catalog).ok).toBe(true);
    expect(withWorkers(after, catalog)).toEqual(after);
  });

  it('au chargement, brouillon, architecture validée et historique sont convertis ensemble', () => {
    const old = legacy(A.queuedClicks(3));
    const game = { ...newGame(), waveIndex: 4, committed: old, history: [newGame().committed, A.minimal, A.withCache, A.scaled(3), old] };
    const store: Store = { current: urlShortener.id, saves: { [urlShortener.id]: { game, draft: old } } };
    const picked = gameOf(readStore(throughStorage(store)), urlShortener.id);
    for (const arch of [picked.draft, picked.game.committed, picked.game.history[4]!]) {
      expect(arch.nodes.find((n) => n.id === 'worker')!.type).toBe('worker');
    }
    expect(picked.draft.nodes.map((n) => n.id).sort()).toEqual(picked.game.committed.nodes.map((n) => n.id).sort());
    expect(picked.game.history[3]).toEqual(A.scaled(3));
  });
});

describe('une vague ajoutée au milieu d’un scénario publié', () => {
  const n = urlShortener.waves.length;
  const archs = Array.from({ length: n }, (_, i) => ({ ...A.minimal, nodes: A.minimal.nodes.map((x) => ({ ...x, id: `${x.id}-${i}` })) }));
  const old = { ...newGame(), waveIndex: n - 1, committed: archs[n - 1]!, history: archs, scores: [10, 20, 30, 40, 60], stars: [3, 3, 2, 2, 1], finished: true };

  it('une partie terminée avant l’ajout garde chaque note sur sa vague, la nouvelle sans note', () => {
    const game = withInsertedWaves(old, urlShortener);
    expect(game.scores).toEqual([10, 20, 30, 40, 0, 60]);
    expect(game.stars).toEqual([3, 3, 2, 2, 0, 1]);
    expect(game.history).toHaveLength(n + 1);
    expect(game.history[4]).toBe(archs[4]);
    expect(game.history[5]).toBe(archs[4]);
    expect(game.waveIndex).toBe(n);
  });

  it('une partie à jour, ou en cours, n’est pas touchée', () => {
    const current = { ...old, scores: [...old.scores, 70], stars: [...old.stars, 3] };
    expect(withInsertedWaves(current, urlShortener)).toBe(current);
    const playing = { ...old, finished: false };
    expect(withInsertedWaves(playing, urlShortener)).toBe(playing);
  });
});
