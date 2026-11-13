import { catalog as defaultCatalog } from '../data/catalog.ts';
import { SCENARIOS, scenarioById } from '../data/scenarios/index.ts';
import { newGame, type GameState } from '../engine/game.ts';
import { NO_STARS, starCount, type Stars } from '../engine/score.ts';
import type { Architecture, Catalog, Scenario } from '../engine/types.ts';
import { autoPlace } from './board.ts';
import type { ViewState } from './views.ts';

/**
 * La partie vue du stockage : charger le magasin, choisir la partie d'un scénario, fabriquer
 * ce qui est gardé. Pur : `main.ts` lit et écrit le stockage (`storage.ts`) autour.
 */

export type Saved = Pick<ViewState, 'game' | 'draft'> & {
  /**
   * Seulement si le joueur a calibré en debug : sinon catalogue et scénario viennent du
   * code, pour qu'une partie en cours profite des données mises à jour (rampe, chiffres…).
   */
  calibration?: Pick<ViewState, 'catalog' | 'scenario'>;
};

/** Les succès débloqués (I20), par identifiant : où ils l'ont été. */
export type Unlocked = Record<string, { scenario: string; wave: number }>;

/**
 * Une partie par scénario (décision S2), et le dernier scénario joué. Les succès valent pour
 * toutes les parties : ils survivent à « Nouvelle partie ». Champ optionnel, la clé ne change pas.
 */
export interface Store {
  current?: string;
  saves: Record<string, Saved>;
  achievements?: Unlocked;
}

export type Picked = Pick<ViewState, 'catalog' | 'scenario' | 'game' | 'draft'>;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** La forme minimale d'un magasin : un objet avec ses parties. Le détail est vérifié par `readStore`. */
export function isStore(x: unknown): x is Store {
  return isObject(x) && isObject(x.saves) && (x.current === undefined || typeof x.current === 'string');
}

/** Une partie gardée qu'on peut reprendre sans planter : une partie, un brouillon, un calibrage complet s'il y en a un. */
function isSaved(x: unknown): x is Saved {
  if (!isObject(x) || !isObject(x.game) || typeof x.game.waveIndex !== 'number') return false;
  if (!isObject(x.draft) || !Array.isArray(x.draft.nodes) || !Array.isArray(x.draft.links)) return false;
  const c = x.calibration;
  return c === undefined || (isObject(c) && isObject(c.catalog) && isObject(c.scenario) && Array.isArray(c.scenario.waves));
}

/**
 * Le magasin à partir de ce que le stockage a rendu : vide s'il n'a pas la bonne forme, et
 * sans les parties abîmées (on les rejoue de zéro plutôt que de tout perdre).
 */
export function readStore(value: unknown): Store {
  if (!isStore(value)) return { saves: {} };
  const saves = Object.fromEntries(
    Object.entries(value.saves)
      .filter(([, s]) => isSaved(s))
      .map(([id, s]) => [id, { ...s, game: withStarObjects(s.game) }]),
  );
  const { achievements: raw, ...rest } = value;
  if (!isObject(raw)) return { ...rest, saves };
  const achievements = Object.fromEntries(Object.entries(raw).filter(([, a]) => isObject(a) && typeof a.scenario === 'string' && typeof a.wave === 'number'));
  return { ...rest, saves, achievements: achievements as Unlocked };
}

/**
 * Une partie d'avant les étoiles détaillées (E7, E9) gardait un score et un nombre d'étoiles
 * par vague. Le nombre se convertit au plus juste : une étoile, la vague était tenue ; trois,
 * elle était aussi économe. « Rien de superflu » n'existait pas : elle reste à gagner, en
 * rejouant la vague. Le score est oublié.
 */
export function withStarObjects(game: GameState): GameState {
  const { scores: _, ...rest } = game as GameState & { scores?: unknown };
  const stars = (game.stars as unknown[]).map((x): Stars =>
    typeof x === 'number' ? { held: x >= 1, lean: false, thrifty: x >= 3 } : { ...NO_STARS, ...(x as Partial<Stars>) },
  );
  return { ...rest, stars };
}

export const defaultScenario = (id: string): Scenario => scenarioById(id) ?? SCENARIOS[0]!.scenario;

/** Le plateau de départ d'un scénario : la source, et les services déjà en place. */
export function startOf(scenario: Scenario): Architecture {
  return { nodes: [{ id: 'src', type: 'traffic-source', cell: { q: 0, r: 0 } }, ...structuredClone(scenario.fixtures ?? [])], links: [] };
}

/** Une partie commencée avant l'arrivée des services déjà en place les reçoit. */
export function withFixtures(draft: Architecture, scenario: Scenario): Architecture {
  const missing = (scenario.fixtures ?? []).filter((f) => !draft.nodes.some((n) => n.id === f.id));
  return missing.length > 0 ? { ...draft, nodes: [...draft.nodes, ...structuredClone(missing)] } : draft;
}

/**
 * Depuis le bâtiment Worker (ticket n° 1), une file ou un pub/sub ne peut plus alimenter un
 * serveur d'application. Un serveur dont tout le trafic vient d'une file ou d'un pub/sub
 * devient donc un worker, avec ses instances en workers supplémentaires ; ses évolutions de
 * serveur de façade (autoscaling, disjoncteur), sans objet derrière une file, tombent. Même id,
 * pour que brouillon, architecture validée et historique restent le même bâtiment.
 */
export function withWorkers(arch: Architecture, catalog: Catalog): Architecture {
  if (!catalog.components.worker) return arch;
  const typeOf = new Map(arch.nodes.map((n) => [n.id, n.type]));
  const consumes = (id: string) => {
    const from = arch.links.filter((l) => l.to === id).map((l) => catalog.components[typeOf.get(l.from) ?? '']?.behavior);
    return from.length > 0 && from.every((b) => b === 'queue' || b === 'pubsub');
  };
  const converted = arch.nodes.filter((n) => n.type === 'app-server' && consumes(n.id));
  if (converted.length === 0) return arch;
  const ids = new Set(converted.map((n) => n.id));
  return {
    ...arch,
    nodes: arch.nodes.map((n) => {
      if (!ids.has(n.id)) return n;
      const instances = n.upgrades?.['horizontal-scaling'] ?? 0;
      const { upgrades: _, ...rest } = n;
      return { ...rest, type: 'worker', ...(instances > 0 ? { upgrades: { 'worker-scaling': instances } } : {}) };
    }),
  };
}

/**
 * Les vagues ajoutées au milieu d'un scénario déjà publié, par leur index : la passerelle d'API
 * du raccourcisseur et la file des lettres mortes du marché sont arrivées en vague 5.
 */
const INSERTED_WAVES: Record<string, number> = { 'url-shortener': 4, market: 4 };

/**
 * Une partie terminée avant l'ajout d'une vague garde des étoiles par vague de l'époque : sans
 * correction, elles glissent d'un cran et la dernière vague s'affiche sans étoile. La vague
 * ajoutée y entre sans étoile, avec l'architecture de la vague d'avant. Une partie en cours
 * n'est pas touchée : rien ne dit si elle date d'avant ou d'après l'ajout.
 */
export function withInsertedWaves(game: GameState, scenario: Scenario): GameState {
  const at = INSERTED_WAVES[scenario.id];
  if (at === undefined || !game.finished || game.stars.length !== scenario.waves.length - 1 || game.stars.length < at) return game;
  const insert = <T>(xs: readonly T[], x: T) => [...xs.slice(0, at), x, ...xs.slice(at)];
  const before = game.history[at] ?? game.committed;
  return { ...game, stars: insert(game.stars, NO_STARS), history: insert(game.history, before), waveIndex: scenario.waves.length };
}

/** La partie convertie au catalogue courant : brouillon, architecture validée et historique ensemble. */
function upgradedGame(game: GameState, catalog: Catalog, scenario: Scenario): GameState {
  const g = withInsertedWaves(game, scenario);
  return { ...g, committed: withWorkers(g.committed, catalog), history: g.history.map((a) => withWorkers(a, catalog)) };
}

/** La partie d'un scénario : celle sauvegardée, ou une nouvelle ; `calibrated` si le joueur l'avait calibrée. */
export function gameOf(store: Store, id: string): Picked & { calibrated: boolean } {
  const saved = store.saves[id];
  const scenario = saved?.calibration?.scenario ?? structuredClone(defaultScenario(id));
  const catalog = saved?.calibration?.catalog ?? structuredClone(defaultCatalog);
  return {
    catalog,
    scenario,
    game: saved?.game ? upgradedGame(saved.game, catalog, scenario) : newGame(),
    // Un brouillon d'avant le plateau reçoit des cases et des chemins une fois pour toutes.
    draft: autoPlace(withWorkers(withFixtures(saved?.draft ?? startOf(scenario), scenario), catalog)),
    calibrated: !!saved?.calibration,
  };
}

/** Ce que l'écran de choix montre de chaque scénario : sa progression et ses étoiles. */
export function choices(store: Store): ViewState['choices'] {
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
      stars: game?.stars.reduce((a, x) => a + starCount(x), 0) ?? 0,
      finished: game?.finished ?? false,
    };
  });
}

/** Le magasin avec la partie en cours ; catalogue et scénario n'y entrent que s'ils ont été calibrés. */
export function withGame(store: Store, state: Picked & Pick<Partial<ViewState>, 'practice' | 'achievements'>, calibrated: boolean): Store {
  const id = state.scenario.id;
  const calibration = calibrated ? { catalog: state.catalog, scenario: state.scenario } : undefined;
  // Pendant un rejeu (E10), la partie affichée est celle de travail : on garde la vraie.
  const { game, draft } = state.practice ?? state;
  return {
    ...store,
    current: id,
    saves: { ...store.saves, [id]: { game, draft, ...(calibration && { calibration }) } },
    ...(state.achievements && { achievements: state.achievements }),
  };
}

/** Catalogue et scénario du code, auxquels se comparent les réglages calibrés. */
export const defaultsOf = (id: string) => ({ catalog: defaultCatalog, scenario: defaultScenario(id) });
