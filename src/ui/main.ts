import { catalog as defaultCatalog } from '../data/catalog.ts';
import { urlShortener } from '../data/scenarios/url-shortener.ts';
import { scoring } from '../data/scoring.ts';
import { fortifiedCity as theme } from '../data/themes/fortified-city.ts';
import { newGame, playWave, rewindTo } from '../engine/game.ts';
import { scoreWave } from '../engine/score.ts';
import { simulateWave } from '../engine/simulate.ts';
import type { Architecture, BoardCell } from '../engine/types.ts';
import type { CityScene } from '../render/scene.ts';
import { autoPlace, connect, insideBoard, moveNode, nodeAt, placeNode, type BoardResult } from './board.ts';
import { changedSettings, parseField, setAt } from './calibration.ts';
import { addLink, addNode, removeLink, removeNode, setUpgrade } from './editor.ts';
import { load, save } from './storage.ts';
import { renderBottom, renderSide, renderTop, type Attempt, type Tool, type ViewState } from './views.ts';
import './style.css';

const START: Architecture = { nodes: [{ id: 'src', type: 'traffic-source', cell: { q: 0, r: 0 } }], links: [] };

type Saved = Pick<ViewState, 'catalog' | 'scenario' | 'game' | 'draft'>;

function initialState(): ViewState {
  const saved = load<Saved>();
  return {
    catalog: saved?.catalog ?? structuredClone(defaultCatalog),
    scenario: saved?.scenario ?? structuredClone(urlShortener),
    game: saved?.game ?? newGame(),
    // Un brouillon d'avant le plateau reçoit des cases et des chemins une fois pour toutes.
    draft: autoPlace(saved?.draft ?? START),
    attempts: [],
    tab: 'build',
    tool: { kind: 'select' },
    showTable: false,
  };
}

const root = document.getElementById('app')!;
root.innerHTML = `
  <div id="top"></div>
  <div class="workspace">
    <div id="board" class="board"><p class="replay-loading">Chargement du plateau…</p></div>
    <aside id="side" class="side"></aside>
  </div>
  <div id="bottom"></div>`;
const regions = {
  top: document.getElementById('top')!,
  side: document.getElementById('side')!,
  bottom: document.getElementById('bottom')!,
  board: document.getElementById('board')!,
};

let state = initialState();
let nextAttemptId = 1;
let scene: CityScene | undefined;
let stopReplay: (() => void) | undefined;
/** Ce que le plateau affiche déjà : on ne le reconstruit que si le brouillon ou le catalogue change. */
let shown: { draft: Architecture; catalog: ViewState['catalog'] } | undefined;

function update(patch: Partial<ViewState>): void {
  // Tout brouillon passe par le plateau : un bâtiment ajouté sans case (vue tableau) en reçoit une.
  if (patch.draft) patch = { ...patch, draft: autoPlace(patch.draft) };
  state = { ...state, ...patch };
  save({ catalog: state.catalog, scenario: state.scenario, game: state.game, draft: state.draft } satisfies Saved);
  render();
}

function render(): void {
  regions.top.innerHTML = renderTop(state);
  regions.side.innerHTML = renderSide(state);
  regions.bottom.innerHTML = renderBottom(state);
  syncBoard();
}

/** Aligne le plateau 3D sur l'état : architecture, bâtiment marqué, fantôme de l'outil. */
function syncBoard(): void {
  if (!scene || state.replaying !== undefined) return;
  if (!shown || shown.draft !== state.draft || shown.catalog !== state.catalog) {
    scene.setArchitecture(state.draft, state.catalog);
    shown = { draft: state.draft, catalog: state.catalog };
  }
  const { tool } = state;
  scene.setGhost(tool.kind === 'place' ? tool.type : tool.kind === 'move' ? state.draft.nodes.find((n) => n.id === tool.id)?.type : undefined);
  if (tool.kind === 'link' && tool.from) scene.setMarked(tool.from, '#3a86ff');
  else if (tool.kind === 'move') scene.setMarked(tool.id, '#9b5de5');
  else scene.setMarked(state.selectedNode);
}

/** Où l'outil courant peut agir : le curseur hexagonal rougit ailleurs. */
function canUse(cell: BoardCell): boolean {
  const here = nodeAt(state.draft, cell);
  switch (state.tool.kind) {
    case 'place':
    case 'move':
      return insideBoard(cell) && (!here || (state.tool.kind === 'move' && here.id === state.tool.id));
    case 'link':
      return here !== undefined;
    case 'remove':
      return here !== undefined && state.catalog.components[here.type]?.behavior !== 'source';
    case 'select':
      return true;
  }
}

function applied(result: BoardResult, extra: Partial<ViewState> = {}): void {
  if (result.ok) update({ draft: result.arch, boardMessage: undefined, ...extra });
  else update({ boardMessage: result.reason });
}

function onBoardClick(cell: BoardCell): void {
  const here = nodeAt(state.draft, cell);
  const tool = state.tool;
  switch (tool.kind) {
    case 'select':
      update({ selectedNode: here?.id, boardMessage: undefined });
      return;
    case 'place':
      return applied(placeNode(state.draft, tool.type, cell));
    case 'move':
      return applied(moveNode(state.draft, tool.id, cell), { tool: { kind: 'select' }, selectedNode: tool.id });
    case 'link':
      if (!here) return update({ boardMessage: 'Cliquer un bâtiment.' });
      if (!tool.from) return update({ tool: { kind: 'link', from: here.id }, boardMessage: undefined });
      return applied(connect(state.draft, tool.from, here.id), { tool: { kind: 'link' } });
    case 'remove':
      if (!here || state.catalog.components[here.type]?.behavior === 'source') return;
      update({ draft: removeNode(state.draft, here.id), selectedNode: undefined, boardMessage: undefined });
      return;
  }
}

/** Les tentatives ne sont pas sauvegardées : un résultat ne vaut que pour la calibration du moment. */
function record(attempt: Omit<Attempt, 'id' | 'settings' | 'arch'>): Partial<ViewState> {
  const id = nextAttemptId++;
  const settings = changedSettings({ catalog: defaultCatalog, scenario: urlShortener }, state, attempt.waveIndex);
  return { attempts: [...state.attempts, { ...attempt, id, settings, arch: state.draft }], selected: id };
}

/** Rejoue une tentative sur le plateau même, puis rend la main à la construction. */
async function replay(attempt: Attempt): Promise<void> {
  if (!scene) return;
  const { startReplay } = await import('../render/replay.ts');
  stopReplay?.();
  const wave = state.scenario.waves[attempt.waveIndex];
  update({ replaying: attempt.id });
  regions.board.scrollIntoView({ behavior: 'smooth', block: 'center' });
  stopReplay = startReplay(scene, regions.board, {
    title: `${theme.title} — vague ${attempt.waveIndex + 1}${wave ? ` : ${wave.title}` : ''}`,
    arch: attempt.arch,
    result: attempt.result,
    wave: wave!,
    catalog: state.catalog,
    theme,
    onClose: () => {
      stopReplay = undefined;
      shown = undefined;
      update({ replaying: undefined });
    },
  });
}

function describeDraft(arch: Architecture): string {
  const types = arch.nodes.filter((n) => n.type !== 'traffic-source').map((n) => n.type);
  return types.length > 0 ? types.join(' + ') : 'vide';
}

const committedOrStart = () => (state.game.committed.nodes.length > 0 ? state.game.committed : START);

const actions: Record<string, (el: HTMLElement) => void> = {
  tab: (el) => update({ tab: el.dataset.tab as ViewState['tab'] }),
  'toggle-table': () => update({ showTable: !state.showTable }),

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
    update({ tool, boardMessage: undefined });
  },

  'add-node': () => {
    const type = (document.getElementById('new-node') as HTMLSelectElement).value;
    update({ draft: addNode(state.draft, type) });
  },
  'remove-node': (el) =>
    update({ draft: removeNode(state.draft, el.dataset.node!), selectedNode: undefined, tool: { kind: 'select' } }),
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
    const waveIndex = state.game.waveIndex;
    const wave = state.scenario.waves[waveIndex]!;
    const { state: game, result, score } = playWave(state.game, state.scenario, state.draft, state.catalog, scoring);
    const label = `#${nextAttemptId} V${waveIndex + 1} ${describeDraft(state.draft)}`;
    // Le brouillon est gardé même perdu : on le corrige plutôt que de tout reposer.
    // La facture, elle, compte toujours depuis l'architecture validée.
    update({
      game,
      ...record({ label: `${label}${result.won ? '' : ` (perdue : ${wave.title})`}`, waveIndex, result, score, played: true }),
    });
  },
  try: () => {
    const waveIndex = state.game.waveIndex;
    const result = simulateWave(state.draft, state.scenario.waves[waveIndex]!, state.catalog, state.game.committed);
    const label = `#${nextAttemptId} V${waveIndex + 1} essai ${describeDraft(state.draft)}`;
    update(record({ label, waveIndex, result, score: scoreWave(result, state.game.replays, scoring), played: false }));
  },
  select: (el) => update({ selected: Number(el.dataset.attempt) }),
  replay: (el) => {
    const attempt = state.attempts.find((a) => a.id === Number(el.dataset.attempt));
    if (attempt) void replay(attempt);
  },

  calibrate: (el) => {
    const input = el as HTMLInputElement;
    const value = parseField(input.value, { path: input.dataset.path!, label: '', list: input.dataset.list === '1' });
    if (value === undefined) return;
    if (input.dataset.root === 'catalog') update({ catalog: setAt(state.catalog, input.dataset.path!, value) });
    else update({ scenario: setAt(state.scenario, input.dataset.path!, value) });
  },
  'reset-calibration': () => update({ catalog: structuredClone(defaultCatalog), scenario: structuredClone(urlShortener) }),
  export: () => {
    const area = document.getElementById('export') as HTMLTextAreaElement;
    area.hidden = false;
    area.value = JSON.stringify({ catalog: state.catalog, scenario: state.scenario }, null, 2);
    area.select();
  },
  rewind: (el) => {
    const game = rewindTo(state.game, Number(el.dataset.wave));
    update({ game, draft: game.committed.nodes.length > 0 ? game.committed : START, selectedNode: undefined });
  },
  'reset-game': () => update({ game: newGame(), draft: START, attempts: [], selected: undefined, selectedNode: undefined }),
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
  if (e.key === 'Escape' && state.replaying === undefined) update({ tool: { kind: 'select' }, boardMessage: undefined });
});
render();

// Le plateau 3D se charge à part : l'interface est utilisable avant lui.
void (async () => {
  try {
    const { CityScene } = await import('../render/scene.ts');
    scene = await CityScene.create(regions.board, state.catalog, theme, import.meta.env.BASE_URL);
    regions.board.querySelector('.replay-loading')?.remove();
    scene.events = { canUse, onClick: onBoardClick };
    syncBoard();
  } catch (e) {
    regions.board.querySelector('.replay-loading')!.textContent = `Impossible de charger le plateau : ${String(e)}`;
  }
})();
