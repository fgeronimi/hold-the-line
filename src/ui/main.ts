import { SCENARIOS } from '../data/scenarios/index.ts';
import { fortifiedCity as theme } from '../data/themes/fortified-city.ts';
import type { BoardCell } from '../engine/types.ts';
import type { CityScene } from '../render/scene.ts';
import { attachChart, chartModel } from '../render/charts.ts';
import {
  actions,
  boardClick,
  canDrag,
  canUse,
  cardDragged,
  cardDropped,
  dragStart,
  drop,
  keyPressed,
  permanent,
  type ActionArgs,
  type Effect,
  type Outcome,
} from './actions.ts';
import { autoPlace } from './board.ts';
import { draftInfo } from './draft.ts';
import { emptyHistory, historyCounts, remember, travel, type History } from './history.ts';
import { choices, gameOf, isStore, readStore, withGame } from './session.ts';
import { load, save } from './storage.ts';
import { installSprite } from './icons.ts';
import { renderCard, renderDebug, renderDialog, renderHud, renderToolbar, hintsOf, upgradePips, type Attempt, type ViewState } from './views.ts';
import './style.css';

/*
 * Le câblage : l'état courant, le stockage, le plateau 3D, les écouteurs. Ce que fait chaque
 * geste est dans `actions.ts`, la partie gardée dans `session.ts`, annuler dans `history.ts`.
 */

let store = readStore(load(isStore));

/** Les scénarios dont le joueur a touché le calibrage. */
const calibrated = new Set<string>();

function initialState(): ViewState {
  const id = store.current ?? SCENARIOS[0]!.scenario.id;
  const { calibrated: wasCalibrated, ...picked } = gameOf(store, id);
  if (wasCalibrated) calibrated.add(id);
  return {
    ...picked,
    attempts: [],
    tool: { kind: 'select' },
    history: { undo: 0, redo: 0 },
    // Chaque session s'ouvre sur l'écran de choix du scénario.
    phase: 'choose',
    debug: new URLSearchParams(location.search).has('debug'),
    debugTab: 'attempts',
    debriefTab: 'analysis',
    showMenu: false,
    choices: choices(store),
  };
}

// Les pictogrammes renvoient au sprite (I18) : il doit être dans la page avant le premier rendu.
installSprite();
const root = document.getElementById('app')!;
root.innerHTML = `
  <div id="board" class="board"><p class="replay-loading">${theme.loading}</p></div>
  <div id="hud" class="layer top"></div>
  <div id="hand" class="layer hand-layer"></div>
  <div id="toolbar" class="layer bottom"></div>
  <div id="dialog" class="layer center"></div>
  <div id="debug" class="layer debug-layer"></div>`;
const regions = {
  board: document.getElementById('board')!,
  hud: document.getElementById('hud')!,
  hand: document.getElementById('hand')!,
  toolbar: document.getElementById('toolbar')!,
  dialog: document.getElementById('dialog')!,
  debug: document.getElementById('debug')!,
};

let state = initialState();
let nextAttemptId = 1;
let scene: CityScene | undefined;
let stopWave: (() => void) | undefined;
/** Ce que le plateau affiche déjà : on ne le reconstruit que si le brouillon ou le catalogue change. */
let shown: { draft: ViewState['draft']; catalog: ViewState['catalog'] } | undefined;
let history: History = emptyHistory;
/** Un retour dans l'historique ne s'y inscrit pas lui-même. */
let restoring = false;
/** Ce que le calque de la main affiche déjà : le réécrire rejouerait la distribution et ferait retomber la carte survolée. */
let handHtml = '';
/** Le dernier contact venait d'un doigt : les cartes se soulèvent avant de se jouer. */
let touching = false;

function update(patch: Partial<ViewState>): void {
  // Tout brouillon passe par le plateau : un bâtiment ajouté sans case (vue tableau) en reçoit une.
  if (patch.draft) patch = { ...patch, draft: autoPlace(patch.draft) };
  if (patch.draft && patch.draft !== state.draft && state.phase === 'build' && !restoring) history = remember(history, state.draft);
  state = { ...state, ...patch, history: historyCounts(history) };
  if (state.phase !== 'choose') {
    store = withGame(store, state, calibrated.has(state.scenario.id));
    save(store);
    state.choices = choices(store);
  }
  render();
}

function render(): void {
  regions.hud.innerHTML = renderHud(state);
  renderHandLayer();
  regions.toolbar.innerHTML = renderToolbar(state);
  regions.dialog.innerHTML = renderDialog(state);
  regions.debug.innerHTML = renderDebug(state);
  document.body.classList.toggle('debug-open', state.debug);
  attachDebriefChart();
  syncBoard();
}

/** La main et la carte du bâtiment : réécrites seulement si elles changent, distribuées seulement à l'ouverture. */
function renderHandLayer(): void {
  const html = renderCard(state);
  if (html === handHtml) return;
  regions.hand.classList.toggle('settled', handHtml !== '' && html !== '');
  regions.hand.innerHTML = html;
  handHtml = html;
}

/** Le survol des courbes du debrief : le HTML est réécrit à chaque rendu, on le rebranche. */
function attachDebriefChart(): void {
  const root = regions.dialog.querySelector<HTMLElement>('[data-chart="root"]');
  const a = state.attempts.find((x) => x.id === state.current);
  const wave = a && state.scenario.waves[a.waveIndex];
  if (root && a && wave) attachChart(root, chartModel(a.result, a.arch, wave, state.catalog, theme, draftInfo(a.arch, state.catalog).order));
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
  const can = selected && { move: state.catalog.components[selected.type]?.behavior !== 'source', remove: !permanent(state, selected) };
  scene.setPips(selected?.id, selected && can ? upgradePips(selected, state.catalog, can, blink) : '');
}

/** Revient au brouillon d'avant (ou d'après) : la dernière action de construction. */
function travelTo(direction: 'undo' | 'redo'): void {
  const step = travel(history, direction, state.draft, state.phase === 'build');
  history = step.history;
  if (!step.draft) return;
  restoring = true;
  update({ draft: step.draft, selectedNode: undefined, tool: { kind: 'select' }, boardMessage: undefined });
  restoring = false;
}

/** Joue une tentative en direct sur le plateau, puis ouvre son debrief. */
async function playOnBoard(attempt: Attempt): Promise<void> {
  if (!scene) return update({ phase: 'debrief', current: attempt.id });
  const { startReplay } = await import('../render/replay.ts');
  stopWave?.();
  const wave = state.scenario.waves[attempt.waveIndex]!;
  update({ phase: 'wave', debriefTab: 'analysis', current: attempt.id, selectedNode: undefined, buildAt: undefined, showHand: false, liftedCard: undefined, tool: { kind: 'select' }, showMenu: false });
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

/** Exécute ce que demande une action : ses effets d'abord, puis son patch, puis le rejeu ou l'export. */
function run(outcome: Outcome | undefined): void {
  if (!outcome) return;
  const after: Effect[] = [];
  for (const effect of outcome.effects ?? []) {
    switch (effect.kind) {
      case 'leave-wave':
        leaveWave();
        break;
      case 'forget-history':
        history = emptyHistory;
        break;
      case 'travel':
        travelTo(effect.direction);
        break;
      case 'calibrated':
        if (effect.on) calibrated.add(effect.id);
        else calibrated.delete(effect.id);
        break;
      case 'attempt-recorded':
        nextAttemptId++;
        break;
      case 'play':
      case 'export':
        after.push(effect);
        break;
    }
  }
  if (outcome.patch) update(outcome.patch);
  for (const effect of after) {
    if (effect.kind === 'play') {
      const attempt = state.attempts.find((a) => a.id === effect.attempt);
      if (attempt) void playOnBoard(attempt);
    } else if (effect.kind === 'export') {
      const area = document.getElementById('export') as HTMLTextAreaElement;
      area.hidden = false;
      area.value = effect.text;
      area.select();
    }
  }
}

/** Une carte glissée hors de la main jusqu'au plateau y est posée, comme avec l'outil qui pose. */
let cardDrag: { type: string; x: number; y: number; moved: boolean } | undefined;
root.addEventListener('pointerdown', (e) => {
  touching = e.pointerType === 'touch';
  const card = (e.target as Element).closest<HTMLElement>('.hcard[data-type]');
  // Au doigt, glisser fait défiler la main : la carte se joue en deux contacts.
  if (!card || touching || state.phase !== 'build') return;
  cardDrag = { type: card.dataset.type!, x: e.clientX, y: e.clientY, moved: false };
});
window.addEventListener('pointermove', (e) => {
  if (!cardDrag || cardDrag.moved || Math.hypot(e.clientX - cardDrag.x, e.clientY - cardDrag.y) < 6) return;
  cardDrag.moved = true;
  run(cardDragged(cardDrag.type));
});
window.addEventListener('pointerup', (e) => {
  const drag = cardDrag;
  cardDrag = undefined;
  if (!drag?.moved || !scene || !(e.target instanceof HTMLCanvasElement)) return;
  const cell = scene.cellAt(e.clientX, e.clientY);
  if (cell) run(cardDropped(state, drag.type, cell));
});

/** Ce que désigne l'élément : la vue tableau a trois champs, lus seulement pour ses deux boutons. */
function argsOf(el: HTMLElement, action: string): ActionArgs {
  const value = (id: string) => (document.getElementById(id) as HTMLSelectElement).value;
  const args: ActionArgs = { data: { ...el.dataset }, touch: touching };
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) args.value = el.value;
  if (action === 'add-node') args.newNode = value('new-node');
  if (action === 'add-link') {
    args.linkFrom = value('link-from');
    args.linkTo = value('link-to');
  }
  return args;
}

function dispatch(event: Event): void {
  const el = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  const name = el?.dataset.action;
  const action = name ? actions[name] : undefined;
  if (!el || !name || !action) return;
  // Les champs réagissent au changement, les boutons au clic : pas de double déclenchement.
  const isField = el instanceof HTMLInputElement || el instanceof HTMLSelectElement;
  if ((event.type === 'change') !== isField) return;
  run(action(state, argsOf(el, name), { store, nextAttemptId }));
}

root.addEventListener('click', dispatch);
root.addEventListener('change', dispatch);
window.addEventListener('keydown', (e) => {
  // Pas de raccourci pendant la saisie d'un champ (calibrage, vue tableau).
  if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
  const key = keyPressed(state, e.key, { meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey });
  if (key.preventDefault) e.preventDefault();
  run(key.outcome);
});
render();

// Le plateau 3D se charge à part : l'interface est utilisable avant lui.
void (async () => {
  try {
    const { CityScene } = await import('../render/scene.ts');
    scene = await CityScene.create(regions.board, state.catalog, theme, import.meta.env.BASE_URL);
    regions.board.querySelector('.replay-loading')?.remove();
    scene.events = {
      canUse: (cell: BoardCell) => canUse(state, cell),
      onClick: (cell: BoardCell) => run(boardClick(state, cell)),
      canDrag: (cell: BoardCell) => canDrag(state, cell),
      onDragStart: (cell: BoardCell) => run(dragStart(state, cell)),
      onDrop: (cell: BoardCell | undefined) => run(drop(state, cell)),
    };
    syncBoard();
    update({ thumbnails: scene.thumbnails(Object.keys(theme.buildings)) });
  } catch (e) {
    regions.board.querySelector('.replay-loading')!.textContent = `Impossible de charger le plateau : ${String(e)}`;
  }
})();
