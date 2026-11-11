import { describe, expect, it } from 'vitest';
import { answersOf } from '../src/data/balance-space.ts';
import { catalog } from '../src/data/catalog.ts';
import { SCENARIOS } from '../src/data/scenarios/index.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { fortifiedCity as theme } from '../src/data/themes/fortified-city.ts';
import { newGame, type GameState } from '../src/engine/game.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import type { Architecture, Scenario } from '../src/engine/types.ts';
import { addLink, addNode, removeLink, removeNode, setUpgrade } from '../src/ui/editor.ts';
import { askHint, compare, hintPanel, hintText, planHints, type Hint } from '../src/ui/hints.ts';

const EMPTY: Architecture = { nodes: [], links: [] };
const startOf = (s: Scenario): Architecture => ({ nodes: [{ id: 'src', type: 'traffic-source' }, ...structuredClone(s.fixtures ?? [])], links: [] });

/** Une partie arrivée à la vague `waveIndex`, avec `committed` comme architecture validée. */
function gameAt(scenario: Scenario, waveIndex: number, committed: Architecture, replays = 1): GameState {
  // L'historique suit la première réponse de chaque vague, puis l'architecture validée.
  const history = [EMPTY, ...Array.from({ length: waveIndex - 1 }, (_, i) => answersOf(scenario.id, i)[0]!)];
  if (waveIndex > 0) history.push(committed);
  return { ...newGame(), waveIndex, committed, history: history.slice(0, waveIndex + 1), replays };
}

/** Applique un indice au brouillon avec les opérations pures de l'éditeur. */
function apply(draft: Architecture, h: Hint): Architecture {
  switch (h.kind) {
    case 'place':
      return addNode(draft, h.type!);
    case 'link':
      expect(h.target?.from && h.target.to, h.key).toBeTruthy();
      return addLink(draft, h.target!.from!, h.target!.to!);
    case 'upgrade':
    case 'lower':
      expect(h.target?.node, h.key).toBeTruthy();
      return setUpgrade(draft, h.target!.node!, h.upgrade!, h.level!);
    case 'remove':
      return removeNode(draft, h.target!.node!);
    case 'unlink':
      return removeLink(draft, draft.links.findIndex((l) => l.from === h.target!.from && l.to === h.target!.to));
    default:
      throw new Error(`Indice inapplicable : ${h.key}`);
  }
}

/** Suit les indices un par un ; rend la fin du parcours. */
function follow(scenario: Scenario, waveIndex: number, committed: Architecture, start: Architecture) {
  const game = gameAt(scenario, waveIndex, committed);
  let draft = start;
  const keys: string[] = [];
  for (let step = 0; step < 60; step++) {
    const plan = planHints({ game, scenario, catalog, draft });
    if (plan.status !== 'guide') return { status: plan.status, draft, keys, plan };
    const h = plan.hints[0]!;
    keys.push(h.key);
    draft = apply(draft, h);
  }
  throw new Error(`Pas de fin après 60 indices : ${keys.join(', ')}`);
}

/**
 * Défauts des données trouvés par ce test, en `it.fails` comme les écarts de
 * `conservation.test.ts` : le test dit ce qui devrait être, il passera quand la donnée sera
 * corrigée. Vide : la finale du tournoi, qui n'avait aucune réponse atteignable depuis la
 * vague 3, a été recalibrée (décision B7).
 */
const DATA_DEFECTS = new Set<string>();

describe('suivre les indices mène à la victoire', () => {
  for (const { scenario } of SCENARIOS) {
    scenario.waves.forEach((wave, i) => {
      const starts =
        i === 0
          ? [{ label: 'plateau de départ', committed: EMPTY, draft: startOf(scenario) }]
          : answersOf(scenario.id, i - 1).map((a, k) => ({ label: `réponse ${k + 1} de la vague ${i}`, committed: a, draft: a }));
      // Depuis un brouillon vide aussi, sans rien à démolir.
      if (i > 0) starts.push({ label: 'brouillon vide', committed: EMPTY, draft: startOf(scenario) });
      for (const s of starts) {
        const test = DATA_DEFECTS.has(`${scenario.id} ${i + 1} ${s.label}`) ? it.fails : it;
        test(`${scenario.id}, vague ${i + 1} (${wave.id}), depuis ${s.label}`, () => {
          // La vérité : une réponse jouée avec les mêmes identifiants que le départ, dont la
          // migration est donc exacte, tient-elle la vague ?
          // Cette vérité majore la migration : l'aide peut faire mieux en réutilisant un
          // bâtiment déjà validé à une autre place (la file de l'e-mail devient celle du
          // pub/sub), jamais moins bien.
          const truth = answersOf(scenario.id, i).some((a) => simulateWave(a, wave, catalog, s.committed).won);
          const end = follow(scenario, i, s.committed, s.draft);
          if (end.status === 'rewind') {
            expect(truth).toBe(false);
          } else {
            expect(end.status, end.keys.join(', ')).toBe('ready');
            expect(simulateWave(end.draft, wave, catalog, s.committed).won).toBe(true);
          }
        });
      }
    });
  }
});

describe('aide du raccourcisseur', () => {
  const cdnPath = [A.minimal, A.withCache, A.withCdn(), A.withCdn({ rateLimitTier: A.TIER_40 })];
  const pathGame = (upTo: number): GameState => ({
    ...newGame(),
    waveIndex: upTo,
    committed: cdnPath[upTo - 1]!,
    history: [EMPTY, ...cdnPath.slice(0, upTo)],
    replays: 1,
  });

  it('CDN validé en vague 3 : en vague 5, l’indice est de revenir à la vague 3', () => {
    const game = pathGame(4);
    const plan = planHints({ game, scenario: urlShortener, catalog, draft: game.committed });
    expect(plan.status).toBe('rewind');
    expect(plan.hints[0]).toMatchObject({ kind: 'rewind', wave: 2 });
    expect(hintText(plan.hints[0]!, catalog, theme, game.committed).real).toContain('Revenir à la vague 3');
  });

  it('un joueur qui a posé un CDN en vague 3 est guidé vers une réponse CDN', () => {
    const game = pathGame(2);
    const draft = addNode(A.withCache, 'cdn');
    const plan = planHints({ game, scenario: urlShortener, catalog, draft });
    expect(plan.status).toBe('guide');
    expect(plan.hints.some((h) => h.kind === 'remove')).toBe(false);
    expect(plan.hints.some((h) => h.type === 'load-balancer')).toBe(false);
    expect(plan.hints[0]).toMatchObject({ kind: 'link' });
    expect(plan.hints[0]!.key).toContain('cdn');
  });

  it('un brouillon déjà gagnant ne reçoit aucun indice de pose', () => {
    const game = pathGame(2);
    const plan = planHints({ game, scenario: urlShortener, catalog, draft: A.withCdn() });
    expect(plan).toEqual({ status: 'ready', hints: [] });
    const panel = hintPanel({ game, scenario: urlShortener, catalog, draft: A.withCdn() }, theme);
    expect(panel.button.enabled).toBe(false);
    expect(panel.button.why).toContain('lancez la vague');
  });

  it('le load balancer vient avant le scaling qui l’exige', () => {
    const plan = planHints({ game: pathGame(2), scenario: urlShortener, catalog, draft: A.withCache });
    const kinds = plan.hints.map((h) => h.key);
    const lb = kinds.findIndex((k) => k.startsWith('place|load-balancer'));
    const scaling = kinds.findIndex((k) => k.includes('horizontal-scaling') || k.includes('autoscaling'));
    if (scaling >= 0) expect(lb).toBeLessThan(scaling);
  });

  it('apparie le serveur et le worker par leurs voisins', () => {
    const answer = A.queuedClicks(2);
    const { missing, extra } = compare(answer, answer, catalog);
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    // Sans scaling, le worker se distingue toujours par la file qui l'alimente.
    const swapped: Architecture = { ...answer, nodes: [...answer.nodes].reverse() };
    expect(compare(answer, swapped, catalog)).toEqual({ missing: [], extra: [] });
  });
});

describe('le bouton « Un indice »', () => {
  // Vague 3 du raccourcisseur depuis le cache de la vague 2 : il manque plusieurs éléments.
  const ctx = (game: GameState, draft = A.withCache) => ({ game, scenario: urlShortener, catalog, draft });
  const base = { ...newGame(), waveIndex: 2, committed: A.withCache, history: [EMPTY, A.minimal, A.withCache] };

  it('sans essai perdu, aucun indice', () => {
    const game = { ...base, replays: 0 };
    expect(askHint(ctx(game))).toBe(game);
    const panel = hintPanel(ctx(game), theme);
    expect(panel.button).toEqual({ enabled: false, why: 'Disponible après un essai perdu.' });
  });

  it('après n essais perdus, n indices au plus', () => {
    let game: GameState = { ...base, replays: 2 };
    game = askHint(ctx(game));
    game = askHint(ctx(game));
    expect(game.hints).toHaveLength(2);
    expect(askHint(ctx(game))).toBe(game);
    const panel = hintPanel(ctx(game), theme);
    expect(panel.button.why).toBe('Un indice de plus après le prochain essai perdu.');
    expect(panel.given).toHaveLength(2);
    expect(panel.given.every((g) => !g.done)).toBe(true);
    expect(panel.highlight).toBeDefined();
  });

  it('un indice satisfait par le brouillon est marqué fait', () => {
    const game = askHint(ctx({ ...base, replays: 1 }));
    const [key] = game.hints!;
    expect(key).toBe('place|cdn|1');
    expect(hintPanel(ctx(game), theme).given[0]!.done).toBe(false);
    const panel = hintPanel(ctx(game, addNode(A.withCache, 'cdn')), theme);
    expect(panel.given[0]!.done).toBe(true);
    // Le droit est consommé : le suivant attend le prochain essai perdu.
    expect(panel.button.enabled).toBe(false);
  });
});

describe('le texte d’un indice', () => {
  const ids = [...Object.keys(catalog.components), ...Object.keys(catalog.upgrades)].filter((id) => id.includes('-') || id === 'pubsub');

  it('nom technique d’abord, métaphore entre parenthèses, une ligne « En vrai », aucun id brut', () => {
    const texts: { says: string; real: string }[] = [];
    for (const { scenario } of SCENARIOS) {
      scenario.waves.forEach((_, i) => {
        const committed = i === 0 ? EMPTY : answersOf(scenario.id, i - 1)[0]!;
        const draft = i === 0 ? startOf(scenario) : committed;
        const game = gameAt(scenario, i, committed);
        for (const h of planHints({ game, scenario, catalog, draft }).hints) texts.push(hintText(h, catalog, theme, draft));
      });
    }
    expect(texts.length).toBeGreaterThan(10);
    for (const t of texts) {
      expect(t.says.length).toBeGreaterThan(0);
      expect(t.real.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(t.says, id).not.toContain(id);
        expect(t.real, id).not.toContain(id);
      }
      expect(t.says).not.toMatch(/\{\w+\}/);
    }
    const place = hintText({ kind: 'place', key: 'place|message-queue|1', type: 'message-queue', count: 1 }, catalog, theme, A.minimal);
    expect(place.real).toContain('Message queue (Relais de poste)');
    expect(place.says).toContain('Relais de poste');
    const scaling = hintText(
      { kind: 'upgrade', key: 'upgrade|app-server|horizontal-scaling|3', node: { type: 'app-server' }, upgrade: 'horizontal-scaling', level: 3 },
      catalog,
      theme,
      A.minimal,
    );
    expect(scaling.real).toContain('Horizontal scaling sur Application server (Tour des scribes) : 3 instances en plus');
    const limit = hintText(
      { kind: 'upgrade', key: 'upgrade|load-balancer|rate-limiting|3', node: { type: 'load-balancer' }, upgrade: 'rate-limiting', level: 3 },
      catalog,
      theme,
      A.minimal,
    );
    expect(limit.real).toContain('palier 40 req/s par client');
  });
});
