import { catalog as defaultCatalog } from '../data/catalog.ts';
import { urlShortener } from '../data/scenarios/url-shortener.ts';
import { scoring } from '../data/scoring.ts';
import { newGame, playWave, rewindTo } from '../engine/game.ts';
import { scoreWave } from '../engine/score.ts';
import { simulateWave } from '../engine/simulate.ts';
import type { Architecture } from '../engine/types.ts';
import { changedSettings, parseField, setAt } from './calibration.ts';
import { addLink, addNode, removeLink, removeNode, setUpgrade } from './editor.ts';
import { load, save } from './storage.ts';
import { renderApp, type Attempt, type ViewState } from './views.ts';
import './style.css';

const START: Architecture = { nodes: [{ id: 'src', type: 'traffic-source' }], links: [] };

type Saved = Pick<ViewState, 'catalog' | 'scenario' | 'game' | 'draft'>;

function initialState(): ViewState {
  const saved = load<Saved>();
  return {
    catalog: saved?.catalog ?? structuredClone(defaultCatalog),
    scenario: saved?.scenario ?? structuredClone(urlShortener),
    game: saved?.game ?? newGame(),
    draft: saved?.draft ?? START,
    attempts: [],
    tab: 'build',
  };
}

let state = initialState();
let nextAttemptId = 1;
const root = document.getElementById('app')!;

function update(patch: Partial<ViewState>): void {
  state = { ...state, ...patch };
  save({ catalog: state.catalog, scenario: state.scenario, game: state.game, draft: state.draft } satisfies Saved);
  root.innerHTML = renderApp(state);
}

/** Les tentatives ne sont pas sauvegardées : un résultat ne vaut que pour la calibration du moment. */
function record(attempt: Omit<Attempt, 'id' | 'settings'>): Partial<ViewState> {
  const id = nextAttemptId++;
  const settings = changedSettings({ catalog: defaultCatalog, scenario: urlShortener }, state, attempt.waveIndex);
  return { attempts: [...state.attempts, { ...attempt, id, settings }], selected: id };
}

function describeDraft(arch: Architecture): string {
  const types = arch.nodes.filter((n) => n.type !== 'traffic-source').map((n) => n.type);
  return types.length > 0 ? types.join(' + ') : 'vide';
}

const actions: Record<string, (el: HTMLElement) => void> = {
  tab: (el) => update({ tab: el.dataset.tab as ViewState['tab'] }),

  'add-node': () => {
    const type = (document.getElementById('new-node') as HTMLSelectElement).value;
    update({ draft: addNode(state.draft, type) });
  },
  'remove-node': (el) => update({ draft: removeNode(state.draft, el.dataset.node!) }),
  upgrade: (el) =>
    update({
      draft: setUpgrade(state.draft, el.dataset.node!, el.dataset.upgrade!, Number((el as HTMLSelectElement).value)),
    }),
  'add-link': () => {
    const from = (document.getElementById('link-from') as HTMLSelectElement).value;
    const to = (document.getElementById('link-to') as HTMLSelectElement).value;
    update({ draft: addLink(state.draft, from, to) });
  },
  'remove-link': (el) => update({ draft: removeLink(state.draft, Number(el.dataset.link)) }),
  revert: () => update({ draft: state.game.committed.nodes.length > 0 ? state.game.committed : START }),

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
    update({ game, draft: game.committed.nodes.length > 0 ? game.committed : START });
  },
  'reset-game': () => update({ game: newGame(), draft: START, attempts: [], selected: undefined }),
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
root.innerHTML = renderApp(state);
