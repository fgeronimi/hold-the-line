import { describe, expect, it } from 'vitest';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { scoring } from '../src/data/scoring.ts';
import { newGame, playWave } from '../src/engine/game.ts';
import { actions, boardClick, cardDragged, cardDropped, keyPressed, type ActionArgs, type Effect, type Outcome } from '../src/ui/actions.ts';
import { autoPlace, insideBoard, nodeAt } from '../src/ui/board.ts';
import { isRiver } from '../src/render/terrain.ts';
import type { Architecture, BoardCell } from '../src/engine/types.ts';
import { draftInfo } from '../src/ui/draft.ts';
import { findingsOf, type ViewState } from '../src/ui/views.ts';
import { gameOf, withGame, type Store } from '../src/ui/session.ts';
import { analysisOf } from '../src/ui/debrief.ts';
import { fortifiedCity } from '../src/data/themes/fortified-city.ts';
import { setAt } from '../src/ui/calibration.ts';

const EMPTY: Store = { saves: {} };

/** Une partie du raccourcisseur en construction, comme `main.ts` l'ouvre. */
function stateAt(extra: Partial<ViewState> = {}): ViewState {
  const { calibrated: _, ...picked } = gameOf(EMPTY, urlShortener.id);
  return {
    ...picked,
    attempts: [],
    tool: { kind: 'select' },
    history: { undo: 0, redo: 0 },
    phase: 'build',
    debug: false,
    debugTab: 'attempts',
    debriefTab: 'analysis',
    showMenu: false,
    choices: [],
    ...extra,
  };
}

/** La vague 2, depuis l'architecture minimale validée en vague 1. */
function atWave2(extra: Partial<ViewState> = {}): ViewState {
  const s = stateAt();
  const { state: game } = playWave(s.game, s.scenario, A.minimal, s.catalog, scoring);
  return { ...s, game, draft: autoPlace(A.minimal), ...extra };
}

const run = (name: string, s: ViewState, args: Partial<ActionArgs> = {}, store: Store = EMPTY): Outcome =>
  actions[name]!(s, { data: {}, ...args }, { store, nextAttemptId: 7 }) ?? {};
/** Une case où l'on peut bâtir sans rien déranger : sur le plateau, hors rivière, ni bâtiment ni chemin. */
function freeCell(arch: Architecture): BoardCell {
  for (let q = 0; q < 20; q++) {
    for (let r = -10; r < 10; r++) {
      const cell = { q, r };
      const onRoad = arch.links.some((l) => l.path?.some((c) => c.q === q && c.r === r));
      if (insideBoard(cell) && !isRiver(cell) && !nodeAt(arch, cell) && !onRoad) return cell;
    }
  }
  throw new Error('aucune case libre');
}
const FREE = freeCell(autoPlace(A.minimal));

const kinds = (o: Outcome) => (o.effects ?? []).map((e: Effect) => e.kind);

describe('les actions', () => {
  it('jouer une vague perdue compte un essai, garde le brouillon et ouvre le rejeu', () => {
    const s = atWave2();
    const out = run('play', s);
    expect(out.patch!.game!.replays).toBe(1);
    expect(out.patch!.game!.waveIndex).toBe(1);
    expect(out.patch).not.toHaveProperty('draft');
    const [attempt] = out.patch!.attempts!;
    expect(attempt).toMatchObject({ id: 7, played: true, waveIndex: 1, arch: s.draft });
    expect(attempt!.label).toMatch(/^#7 V2 .*\(perdue : /);
    expect(attempt!.result.won).toBe(false);
    expect(out.patch!.current).toBe(7);
    expect(kinds(out)).toEqual(['forget-history', 'attempt-recorded', 'play']);
  });

  it('l’analyse est calculée une fois, à l’enregistrement, et les vues la lisent', () => {
    const s = atWave2();
    const attempt = run('play', s).patch!.attempts![0]!;
    const wave = s.scenario.waves[1]!;
    expect(attempt.analysis!.findings).toEqual(analysisOf(undefined, attempt, wave, s.catalog, fortifiedCity).findings);
    expect(findingsOf(attempt, wave, s)).toBe(attempt.analysis!.findings);
    // Un calibrage du mode debug la rend caduque : elle est refaite, puis gardée.
    const tuned = { ...s, catalog: setAt(s.catalog, 'components.database.capacity', 5000) };
    const again = findingsOf(attempt, wave, tuned);
    expect(again).not.toBe(attempt.analysis!.findings);
    expect(findingsOf(attempt, wave, tuned)).toBe(again);
  });

  it('un essai hors partie ne touche ni la partie ni l’historique', () => {
    const out = run('try', atWave2());
    expect(out.patch).not.toHaveProperty('game');
    expect(out.patch!.attempts![0]!.played).toBe(false);
    expect(kinds(out)).toEqual(['attempt-recorded', 'play']);
  });

  it('vague suivante : le briefing, ou la construction si la partie est finie', () => {
    expect(run('next', atWave2()).patch!.phase).toBe('briefing');
    const done = atWave2();
    expect(run('next', { ...done, game: { ...done.game, finished: true } }).patch!.phase).toBe('build');
    expect(kinds(run('next', done))).toEqual(['leave-wave']);
  });

  it('réessayer revient à la construction, sans vider l’historique', () => {
    const out = run('retry', atWave2({ phase: 'debrief' }));
    expect(out.patch).toEqual({ phase: 'build' });
    expect(kinds(out)).toEqual(['leave-wave']);
  });

  it('revenir à la vague n reprend son architecture validée, au briefing', () => {
    const s = atWave2();
    const out = run('rewind', s, { data: { wave: '0' } });
    expect(out.patch!.game!.waveIndex).toBe(0);
    expect(out.patch!.game!.replays).toBe(1);
    expect(out.patch!.phase).toBe('briefing');
    // La vague 1 n'a pas d'architecture validée : on repart du plateau de départ.
    expect(out.patch!.draft!.nodes.map((n) => n.id)).toEqual(['src']);
    expect(kinds(out)).toEqual(['forget-history', 'leave-wave']);
  });

  it('nouvelle partie : tout repart de zéro, au briefing', () => {
    const out = run('reset-game', atWave2({ attempts: [] }));
    expect(out.patch!.game).toEqual(newGame());
    expect(out.patch!.attempts).toEqual([]);
    expect(out.patch!.phase).toBe('briefing');
    expect(kinds(out)).toEqual(['forget-history', 'leave-wave']);
  });

  it('choisir un scénario charge sa partie gardée, et vide l’historique', () => {
    expect(run('choose-scenario', atWave2()).patch!.phase).toBe('choose');
    const s = atWave2();
    const fresh = run('pick-scenario', s, { data: { scenario: 'market' } });
    expect(fresh.patch!.scenario!.id).toBe('market');
    expect(fresh.patch!.phase).toBe('briefing');
    expect(kinds(fresh)).toEqual(['forget-history']);
    const store = withGame(EMPTY, { ...s, game: { ...s.game, finished: true } }, true);
    const back = run('pick-scenario', stateAt(), { data: { scenario: urlShortener.id } }, store);
    expect(back.patch!.phase).toBe('build');
    expect(back.effects).toEqual([{ kind: 'forget-history' }, { kind: 'calibrated', id: urlShortener.id, on: true }]);
  });

  it('un indice n’est donné que si le joueur y a droit', () => {
    const s = atWave2();
    expect(run('hint', s).patch!.game).toBe(s.game);
    const lost = { ...s, game: { ...s.game, replays: 1 } };
    expect(run('hint', lost).patch!.game!.hints).toHaveLength(1);
  });

  it('le calibrage refuse une saisie illisible et marque le scénario', () => {
    const s = atWave2();
    const field = { data: { root: 'catalog', path: 'components.cache.hitRate' } };
    expect(actions.calibrate!(s, { ...field, value: 'abc' }, { store: EMPTY, nextAttemptId: 1 })).toBeUndefined();
    const out = run('calibrate', s, { ...field, value: '0.5' });
    expect(out.patch!.catalog!.components.cache!.hitRate).toBe(0.5);
    expect(out.effects).toEqual([{ kind: 'calibrated', id: urlShortener.id, on: true }]);
  });

  it('la vue tableau reçoit ses champs en arguments', () => {
    const s = atWave2();
    expect(run('add-node', s, { newNode: 'cache' }).patch!.draft!.nodes.at(-1)!.type).toBe('cache');
    const linked = run('add-link', s, { linkFrom: 'db', linkTo: 'app' }).patch!.draft!;
    expect(linked.links.some((l) => l.from === 'db' && l.to === 'app')).toBe(true);
  });

  it('les clients ne se démolissent pas', () => {
    expect(actions['remove-node']!(atWave2(), { data: { node: 'src' } }, { store: EMPTY, nextAttemptId: 1 })).toBeUndefined();
    expect(run('remove-node', atWave2(), { data: { node: 'app' } }).patch!.draft!.nodes.some((n) => n.id === 'app')).toBe(false);
  });

  it('un clic du plateau ouvre la fiche, ou les fiches de construction sur une case vide', () => {
    const s = atWave2();
    const app = s.draft.nodes.find((n) => n.id === 'app')!;
    expect(boardClick(s, app.cell!)!.patch).toMatchObject({ selectedNode: 'app', buildAt: undefined });
    expect(boardClick({ ...s, phase: 'debrief' }, app.cell!)).toBeUndefined();
  });

  it('« Bâtir » ouvre la main sans case et la referme ; une case vide cliquée l’ouvre pour cette case', () => {
    const s = atWave2({ selectedNode: 'app' });
    expect(run('open-hand', s).patch).toMatchObject({ showHand: true, buildAt: undefined, selectedNode: undefined });
    expect(run('open-hand', { ...s, showHand: true }).patch).toMatchObject({ showHand: false });
    expect(run('open-hand', { ...s, buildAt: FREE }).patch).toMatchObject({ showHand: false, buildAt: undefined });
    expect(boardClick({ ...s, showHand: true, liftedCard: 'cache' }, FREE)!.patch).toMatchObject({
      buildAt: FREE,
      showHand: false,
      liftedCard: undefined,
    });
  });

  it('une carte bâtit sur la case désignée, sinon elle arme l’outil qui pose et referme la main', () => {
    const cell = FREE;
    const built = run('pick-card', atWave2({ buildAt: cell }), { data: { type: 'cache' } }).patch!;
    const placed = built.draft!.nodes.find((n) => n.type === 'cache')!;
    expect(placed.cell).toEqual(cell);
    expect(built).toMatchObject({ buildAt: undefined, showHand: false, selectedNode: placed.id });
    expect(run('pick-card', atWave2({ showHand: true }), { data: { type: 'cache' } }).patch).toEqual({
      tool: { kind: 'place', type: 'cache' },
      buildAt: undefined,
      showHand: false,
      liftedCard: undefined,
      selectedNode: undefined,
      boardMessage: undefined,
    });
  });

  it('au doigt, le premier contact soulève la carte et le second la joue', () => {
    const s = atWave2({ buildAt: FREE });
    const args = { data: { type: 'cache' }, touch: true };
    expect(run('pick-card', s, args).patch).toEqual({ liftedCard: 'cache' });
    expect(run('pick-card', { ...s, liftedCard: 'database' }, args).patch).toEqual({ liftedCard: 'cache' });
    const second = run('pick-card', { ...s, liftedCard: 'cache' }, args).patch!;
    expect(second.draft!.nodes.some((n) => n.type === 'cache')).toBe(true);
    expect(second.liftedCard).toBeUndefined();
  });

  it('une carte glissée referme la main ; lâchée sur une case, elle y est posée', () => {
    expect(cardDragged('cache').patch).toMatchObject({ tool: { kind: 'place', type: 'cache' }, showHand: false, buildAt: undefined });
    const dropped = cardDropped(atWave2({ tool: { kind: 'place', type: 'cache' } }), 'cache', FREE).patch!;
    expect(dropped.draft!.nodes.find((n) => n.type === 'cache')!.cell).toEqual(FREE);
    expect(dropped.tool).toEqual({ kind: 'select' });
  });

  it('l’outil qui pose rend la main à la sélection une fois le bâtiment posé', () => {
    const placed = boardClick(atWave2({ tool: { kind: 'place', type: 'cache' } }), FREE)!.patch!;
    expect(placed.draft!.nodes.find((n) => n.type === 'cache')!.cell).toEqual(FREE);
    expect(placed.tool).toEqual({ kind: 'select' });
  });

  it('Échap et la croix referment la main', () => {
    const s = atWave2({ showHand: true, liftedCard: 'cache' });
    const none = { buildAt: undefined, showHand: false, liftedCard: undefined };
    expect(keyPressed(s, 'Escape', { meta: false, ctrl: false, shift: false }).outcome!.patch).toMatchObject(none);
    expect(run('close-build', s).patch).toEqual(none);
  });

  it('les raccourcis : ⇧⌘Z rétablit, ⌘Z annule, Échap revient à la sélection', () => {
    const s = atWave2({ tool: { kind: 'remove' } });
    const mods = { meta: true, ctrl: false, shift: false };
    expect(keyPressed(s, 'z', mods)).toEqual({ outcome: { effects: [{ kind: 'travel', direction: 'undo' }] }, preventDefault: true });
    expect(keyPressed(s, 'z', { ...mods, shift: true }).outcome!.effects).toEqual([{ kind: 'travel', direction: 'redo' }]);
    expect(keyPressed(s, 'Escape', { ...mods, meta: false }).outcome!.patch!.tool).toEqual({ kind: 'select' });
    expect(keyPressed(s, 'd', { ...mods, meta: false }).outcome!.patch).toEqual({ debug: true });
  });
});

describe('le brouillon analysé', () => {
  it('calculé une fois par brouillon et par catalogue', () => {
    const s = atWave2();
    const info = draftInfo(s.draft, s.catalog);
    expect(draftInfo(s.draft, s.catalog)).toBe(info);
    expect(info.validation.ok).toBe(true);
    expect(info.flows).toBe(draftInfo(s.draft, s.catalog).flows);
    expect(draftInfo(s.draft, structuredClone(s.catalog))).not.toBe(info);
    expect(draftInfo({ ...s.draft }, s.catalog)).not.toBe(info);
  });
});
