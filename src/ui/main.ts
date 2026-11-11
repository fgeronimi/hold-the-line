import { catalog as defaultCatalog } from '../data/catalog.ts';
import { SCENARIOS, scenarioById } from '../data/scenarios/index.ts';
import { scoring } from '../data/scoring.ts';
import { fortifiedCity as theme } from '../data/themes/fortified-city.ts';
import { newGame, playWave, rewindTo } from '../engine/game.ts';
import { scoreWave, starsFor } from '../engine/score.ts';
import { simulateWave } from '../engine/simulate.ts';
import type { Architecture, BoardCell } from '../engine/types.ts';
import type { CityScene } from '../render/scene.ts';
import { isRiver } from '../render/terrain.ts';
import { attachChart, chartModel } from '../render/charts.ts';
import { autoPlace, connect, insideBoard, moveNode, nodeAt, placeNode, type BoardResult } from './board.ts';
import { changedSettings, parseField, setAt } from './calibration.ts';
import { addLink, addNode, removeLink, removeNode, setUpgrade } from './editor.ts';
import { askHint } from './hints.ts';
import { load, save } from './storage.ts';
import {
  renderCard,
  renderDebug,
  renderDialog,
  renderHud,
  renderToolbar,
  hintsOf,
  upgradePips,
  type Attempt,
  type Tool,
  type ViewState,
} from './views.ts';
import './style.css';

/** Le plateau de départ d'un scénario : la source, et les services déjà en place. */
function startOf(scenario: ViewState['scenario']): Architecture {
  return { nodes: [{ id: 'src', type: 'traffic-source', cell: { q: 0, r: 0 } }, ...structuredClone(scenario.fixtures ?? [])], links: [] };
}

/** Une partie commencée avant l'arrivée des services déjà en place les reçoit. */
function withFixtures(draft: Architecture, scenario: ViewState['scenario']): Architecture {
  const missing = (scenario.fixtures ?? []).filter((f) => !draft.nodes.some((n) => n.id === f.id));
  return missing.length > 0 ? { ...draft, nodes: [...draft.nodes, ...structuredClone(missing)] } : draft;
}

/** La source et les services déjà en place ne se démolissent pas. */
const permanent = (node: Architecture['nodes'][number]) =>
  state.catalog.components[node.type]?.behavior === 'source' || !!node.fixed;

type Saved = Pick<ViewState, 'game' | 'draft'> & {
  /**
   * Seulement si le joueur a calibré en debug : sinon catalogue et scénario viennent du
   * code, pour qu'une partie en cours profite des données mises à jour (rampe, chiffres…).
   */
  calibration?: Pick<ViewState, 'catalog' | 'scenario'>;
};

/** Une partie par scénario (décision S2), et le dernier scénario joué. */
interface Store {
  current?: string;
  saves: Record<string, Saved>;
}

const store: Store = load<Store>() ?? { saves: {} };

/** Les scénarios dont le joueur a touché le calibrage. */
const calibrated = new Set<string>();

const defaultScenario = (id: string) => scenarioById(id) ?? SCENARIOS[0]!.scenario;

/** La partie d'un scénario : celle sauvegardée, ou une nouvelle. */
function gameOf(id: string): Pick<ViewState, 'catalog' | 'scenario' | 'game' | 'draft'> {
  const saved = store.saves[id];
  if (saved?.calibration) calibrated.add(id);
  const scenario = saved?.calibration?.scenario ?? structuredClone(defaultScenario(id));
  return {
    catalog: saved?.calibration?.catalog ?? structuredClone(defaultCatalog),
    scenario,
    game: saved?.game ?? newGame(),
    // Un brouillon d'avant le plateau reçoit des cases et des chemins une fois pour toutes.
    draft: autoPlace(withFixtures(saved?.draft ?? startOf(scenario), scenario)),
  };
}

function initialState(): ViewState {
  return {
    ...gameOf(store.current ?? SCENARIOS[0]!.scenario.id),
    attempts: [],
    tool: { kind: 'select' },
    history: { undo: 0, redo: 0 },
    // Chaque session s'ouvre sur l'écran de choix du scénario.
    phase: 'choose',
    debug: new URLSearchParams(location.search).has('debug'),
    debugTab: 'attempts',
    debriefTab: 'analysis',
    showMenu: false,
    choices: choices(),
  };
}

/** Ce que l'écran de choix montre de chaque scénario : sa progression et ses étoiles. */
function choices(): ViewState['choices'] {
  return SCENARIOS.map(({ scenario, level, pitch }) => {
    const game = store.saves[scenario.id]?.game;
    return {
      id: scenario.id,
      title: scenario.title,
      subtitle: scenario.subtitle,
      level,
      pitch,
      waves: scenario.waves.length,
      reached: game?.waveIndex ?? 0,
      stars: game?.stars.reduce((a, x) => a + x, 0) ?? 0,
      finished: game?.finished ?? false,
    };
  });
}

const root = document.getElementById('app')!;
root.innerHTML = `
  <div id="board" class="board"><p class="replay-loading">Chargement de la cité…</p></div>
  <div id="hud" class="layer top"></div>
  <div id="card" class="layer right"></div>
  <div id="toolbar" class="layer bottom"></div>
  <div id="dialog" class="layer center"></div>
  <div id="debug" class="layer debug-layer"></div>`;
const regions = {
  board: document.getElementById('board')!,
  hud: document.getElementById('hud')!,
  card: document.getElementById('card')!,
  toolbar: document.getElementById('toolbar')!,
  dialog: document.getElementById('dialog')!,
  debug: document.getElementById('debug')!,
};

let state = initialState();
let nextAttemptId = 1;
let scene: CityScene | undefined;
let stopWave: (() => void) | undefined;
/** Ce que le plateau affiche déjà : on ne le reconstruit que si le brouillon ou le catalogue change. */
let shown: { draft: Architecture; catalog: ViewState['catalog'] } | undefined;

/**
 * Annuler et rétablir, pendant la construction. Pas sauvegardé : une session qui recommence
 * repart de son brouillon. Remis à zéro dès que le brouillon change de nature (vague lancée,
 * autre scénario, retour en arrière dans la partie).
 */
const undo: Architecture[] = [];
const redo: Architecture[] = [];
const MAX_UNDO = 50;
let restoring = false;

function forgetHistory(): void {
  undo.length = 0;
  redo.length = 0;
}

function update(patch: Partial<ViewState>): void {
  // Tout brouillon passe par le plateau : un bâtiment ajouté sans case (vue tableau) en reçoit une.
  if (patch.draft) patch = { ...patch, draft: autoPlace(patch.draft) };
  if (patch.draft && patch.draft !== state.draft && state.phase === 'build' && !restoring) {
    undo.push(state.draft);
    if (undo.length > MAX_UNDO) undo.shift();
    redo.length = 0;
  }
  state = { ...state, ...patch, history: { undo: undo.length, redo: redo.length } };
  if (state.phase !== 'choose') {
    store.current = state.scenario.id;
    const id = state.scenario.id;
    const calibration = calibrated.has(id) ? { catalog: state.catalog, scenario: state.scenario } : undefined;
    store.saves[id] = { game: state.game, draft: state.draft, ...(calibration && { calibration }) };
    save(store);
    state.choices = choices();
  }
  render();
}

function render(): void {
  regions.hud.innerHTML = renderHud(state);
  regions.card.innerHTML = renderCard(state);
  regions.toolbar.innerHTML = renderToolbar(state);
  regions.dialog.innerHTML = renderDialog(state);
  regions.debug.innerHTML = renderDebug(state);
  document.body.classList.toggle('debug-open', state.debug);
  attachDebriefChart();
  syncBoard();
}

/** Le survol des courbes du debrief : le HTML est réécrit à chaque rendu, on le rebranche. */
function attachDebriefChart(): void {
  const root = regions.dialog.querySelector<HTMLElement>('[data-chart="root"]');
  const a = state.attempts.find((x) => x.id === state.current);
  const wave = a && state.scenario.waves[a.waveIndex];
  if (root && a && wave) attachChart(root, chartModel(a.result, a.arch, wave, state.catalog, theme));
}

/** Aligne le plateau 3D sur l'état : architecture, bâtiment marqué, fantôme de l'outil. */
function syncBoard(): void {
  if (!scene || state.phase === 'wave') return;
  if (!shown || shown.draft !== state.draft || shown.catalog !== state.catalog) {
    scene.setArchitecture(state.draft, state.catalog);
    shown = { draft: state.draft, catalog: state.catalog };
  }
  const { tool } = state;
  const building = state.phase === 'build';
  scene.setGhost(
    building && tool.kind === 'place'
      ? tool.type
      : building && tool.kind === 'move'
        ? state.draft.nodes.find((n) => n.id === tool.id)?.type
        : undefined,
  );
  // Le bâtiment que vise le dernier indice : marqué tant que rien n'est sélectionné.
  const blink = building ? hintsOf(state).highlight : undefined;
  if (!building) scene.setMarked(undefined);
  else if (tool.kind === 'link' && tool.from) scene.setMarked(tool.from, '#3a86ff');
  else if (tool.kind === 'move') scene.setMarked(tool.id, '#9b5de5');
  else if (state.buildAt) scene.setMarkedAt(state.buildAt, '#2a9d8f');
  else if (!state.selectedNode && blink?.node) scene.setMarked(blink.node, '#e9a23b');
  else scene.setMarked(state.selectedNode);
  // Les pastilles d'évolution, au pied du bâtiment sélectionné, seulement à la construction.
  const selected = building && tool.kind === 'select' ? state.draft.nodes.find((n) => n.id === state.selectedNode) : undefined;
  const can = selected && { move: state.catalog.components[selected.type]?.behavior !== 'source', remove: !permanent(selected) };
  scene.setPips(selected?.id, selected && can ? upgradePips(selected, state.catalog, can, blink) : '');
}

/** Où l'outil courant peut agir : le curseur hexagonal rougit ailleurs. */
function canUse(cell: BoardCell): boolean {
  if (state.phase !== 'build') return false;
  const here = nodeAt(state.draft, cell);
  switch (state.tool.kind) {
    case 'place':
    case 'move':
      return insideBoard(cell) && !isRiver(cell) && (!here || (state.tool.kind === 'move' && here.id === state.tool.id));
    case 'link':
      return here !== undefined;
    case 'remove':
      return here !== undefined && !permanent(here);
    case 'select':
      return true;
  }
}

function applied(result: BoardResult, extra: Partial<ViewState> = {}): void {
  if (result.ok) update({ draft: result.arch, boardMessage: undefined, ...extra });
  else update({ boardMessage: result.reason });
}

/** Revient au brouillon d'avant (ou d'après) : la dernière action de construction. */
function travel(from: Architecture[], to: Architecture[]): void {
  const draft = from.pop();
  if (!draft || state.phase !== 'build') return;
  to.push(state.draft);
  restoring = true;
  update({ draft, selectedNode: undefined, tool: { kind: 'select' }, boardMessage: undefined });
  restoring = false;
}

/** On saisit un bâtiment en mode sélection ; les clients restent à l'entrée du plateau. */
function canDrag(cell: BoardCell): boolean {
  if (state.phase !== 'build' || state.tool.kind !== 'select') return false;
  const here = nodeAt(state.draft, cell);
  return here !== undefined && state.catalog.components[here.type]?.behavior !== 'source';
}

function onDragStart(cell: BoardCell): void {
  const here = nodeAt(state.draft, cell);
  if (here) update({ tool: { kind: 'move', id: here.id }, selectedNode: here.id, boardMessage: undefined });
}

function onDrop(cell: BoardCell | undefined): void {
  const tool = state.tool;
  if (tool.kind !== 'move') return;
  const node = state.draft.nodes.find((n) => n.id === tool.id);
  const back = { tool: { kind: 'select' } as Tool, selectedNode: tool.id };
  // Lâché hors du plateau ou sur sa propre case : rien ne bouge.
  if (!cell || !node || (node.cell && node.cell.q === cell.q && node.cell.r === cell.r)) return update(back);
  const result = moveNode(state.draft, tool.id, cell);
  update(result.ok ? { draft: result.arch, boardMessage: undefined, ...back } : { boardMessage: result.reason, ...back });
}

/** Un bâtiment de la palette glissé jusqu'au plateau y est posé, comme avec l'outil Poser. */
let paletteDrag: { type: string; x: number; y: number; moved: boolean } | undefined;
root.addEventListener('pointerdown', (e) => {
  const button = (e.target as Element).closest<HTMLElement>('[data-tool="place"][data-type]');
  if (!button || state.phase !== 'build') return;
  paletteDrag = { type: button.dataset.type!, x: e.clientX, y: e.clientY, moved: false };
});
window.addEventListener('pointermove', (e) => {
  if (!paletteDrag || paletteDrag.moved || Math.hypot(e.clientX - paletteDrag.x, e.clientY - paletteDrag.y) < 6) return;
  paletteDrag.moved = true;
  update({ tool: { kind: 'place', type: paletteDrag.type }, boardMessage: undefined });
});
window.addEventListener('pointerup', (e) => {
  const drag = paletteDrag;
  paletteDrag = undefined;
  if (!drag?.moved || !scene || !(e.target instanceof HTMLCanvasElement)) return;
  const cell = scene.cellAt(e.clientX, e.clientY);
  if (cell) applied(placeNode(state.draft, drag.type, cell, state.catalog), { tool: { kind: 'select' } });
});

function onBoardClick(cell: BoardCell): void {
  if (state.phase !== 'build') return;
  const here = nodeAt(state.draft, cell);
  const tool = state.tool;
  switch (tool.kind) {
    case 'select':
      // Une case vide où l'on peut bâtir ouvre les fiches des bâtiments à y construire.
      update({
        selectedNode: here?.id,
        buildAt: !here && insideBoard(cell) && !isRiver(cell) ? cell : undefined,
        boardMessage: undefined,
        showMenu: false,
      });
      return;
    case 'place':
      return applied(placeNode(state.draft, tool.type, cell, state.catalog));
    case 'move':
      return applied(moveNode(state.draft, tool.id, cell), { tool: { kind: 'select' }, selectedNode: tool.id });
    case 'link':
      if (!here) return update({ boardMessage: 'Cliquer un bâtiment.' });
      if (!tool.from) return update({ tool: { kind: 'link', from: here.id }, boardMessage: undefined });
      return applied(connect(state.draft, tool.from, here.id), { tool: { kind: 'link' } });
    case 'remove':
      if (!here || permanent(here)) return;
      update({ draft: removeNode(state.draft, here.id), selectedNode: undefined, boardMessage: undefined });
      return;
  }
}

/** Les tentatives ne sont pas sauvegardées : un résultat ne vaut que pour la calibration du moment. */
function record(attempt: Omit<Attempt, 'id' | 'settings' | 'arch' | 'stars'>, replays: number): Partial<ViewState> & { current: number } {
  const id = nextAttemptId++;
  const settings = changedSettings({ catalog: defaultCatalog, scenario: defaultScenario(state.scenario.id) }, state, attempt.waveIndex);
  const stars = starsFor(attempt.result, replays, state.scenario.waves[attempt.waveIndex]!);
  return { attempts: [...state.attempts, { ...attempt, id, settings, arch: state.draft, stars }], selected: id, current: id };
}

/** Joue une tentative en direct sur le plateau, puis ouvre son debrief. */
async function playOnBoard(attempt: Attempt): Promise<void> {
  if (!scene) return update({ phase: 'debrief', current: attempt.id });
  const { startReplay } = await import('../render/replay.ts');
  stopWave?.();
  const wave = state.scenario.waves[attempt.waveIndex]!;
  update({ phase: 'wave', debriefTab: 'analysis', current: attempt.id, selectedNode: undefined, buildAt: undefined, tool: { kind: 'select' }, showMenu: false });
  stopWave = startReplay(scene, regions.board, {
    title: `Vague ${attempt.waveIndex + 1} — ${wave.title}`,
    arch: attempt.arch,
    result: attempt.result,
    wave,
    catalog: state.catalog,
    theme,
    onEnd: () => update({ phase: 'debrief' }),
  });
}

/** Quitte le plateau animé : il revient au brouillon de construction. */
function leaveWave(): void {
  stopWave?.();
  stopWave = undefined;
  shown = undefined;
}

function describeDraft(arch: Architecture): string {
  const types = arch.nodes.filter((n) => n.type !== 'traffic-source').map((n) => n.type);
  return types.length > 0 ? types.join(' + ') : 'vide';
}

const committedOrStart = (game = state.game) => (game.committed.nodes.length > 0 ? game.committed : startOf(state.scenario));

const actions: Record<string, (el: HTMLElement) => void> = {
  menu: () => update({ showMenu: !state.showMenu }),
  'toggle-debug': () => update({ debug: !state.debug, showMenu: false }),
  'debug-tab': (el) => update({ debugTab: el.dataset.tab as ViewState['debugTab'] }),
  'debrief-tab': (el) => update({ debriefTab: el.dataset.tab as ViewState['debriefTab'] }),
  'show-briefing': () => {
    leaveWave();
    update({ phase: 'briefing', showMenu: false });
  },
  'start-build': () => update({ phase: 'build' }),
  'choose-scenario': () => {
    leaveWave();
    update({ phase: 'choose', showMenu: false });
  },
  'pick-scenario': (el) => {
    forgetHistory();
    const picked = gameOf(el.dataset.scenario!);
    update({
      ...picked,
      attempts: [],
      selected: undefined,
      current: undefined,
      selectedNode: undefined,
      tool: { kind: 'select' },
      phase: picked.game.finished ? 'build' : 'briefing',
    });
  },
  next: () => {
    leaveWave();
    update({ phase: state.game.finished ? 'build' : 'briefing', selectedNode: undefined });
  },
  retry: () => {
    leaveWave();
    update({ phase: 'build' });
  },
  // Un indice par essai perdu (I14) : la partie le garde, la fenêtre « que faire » le montre.
  hint: () => update({ game: askHint({ game: state.game, scenario: state.scenario, catalog: state.catalog, draft: state.draft }) }),
  deselect: () => update({ selectedNode: undefined, buildAt: undefined }),
  undo: () => travel(undo, redo),
  redo: () => travel(redo, undo),

  tool: (el) => {
    const kind = el.dataset.tool as Tool['kind'];
    const tool: Tool =
      kind === 'place'
        ? { kind, type: el.dataset.type! }
        : kind === 'move'
          ? { kind, id: el.dataset.node! }
          : kind === 'link'
            ? { kind }
            : { kind };
    update({ tool, buildAt: undefined, boardMessage: undefined, showMenu: false });
  },
  'build-at': (el) => {
    const cell = state.buildAt;
    if (!cell) return;
    const result = placeNode(state.draft, el.dataset.type!, cell, state.catalog);
    // Le bâtiment posé est sélectionné : ses pastilles d'évolution apparaissent aussitôt.
    const placed = result.ok ? result.arch.nodes.find((n) => !state.draft.nodes.some((o) => o.id === n.id))?.id : undefined;
    applied(result, { buildAt: undefined, selectedNode: placed });
  },
  'close-build': () => update({ buildAt: undefined }),

  'add-node': () => {
    const type = (document.getElementById('new-node') as HTMLSelectElement).value;
    update({ draft: addNode(state.draft, type) });
  },
  'remove-node': (el) => {
    const node = state.draft.nodes.find((n) => n.id === el.dataset.node);
    if (!node || permanent(node)) return;
    update({ draft: removeNode(state.draft, node.id), selectedNode: undefined, tool: { kind: 'select' } });
  },
  'upgrade-step': (el) => {
    const node = state.draft.nodes.find((n) => n.id === el.dataset.node);
    const up = state.catalog.upgrades[el.dataset.upgrade!];
    if (!node || !up) return;
    const level = node.upgrades?.[up.id] ?? 0;
    const next = el.dataset.delta === 'toggle' ? (level > 0 ? 0 : 1) : Math.min(up.maxLevel, Math.max(0, level + Number(el.dataset.delta)));
    if (next !== level) update({ draft: setUpgrade(state.draft, node.id, up.id, next) });
  },
  upgrade: (el) =>
    update({
      draft: setUpgrade(state.draft, el.dataset.node!, el.dataset.upgrade!, Number((el as HTMLSelectElement).value)),
    }),
  'add-link': () => {
    const from = (document.getElementById('link-from') as HTMLSelectElement).value;
    const to = (document.getElementById('link-to') as HTMLSelectElement).value;
    const result = connect(state.draft, from, to);
    // La vue tableau garde son lien même sans chemin possible : le plateau en trace un à défaut.
    update(result.ok ? { draft: result.arch } : { draft: addLink(state.draft, from, to), boardMessage: result.reason });
  },
  'remove-link': (el) => update({ draft: removeLink(state.draft, Number(el.dataset.link)) }),
  revert: () => update({ draft: committedOrStart(), selectedNode: undefined }),

  play: () => {
    forgetHistory();
    const waveIndex = state.game.waveIndex;
    const wave = state.scenario.waves[waveIndex]!;
    const replays = state.game.replays;
    const { state: game, result, score } = playWave(state.game, state.scenario, state.draft, state.catalog, scoring);
    const label = `#${nextAttemptId} V${waveIndex + 1} ${describeDraft(state.draft)}`;
    // Le brouillon est gardé même perdu : on le corrige plutôt que de tout reposer.
    // La facture, elle, compte toujours depuis l'architecture validée.
    const patch = record({ label: `${label}${result.won ? '' : ` (perdue : ${wave.title})`}`, waveIndex, result, score, played: true }, replays);
    update({ game, ...patch });
    void playOnBoard(state.attempts.find((a) => a.id === patch.current)!);
  },
  try: () => {
    const waveIndex = state.game.waveIndex;
    const result = simulateWave(state.draft, state.scenario.waves[waveIndex]!, state.catalog, state.game.committed);
    const label = `#${nextAttemptId} V${waveIndex + 1} essai ${describeDraft(state.draft)}`;
    const patch = record({ label, waveIndex, result, score: scoreWave(result, state.game.replays, scoring), played: false }, state.game.replays);
    update(patch);
    void playOnBoard(state.attempts.find((a) => a.id === patch.current)!);
  },
  select: (el) => update({ selected: Number(el.dataset.attempt) }),
  replay: (el) => {
    const attempt = state.attempts.find((a) => a.id === Number(el.dataset.attempt));
    if (attempt) void playOnBoard(attempt);
  },

  calibrate: (el) => {
    const input = el as HTMLInputElement;
    const value = parseField(input.value, { path: input.dataset.path!, label: '', list: input.dataset.list === '1' });
    if (value === undefined) return;
    calibrated.add(state.scenario.id);
    if (input.dataset.root === 'catalog') update({ catalog: setAt(state.catalog, input.dataset.path!, value) });
    else update({ scenario: setAt(state.scenario, input.dataset.path!, value) });
  },
  'reset-calibration': () => {
    calibrated.delete(state.scenario.id);
    update({ catalog: structuredClone(defaultCatalog), scenario: structuredClone(defaultScenario(state.scenario.id)) });
  },
  export: () => {
    const area = document.getElementById('export') as HTMLTextAreaElement;
    area.hidden = false;
    area.value = JSON.stringify({ catalog: state.catalog, scenario: state.scenario }, null, 2);
    area.select();
  },
  rewind: (el) => {
    forgetHistory();
    leaveWave();
    const game = rewindTo(state.game, Number(el.dataset.wave));
    update({ game, draft: committedOrStart(game), selectedNode: undefined, phase: 'briefing', showMenu: false });
  },
  'reset-game': () => {
    forgetHistory();
    leaveWave();
    update({
      game: newGame(),
      draft: startOf(state.scenario),
      attempts: [],
      selected: undefined,
      selectedNode: undefined,
      phase: 'briefing',
      showMenu: false,
    });
  },
};

function dispatch(event: Event): void {
  const el = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  const action = el && actions[el.dataset.action!];
  if (!el || !action) return;
  // Les champs réagissent au changement, les boutons au clic : pas de double déclenchement.
  const isField = el instanceof HTMLInputElement || el instanceof HTMLSelectElement;
  if ((event.type === 'change') !== isField) return;
  action(el);
}

root.addEventListener('click', dispatch);
root.addEventListener('change', dispatch);
window.addEventListener('keydown', (e) => {
  // Pas de raccourci pendant la saisie d'un champ (calibrage, vue tableau).
  if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
  if (e.key === 'Escape' && state.phase === 'build') update({ tool: { kind: 'select' }, buildAt: undefined, boardMessage: undefined, showMenu: false });
  if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
    e.preventDefault();
    if (e.key === 'y' || e.shiftKey) travel(redo, undo);
    else travel(undo, redo);
  }
  if (e.key === 'd' || e.key === 'D') update({ debug: !state.debug });
});
render();

// Le plateau 3D se charge à part : l'interface est utilisable avant lui.
void (async () => {
  try {
    const { CityScene } = await import('../render/scene.ts');
    scene = await CityScene.create(regions.board, state.catalog, theme, import.meta.env.BASE_URL);
    regions.board.querySelector('.replay-loading')?.remove();
    scene.events = { canUse, onClick: onBoardClick, canDrag, onDragStart, onDrop };
    syncBoard();
  } catch (e) {
    regions.board.querySelector('.replay-loading')!.textContent = `Impossible de charger le plateau : ${String(e)}`;
  }
})();
