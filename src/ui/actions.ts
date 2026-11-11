import { scoring } from '../data/scoring.ts';
import { fortifiedCity as theme } from '../data/themes/fortified-city.ts';
import { newGame, playWave, rewindTo, type GameState } from '../engine/game.ts';
import { scoreWave, starsFor } from '../engine/score.ts';
import { simulateWave } from '../engine/simulate.ts';
import type { Architecture, ArchNode, BoardCell } from '../engine/types.ts';
import { isRiver } from '../render/terrain.ts';
import { connect, insideBoard, moveNode, nodeAt, placeNode, type BoardResult } from './board.ts';
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
  | { kind: 'export'; text: string };

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
}

export interface ActionContext {
  store: Store;
  /** Le numéro de la prochaine tentative : il ne repart pas de 1 quand on change de scénario. */
  nextAttemptId: number;
}

export type Action = (s: ViewState, args: ActionArgs, ctx: ActionContext) => Outcome | undefined;

const select: Tool = { kind: 'select' };
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
  replays: number,
  id: number,
): Partial<ViewState> & { current: number } {
  const settings = changedSettings(defaultsOf(s.scenario.id), s, attempt.waveIndex);
  const wave = s.scenario.waves[attempt.waveIndex]!;
  const stars = starsFor(attempt.result, replays, wave);
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
  'choose-scenario': () => patch({ phase: 'choose', showMenu: false }, { kind: 'leave-wave' }),
  'pick-scenario': (_, { data }, { store }) => {
    const { calibrated, ...picked } = gameOf(store, data.scenario!);
    const effects: Effect[] = [{ kind: 'forget-history' }];
    if (calibrated) effects.push({ kind: 'calibrated', id: data.scenario!, on: true });
    return patch(
      {
        ...picked,
        attempts: [],
        selected: undefined,
        current: undefined,
        selectedNode: undefined,
        tool: select,
        phase: picked.game.finished ? 'build' : 'briefing',
      },
      ...effects,
    );
  },
  next: (s) => patch({ phase: s.game.finished ? 'build' : 'briefing', selectedNode: undefined }, { kind: 'leave-wave' }),
  retry: () => patch({ phase: 'build' }, { kind: 'leave-wave' }),
  // Un indice par essai perdu (I14) : la partie le garde, la fenêtre « que faire » le montre.
  hint: (s) => patch({ game: askHint({ game: s.game, scenario: s.scenario, catalog: s.catalog, draft: s.draft }) }),
  deselect: () => patch({ selectedNode: undefined, buildAt: undefined }),
  undo: () => ({ effects: [{ kind: 'travel', direction: 'undo' }] }),
  redo: () => ({ effects: [{ kind: 'travel', direction: 'redo' }] }),

  tool: (_, { data }) => {
    const kind = data.tool as Tool['kind'];
    const tool: Tool = kind === 'place' ? { kind, type: data.type! } : kind === 'move' ? { kind, id: data.node! } : { kind };
    return patch({ tool, buildAt: undefined, boardMessage: undefined, showMenu: false });
  },
  'build-at': (s, { data }) => {
    const cell = s.buildAt;
    if (!cell) return undefined;
    const result = placeNode(s.draft, data.type!, cell, s.catalog);
    // Le bâtiment posé est sélectionné : ses pastilles d'évolution apparaissent aussitôt.
    const placed = result.ok ? result.arch.nodes.find((n) => !s.draft.nodes.some((o) => o.id === n.id))?.id : undefined;
    return applied(result, { buildAt: undefined, selectedNode: placed });
  },
  'close-build': () => patch({ buildAt: undefined }),

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
    const result = connect(s.draft, linkFrom!, linkTo!);
    // La vue tableau garde son lien même sans chemin possible : le plateau en trace un à défaut.
    return patch(result.ok ? { draft: result.arch } : { draft: addLink(s.draft, linkFrom!, linkTo!), boardMessage: result.reason });
  },
  'remove-link': (s, { data }) => patch({ draft: removeLink(s.draft, Number(data.link)) }),
  revert: (s) => patch({ draft: committedOrStart(s), selectedNode: undefined }),

  play: (s, _, { nextAttemptId: id }) => {
    const waveIndex = s.game.waveIndex;
    const wave = s.scenario.waves[waveIndex]!;
    const replays = s.game.replays;
    const { state: game, result, score } = playWave(s.game, s.scenario, s.draft, s.catalog, scoring);
    const label = `#${id} V${waveIndex + 1} ${describeDraft(s.draft)}`;
    // Le brouillon est gardé même perdu : on le corrige plutôt que de tout reposer.
    // La facture, elle, compte toujours depuis l'architecture validée.
    const recorded = record(s, { label: `${label}${result.won ? '' : ` (perdue : ${wave.title})`}`, waveIndex, result, score, played: true }, replays, id);
    return patch({ game, ...recorded }, { kind: 'forget-history' }, { kind: 'attempt-recorded' }, { kind: 'play', attempt: id });
  },
  try: (s, _, { nextAttemptId: id }) => {
    const waveIndex = s.game.waveIndex;
    const result = simulateWave(s.draft, s.scenario.waves[waveIndex]!, s.catalog, s.game.committed);
    const label = `#${id} V${waveIndex + 1} essai ${describeDraft(s.draft)}`;
    const recorded = record(s, { label, waveIndex, result, score: scoreWave(result, s.game.replays, scoring), played: false }, s.game.replays, id);
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
  rewind: (s, { data }) => {
    const game = rewindTo(s.game, Number(data.wave));
    return patch(
      { game, draft: committedOrStart(s, game), selectedNode: undefined, phase: 'briefing', showMenu: false },
      { kind: 'forget-history' },
      { kind: 'leave-wave' },
    );
  },
  'reset-game': (s) =>
    patch(
      { game: newGame(), draft: startOf(s.scenario), attempts: [], selected: undefined, selectedNode: undefined, phase: 'briefing', showMenu: false },
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

/** Un bâtiment de la palette glissé jusqu'au plateau y est posé, comme avec l'outil Poser. */
export const paletteDragged = (type: string): Outcome => patch({ tool: { kind: 'place', type }, boardMessage: undefined });
export const paletteDropped = (s: ViewState, type: string, cell: BoardCell): Outcome =>
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
        buildAt: !here && insideBoard(cell) && !isRiver(cell) ? cell : undefined,
        boardMessage: undefined,
        showMenu: false,
      });
    case 'place':
      return applied(placeNode(s.draft, tool.type, cell, s.catalog));
    case 'move':
      return applied(moveNode(s.draft, tool.id, cell), { tool: select, selectedNode: tool.id });
    case 'link':
      if (!here) return patch({ boardMessage: 'Cliquer un bâtiment.' });
      if (!tool.from) return patch({ tool: { kind: 'link', from: here.id }, boardMessage: undefined });
      return applied(connect(s.draft, tool.from, here.id), { tool: { kind: 'link' } });
    case 'remove':
      if (!here || permanent(s, here)) return undefined;
      return patch({ draft: removeNode(s.draft, here.id), selectedNode: undefined, boardMessage: undefined });
  }
}

// ——— Le clavier ———

/** Les raccourcis : Échap revient à la sélection, ⌘Z / ⇧⌘Z / ⌘Y annulent et rétablissent, D ouvre le debug. */
export function keyPressed(s: ViewState, key: string, mods: { meta: boolean; ctrl: boolean; shift: boolean }): { outcome?: Outcome; preventDefault: boolean } {
  if (key === 'Escape' && s.phase === 'build') {
    return { outcome: patch({ tool: select, buildAt: undefined, boardMessage: undefined, showMenu: false }), preventDefault: false };
  }
  if ((mods.meta || mods.ctrl) && (key === 'z' || key === 'Z' || key === 'y')) {
    return { outcome: { effects: [{ kind: 'travel', direction: key === 'y' || mods.shift ? 'redo' : 'undo' }] }, preventDefault: true };
  }
  if (key === 'd' || key === 'D') return { outcome: patch({ debug: !s.debug }), preventDefault: false };
  return { preventDefault: false };
}
