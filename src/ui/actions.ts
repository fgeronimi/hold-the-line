import { fortifiedCity as theme } from '../data/themes/fortified-city.ts';
import { newGame, playWave, practiceGame, withReplayedStars, type GameState } from '../engine/game.ts';
import { starCount, starsFor } from '../engine/score.ts';
import { earned, noHintEarned } from './achievements.ts';
import { simulateWave } from '../engine/simulate.ts';
import type { Architecture, ArchNode, BoardCell } from '../engine/types.ts';
import { isRiver } from '../render/terrain.ts';
import { connect, insideBoard, linkRefusal, moveNode, nodeAt, placeNode, type BoardResult } from './board.ts';
import { changedSettings, parseField, setAt } from './calibration.ts';
import { analysisOf } from './debrief.ts';
import { addLink, addNode, removeLink, removeNode, setUpgrade } from './editor.ts';
import { askHint } from './hints.ts';
import { defaultsOf, gameOf, startOf, type Store } from './session.ts';
import type { Attempt, Tool, ViewState } from './views.ts';

/**
 * Ce que fait chaque geste du joueur, sans DOM : un état et ce qu'a désigné le geste en
 * entrée, un patch d'état et des effets en sortie. `main.ts` lit le DOM, exécute les effets
 * et applique le patch.
 */

/**
 * Ce que l'action demande à `main.ts` en plus du patch. `play` et `export` passent après le
 * patch (ils lisent l'état qu'il produit) ; tous les autres avant, dans l'ordre donné.
 */
export type Effect =
  /** Arrêter le rejeu sur le plateau : il revient au brouillon. */
  | { kind: 'leave-wave' }
  /** Vider annuler / rétablir. */
  | { kind: 'forget-history' }
  /** Revenir au brouillon d'avant, ou d'après. */
  | { kind: 'travel'; direction: 'undo' | 'redo' }
  /** Le joueur a touché, ou remis à zéro, le calibrage de ce scénario. */
  | { kind: 'calibrated'; id: string; on: boolean }
  /** Une tentative a pris le numéro `nextAttemptId` : le suivant est libre. */
  | { kind: 'attempt-recorded' }
  /** Jouer une tentative sur le plateau, puis ouvrir son debrief. */
  | { kind: 'play'; attempt: number }
  /** Montrer l'export du calibrage. */
  | { kind: 'export'; text: string }
  /** L'accueil a été vu : le magasin s'en souvient, il ne s'ouvrira plus tout seul. */
  | { kind: 'welcomed' };

export interface Outcome {
  patch?: Partial<ViewState>;
  effects?: Effect[];
}

/** Ce que désigne le geste : les `data-*` de l'élément, sa valeur, et les champs de la vue tableau. */
export interface ActionArgs {
  data: Record<string, string | undefined>;
  value?: string;
  newNode?: string;
  linkFrom?: string;
  linkTo?: string;
  /** Le geste vient d'un doigt : pas de survol, une carte se soulève avant de se jouer. */
  touch?: boolean;
}

export interface ActionContext {
  store: Store;
  /** Le numéro de la prochaine tentative : il ne repart pas de 1 quand on change de scénario. */
  nextAttemptId: number;
}

export type Action = (s: ViewState, args: ActionArgs, ctx: ActionContext) => Outcome | undefined;

const select: Tool = { kind: 'select' };
/** La main de cartes refermée, sous toutes ses formes. */
const noHand = { buildAt: undefined, showHand: false, liftedCard: undefined } as const;
const patch = (p: Partial<ViewState>, ...effects: Effect[]): Outcome => (effects.length > 0 ? { patch: p, effects } : { patch: p });

/** La source et les services déjà en place ne se démolissent pas. */
export const permanent = (s: ViewState, node: ArchNode) => s.catalog.components[node.type]?.behavior === 'source' || !!node.fixed;

export const committedOrStart = (s: ViewState, game: GameState = s.game): Architecture =>
  game.committed.nodes.length > 0 ? game.committed : startOf(s.scenario);

function describeDraft(arch: Architecture): string {
  const types = arch.nodes.filter((n) => n.type !== 'traffic-source').map((n) => n.type);
  return types.length > 0 ? types.join(' + ') : 'vide';
}

/** Un placement du plateau accepté, ou sa raison de refus. */
export function applied(result: BoardResult, extra: Partial<ViewState> = {}): Outcome {
  return result.ok ? patch({ draft: result.arch, boardMessage: undefined, ...extra }) : patch({ boardMessage: result.reason });
}

/** Les tentatives ne sont pas sauvegardées : un résultat ne vaut que pour la calibration du moment. */
export function record(
  s: ViewState,
  attempt: Omit<Attempt, 'id' | 'settings' | 'arch' | 'stars' | 'analysis'>,
  id: number,
): Partial<ViewState> & { current: number } {
  const settings = changedSettings(defaultsOf(s.scenario.id), s, attempt.waveIndex);
  const wave = s.scenario.waves[attempt.waveIndex]!;
  const stars = starsFor(attempt.result, s.draft, wave, s.catalog);
  const analysis = analysisOf(undefined, { result: attempt.result, arch: s.draft }, wave, s.catalog, theme);
  return { attempts: [...s.attempts, { ...attempt, id, settings, arch: s.draft, stars, analysis }], selected: id, current: id };
}

export const actions: Record<string, Action> = {
  menu: (s) => patch({ showMenu: !s.showMenu }),
  'toggle-debug': (s) => patch({ debug: !s.debug, showMenu: false }),
  'debug-tab': (_, { data }) => patch({ debugTab: data.tab as ViewState['debugTab'] }),
  'debrief-tab': (_, { data }) => patch({ debriefTab: data.tab as ViewState['debriefTab'] }),
  'show-briefing': () => patch({ phase: 'briefing', showMenu: false }, { kind: 'leave-wave' }),
  'start-build': () => patch({ phase: 'build' }),
  'choose-scenario': () => patch({ phase: 'choose', showMenu: false, showReview: false }, { kind: 'leave-wave' }),
  'pick-scenario': (_, { data }, { store }) => {
    const { calibrated, ...picked } = gameOf(store, data.scenario!);
    const effects: Effect[] = [{ kind: 'forget-history' }];
    if (calibrated) effects.push({ kind: 'calibrated', id: data.scenario!, on: true });
    return patch(
      {
        ...picked,
        practice: undefined,
        attempts: [],
        selected: undefined,
        current: undefined,
        selectedNode: undefined,
        tool: select,
        phase: picked.game.finished ? 'build' : 'briefing',
        // Un scénario terminé s'ouvre sur son bilan, d'où chaque vague se rejoue.
        showReview: picked.game.finished,
      },
      ...effects,
    );
  },
  next: (s) => patch({ phase: s.game.finished ? 'build' : 'briefing', selectedNode: undefined }, { kind: 'leave-wave' }),
  // Rejouer une vague tenue (E10) : une partie de travail placée au début de la vague, la vraie mise de côté.
  'replay-wave': (s, { data }) => {
    const real = s.practice ?? { game: s.game, draft: s.draft };
    const k = Number(data.wave);
    if (!(k >= 0 && k < real.game.waveIndex)) return undefined;
    const game = practiceGame(real.game, k);
    return patch(
      { practice: real, game, draft: committedOrStart(s, game), selectedNode: undefined, tool: select, phase: 'briefing', showMenu: false, showReview: false },
      { kind: 'forget-history' },
      { kind: 'leave-wave' },
    );
  },
  // Fin du rejeu : la vraie partie reprend où elle était, avec son brouillon.
  'leave-practice': (s) => {
    if (!s.practice) return undefined;
    const { game, draft } = s.practice;
    return patch(
      { practice: undefined, game, draft, selectedNode: undefined, tool: select, phase: game.finished ? 'build' : 'briefing', showMenu: false },
      { kind: 'forget-history' },
      { kind: 'leave-wave' },
    );
  },
  retry: () => patch({ phase: 'build' }, { kind: 'leave-wave' }),
  // Un indice par essai perdu (I14) : la partie le garde, la fenêtre « que faire » le montre.
  hint: (s) => patch({ game: askHint({ game: s.game, scenario: s.scenario, catalog: s.catalog, draft: s.draft }) }),
  deselect: () => patch({ selectedNode: undefined, ...noHand }),
  undo: () => ({ effects: [{ kind: 'travel', direction: 'undo' }] }),
  redo: () => ({ effects: [{ kind: 'travel', direction: 'redo' }] }),

  tool: (_, { data }) => {
    const kind = data.tool as Tool['kind'];
    const tool: Tool = kind === 'place' ? { kind, type: data.type! } : kind === 'move' ? { kind, id: data.node! } : { kind };
    return patch({ tool, ...noHand, boardMessage: undefined, showMenu: false });
  },
  // « Bâtir » : la main s'ouvre sans case, et se referme au second clic.
  'open-hand': (s) =>
    patch({ ...noHand, showHand: !(s.showHand || s.buildAt), selectedNode: undefined, tool: select, boardMessage: undefined, showMenu: false }),
  /**
   * Une carte de la main. Au doigt, le premier contact la soulève et le second la joue. Sur
   * une case déjà désignée elle y bâtit ; sinon elle arme l'outil qui pose, et la main se
   * referme pour laisser voir le plateau.
   */
  'pick-card': (s, args, ctx) => {
    const type = args.data.type!;
    if (args.touch && s.liftedCard !== type) return patch({ liftedCard: type });
    if (s.buildAt) return actions['build-at']!(s, args, ctx);
    return patch({ tool: { kind: 'place', type }, ...noHand, selectedNode: undefined, boardMessage: undefined });
  },
  'build-at': (s, { data }) => {
    const cell = s.buildAt;
    if (!cell) return undefined;
    const result = placeNode(s.draft, data.type!, cell, s.catalog);
    // Le bâtiment posé est sélectionné : ses pastilles d'évolution apparaissent aussitôt.
    const placed = result.ok ? result.arch.nodes.find((n) => !s.draft.nodes.some((o) => o.id === n.id))?.id : undefined;
    return applied(result, { ...noHand, selectedNode: placed });
  },
  'close-build': () => patch({ ...noHand }),

  'add-node': (s, { newNode }) => patch({ draft: addNode(s.draft, newNode!) }),
  'remove-node': (s, { data }) => {
    const node = s.draft.nodes.find((n) => n.id === data.node);
    if (!node || permanent(s, node)) return undefined;
    return patch({ draft: removeNode(s.draft, node.id), selectedNode: undefined, tool: select });
  },
  'upgrade-step': (s, { data }) => {
    const node = s.draft.nodes.find((n) => n.id === data.node);
    const up = s.catalog.upgrades[data.upgrade!];
    if (!node || !up) return undefined;
    const level = node.upgrades?.[up.id] ?? 0;
    const next = data.delta === 'toggle' ? (level > 0 ? 0 : 1) : Math.min(up.maxLevel, Math.max(0, level + Number(data.delta)));
    return next !== level ? patch({ draft: setUpgrade(s.draft, node.id, up.id, next) }) : undefined;
  },
  upgrade: (s, { data, value }) => patch({ draft: setUpgrade(s.draft, data.node!, data.upgrade!, Number(value)) }),
  'add-link': (s, { linkFrom, linkTo }) => {
    const refused = linkRefusal(s.draft, linkFrom!, linkTo!, s.catalog);
    if (refused) return patch({ boardMessage: refused });
    const result = connect(s.draft, linkFrom!, linkTo!);
    // La vue tableau garde son lien même sans chemin possible : le plateau en trace un à défaut.
    return patch(result.ok ? { draft: result.arch } : { draft: addLink(s.draft, linkFrom!, linkTo!), boardMessage: result.reason });
  },
  'remove-link': (s, { data }) => patch({ draft: removeLink(s.draft, Number(data.link)) }),
  revert: (s) => patch({ draft: committedOrStart(s), selectedNode: undefined }),

  play: (s, _, { nextAttemptId: id }) => {
    const waveIndex = s.game.waveIndex;
    const wave = s.scenario.waves[waveIndex]!;
    const { state: game, result, stars } = playWave(s.game, s.scenario, s.draft, s.catalog);
    const label = `#${id} V${waveIndex + 1} ${s.practice ? 'rejeu ' : ''}${describeDraft(s.draft)}`;
    // Le brouillon est gardé même perdu : on le corrige plutôt que de tout reposer.
    // Les succès (I20) : les parades qui ont joué, et « sans indice » quand la vraie partie s'achève sans en avoir pris.
    const finishing = !s.practice && game.finished;
    const ids = [...earned(result, s.draft, wave, s.catalog), ...noHintEarned(s.scenario.id, finishing, game.hinted)];
    const unlocked = ids.filter((x) => !s.achievements[x]);
    const achievements = unlocked.length > 0 ? { ...s.achievements, ...Object.fromEntries(unlocked.map((x) => [x, { scenario: s.scenario.id, wave: waveIndex }])) } : s.achievements;
    const base = record(s, { label: `${label}${result.won ? '' : ` (perdue : ${wave.title})`}`, waveIndex, result, played: true }, id);
    const recorded = { ...base, achievements, attempts: base.attempts!.map((a) => (a.id === id ? { ...a, unlocked } : a)) };
    if (s.practice) {
      // Un rejeu gagné n'apporte à la vraie partie que ses étoiles ; la partie de travail, elle, avance comme une autre.
      const before = s.practice.game.stars.reduce((a, x) => a + starCount(x), 0);
      const real = result.won ? withReplayedStars(s.practice.game, waveIndex, stars) : s.practice.game;
      return patch({ game, practice: { ...s.practice, game: real, before }, ...recorded }, { kind: 'forget-history' }, { kind: 'attempt-recorded' }, { kind: 'play', attempt: id });
    }
    return patch({ game, ...recorded }, { kind: 'forget-history' }, { kind: 'attempt-recorded' }, { kind: 'play', attempt: id });
  },
  try: (s, _, { nextAttemptId: id }) => {
    const waveIndex = s.game.waveIndex;
    const result = simulateWave(s.draft, s.scenario.waves[waveIndex]!, s.catalog);
    const label = `#${id} V${waveIndex + 1} essai ${describeDraft(s.draft)}`;
    const recorded = record(s, { label, waveIndex, result, played: false }, id);
    return patch(recorded, { kind: 'attempt-recorded' }, { kind: 'play', attempt: id });
  },
  select: (_, { data }) => patch({ selected: Number(data.attempt) }),
  replay: (s, { data }) => {
    const attempt = s.attempts.find((a) => a.id === Number(data.attempt));
    return attempt ? { effects: [{ kind: 'play', attempt: attempt.id }] } : undefined;
  },

  calibrate: (s, { data, value }) => {
    const parsed = parseField(value ?? '', { path: data.path!, label: '', list: data.list === '1' });
    if (parsed === undefined) return undefined;
    const changed = data.root === 'catalog' ? { catalog: setAt(s.catalog, data.path!, parsed) } : { scenario: setAt(s.scenario, data.path!, parsed) };
    return patch(changed, { kind: 'calibrated', id: s.scenario.id, on: true });
  },
  'reset-calibration': (s) => {
    const defaults = defaultsOf(s.scenario.id);
    return patch({ catalog: structuredClone(defaults.catalog), scenario: structuredClone(defaults.scenario) }, { kind: 'calibrated', id: s.scenario.id, on: false });
  },
  export: (s) => ({ effects: [{ kind: 'export', text: JSON.stringify({ catalog: s.catalog, scenario: s.scenario }, null, 2) }] }),
  // La fenêtre des succès : depuis le menu ou l'écran de choix, elle passe devant le reste.
  'show-achievements': (s) => patch({ showAchievements: !s.showAchievements, showMenu: false }),
  // L'accueil (P4) : le fermer le marque comme vu ; le menu et l'écran de choix le rouvrent.
  'show-welcome': (s) => (s.showWelcome ? patch({ showWelcome: false }, { kind: 'welcomed' }) : patch({ showWelcome: true, showMenu: false })),
  'show-review': (s) => patch({ showReview: !s.showReview, showMenu: false }),
  'reset-game': (s) =>
    patch(
      { practice: undefined, game: newGame(), draft: startOf(s.scenario), attempts: [], selected: undefined, selectedNode: undefined, phase: 'briefing', showMenu: false, showReview: false },
      { kind: 'forget-history' },
      { kind: 'leave-wave' },
    ),
};

// ——— Le plateau ———

/** Où l'outil courant peut agir : le curseur hexagonal rougit ailleurs. */
export function canUse(s: ViewState, cell: BoardCell): boolean {
  if (s.phase !== 'build') return false;
  const here = nodeAt(s.draft, cell);
  switch (s.tool.kind) {
    case 'place':
    case 'move':
      return insideBoard(cell) && !isRiver(cell) && (!here || (s.tool.kind === 'move' && here.id === s.tool.id));
    case 'link':
      return here !== undefined;
    case 'remove':
      return here !== undefined && !permanent(s, here);
    case 'select':
      return true;
  }
}

/** On saisit un bâtiment en mode sélection ; les clients restent à l'entrée du plateau. */
export function canDrag(s: ViewState, cell: BoardCell): boolean {
  if (s.phase !== 'build' || s.tool.kind !== 'select') return false;
  const here = nodeAt(s.draft, cell);
  return here !== undefined && s.catalog.components[here.type]?.behavior !== 'source';
}

export function dragStart(s: ViewState, cell: BoardCell): Outcome | undefined {
  const here = nodeAt(s.draft, cell);
  return here ? patch({ tool: { kind: 'move', id: here.id }, selectedNode: here.id, boardMessage: undefined }) : undefined;
}

export function drop(s: ViewState, cell: BoardCell | undefined): Outcome | undefined {
  const tool = s.tool;
  if (tool.kind !== 'move') return undefined;
  const node = s.draft.nodes.find((n) => n.id === tool.id);
  const back = { tool: select, selectedNode: tool.id };
  // Lâché hors du plateau ou sur sa propre case : rien ne bouge.
  if (!cell || !node || (node.cell && node.cell.q === cell.q && node.cell.r === cell.r)) return patch(back);
  const result = moveNode(s.draft, tool.id, cell);
  return patch(result.ok ? { draft: result.arch, boardMessage: undefined, ...back } : { boardMessage: result.reason, ...back });
}

/**
 * Une carte glissée hors de la main jusqu'au plateau y est posée, comme avec l'outil qui pose.
 * La main se referme dès que la carte part : c'est le plateau qui doit recevoir le lâcher.
 */
export const cardDragged = (type: string): Outcome => patch({ tool: { kind: 'place', type }, ...noHand, selectedNode: undefined, boardMessage: undefined });
export const cardDropped = (s: ViewState, type: string, cell: BoardCell): Outcome =>
  applied(placeNode(s.draft, type, cell, s.catalog), { tool: select });

export function boardClick(s: ViewState, cell: BoardCell): Outcome | undefined {
  if (s.phase !== 'build') return undefined;
  const here = nodeAt(s.draft, cell);
  const tool = s.tool;
  switch (tool.kind) {
    case 'select':
      // Une case vide où l'on peut bâtir ouvre les fiches des bâtiments à y construire.
      return patch({
        selectedNode: here?.id,
        ...noHand,
        buildAt: !here && insideBoard(cell) && !isRiver(cell) ? cell : undefined,
        boardMessage: undefined,
        showMenu: false,
      });
    case 'place':
      // Posé, on repasse à la sélection : le guide demande déjà autre chose (relier), et un
      // outil qui pose encore laisserait son invite « cliquer la case où bâtir » à l'écran.
      return applied(placeNode(s.draft, tool.type, cell, s.catalog), { tool: select });
    case 'move':
      return applied(moveNode(s.draft, tool.id, cell), { tool: select, selectedNode: tool.id });
    case 'link':
      if (!here) return patch({ boardMessage: 'Cliquer un bâtiment.' });
      if (!tool.from) return patch({ tool: { kind: 'link', from: here.id }, boardMessage: undefined });
      return applied(connect(s.draft, tool.from, here.id, s.catalog), { tool: { kind: 'link' } });
    case 'remove':
      if (!here || permanent(s, here)) return undefined;
      return patch({ draft: removeNode(s.draft, here.id), selectedNode: undefined, boardMessage: undefined });
  }
}

// ——— Le clavier ———

/** Les raccourcis : Échap revient à la sélection, ⌘Z / ⇧⌘Z / ⌘Y annulent et rétablissent, D ouvre le debug. */
export function keyPressed(s: ViewState, key: string, mods: { meta: boolean; ctrl: boolean; shift: boolean }): { outcome?: Outcome; preventDefault: boolean } {
  if (key === 'Escape' && s.phase === 'build') {
    return { outcome: patch({ tool: select, ...noHand, boardMessage: undefined, showMenu: false }), preventDefault: false };
  }
  if ((mods.meta || mods.ctrl) && (key === 'z' || key === 'Z' || key === 'y')) {
    return { outcome: { effects: [{ kind: 'travel', direction: key === 'y' || mods.shift ? 'redo' : 'undo' }] }, preventDefault: true };
  }
  if (key === 'd' || key === 'D') return { outcome: patch({ debug: !s.debug }), preventDefault: false };
  return { preventDefault: false };
}
