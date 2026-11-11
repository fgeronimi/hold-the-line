import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { calibrationGroups, changedSettings, getAt, parseField, setAt } from '../src/ui/calibration.ts';
import { addLink, addNode, nextNodeId, removeLink, removeNode, setUpgrade } from '../src/ui/editor.ts';
import { renderBuildMenu, renderDialog, renderToolbar, upgradePips, type ViewState } from '../src/ui/views.ts';
import { newGame } from '../src/engine/game.ts';

describe('editor', () => {
  it('numérote les nœuds du même type', () => {
    const once = addNode(A.minimal, 'app-server');
    expect(once.nodes.at(-1)!.id).toBe('app-server');
    expect(nextNodeId(addNode(once, 'app-server'), 'app-server')).toBe('app-server-3');
  });

  it('retire les liens d’un nœud retiré', () => {
    const r = removeNode(A.withCache, 'cache');
    expect(r.links.some((l) => l.from === 'cache' || l.to === 'cache')).toBe(false);
    expect(r.links).toHaveLength(2);
  });

  it('un niveau 0 retire l’évolution', () => {
    const up = setUpgrade(A.minimal, 'db', 'read-replica', 2);
    expect(up.nodes.find((n) => n.id === 'db')!.upgrades).toEqual({ 'read-replica': 2 });
    expect(setUpgrade(up, 'db', 'read-replica', 0).nodes.find((n) => n.id === 'db')).toEqual({ id: 'db', type: 'database' });
  });

  it('retirer la dernière évolution garde la case et le statut de service en place', () => {
    const fixed = { id: 'mail', type: 'app-server', cell: { q: 1, r: 2 }, fixed: { tech: 'Service e-mail', metaphor: 'Messager' }, upgrades: { idempotence: 1 } };
    const out = setUpgrade({ nodes: [fixed], links: [] }, 'mail', 'idempotence', 0).nodes[0];
    expect(out).toEqual({ id: 'mail', type: 'app-server', cell: { q: 1, r: 2 }, fixed: fixed.fixed });
  });

  it('ignore un lien déjà présent ou vers soi-même', () => {
    expect(addLink(A.minimal, 'app', 'db')).toBe(A.minimal);
    expect(addLink(A.minimal, 'app', 'app')).toBe(A.minimal);
    expect(addLink(A.minimal, 'db', 'app').links).toHaveLength(3);
    expect(removeLink(A.minimal, 0).links).toEqual([A.minimal.links[1]]);
  });
});

describe('calibration', () => {
  it('modifie une copie sans toucher l’original', () => {
    const next = setAt(catalog, 'components.cache.hitRate', 0.5);
    expect(next.components.cache!.hitRate).toBe(0.5);
    expect(catalog.components.cache!.hitRate).toBe(0.95);
    expect(next.components.database).toBe(catalog.components.database);
  });

  it('modifie un tableau par son index', () => {
    const next = setAt(urlShortener, 'waves.1.budget', 999);
    expect(next.waves[1]!.budget).toBe(999);
    expect(Array.isArray(next.waves)).toBe(true);
    expect(urlShortener.waves[1]!.budget).toBe(115);
  });

  it('chaque champ proposé pointe vers une valeur existante', () => {
    for (const g of calibrationGroups(catalog, urlShortener, 3)) {
      const root = g.root === 'catalog' ? catalog : urlShortener;
      for (const f of g.fields) expect(getAt(root, f.path), f.path).not.toBeUndefined();
    }
  });

  it('liste les réglages qui diffèrent du code', () => {
    const defaults = { catalog, scenario: urlShortener };
    const current = {
      catalog: setAt(catalog, 'components.cache.hitRate', 0.2),
      scenario: setAt(urlShortener, 'waves.2.budget', 200),
    };
    expect(changedSettings(defaults, current, 2)).toEqual(['waves.2.budget = 200', 'cache.hitRate = 0.2']);
    expect(changedSettings(defaults, defaults, 2)).toEqual([]);
  });

  it('refuse une saisie qui n’est pas un nombre', () => {
    const f = { path: 'x', label: 'x' };
    expect(parseField('12.5', f)).toBe(12.5);
    expect(parseField('', f)).toBeUndefined();
    expect(parseField('abc', f)).toBeUndefined();
    expect(parseField('10, 20,40', { ...f, list: true })).toEqual([10, 20, 40]);
    expect(parseField('10, x', { ...f, list: true })).toBeUndefined();
  });
});

describe('pénalité de rejeu', () => {
  it('ne retire jamais plus que les points de la vague', async () => {
    const { replayCut } = await import('../src/ui/views.ts');
    expect(replayCut(2)).toBe('−40 % au score');
    expect(replayCut(13)).toBe('la vague ne rapporte plus de points');
  });
});

describe('pastilles d’évolution', () => {
  // Pas de DOM dans les tests : on lit le HTML produit, pastille par pastille.
  const pipsOf = (node: Parameters<typeof upgradePips>[0]) => upgradePips(node, catalog).split(/(?=<(?:div|button) class="pip)/).slice(1);

  it('une pastille par évolution du bâtiment ; − et + pour les niveaux, bascule pour le reste', () => {
    const [scaling, auto, breaker] = pipsOf({ id: 'app', type: 'app-server', upgrades: { 'horizontal-scaling': 2, 'circuit-breaker': 1 } });
    expect(scaling).toContain('data-upgrade="horizontal-scaling"');
    expect(scaling).toContain('data-delta="-1"');
    expect(scaling).toContain('data-delta="1"');
    expect(scaling).toContain('<b>+2</b>');
    expect(auto).toContain('data-upgrade="autoscaling"');
    expect(auto).toContain('<b></b>');
    expect(breaker).toContain('data-upgrade="circuit-breaker"');
    expect(breaker).toContain('data-delta="toggle"');
    expect(breaker).toMatch(/^<button class="pip on"/);
  });

  it('grise − au plus bas et + au plus haut ; le rate limiting affiche son palier', () => {
    const [limit] = pipsOf({ id: 'lb', type: 'load-balancer', upgrades: { 'rate-limiting': 5 } });
    expect(limit).toMatch(/data-delta="1" disabled/);
    expect(limit).not.toMatch(/data-delta="-1" disabled/);
    expect(limit).toContain('<b>160/s</b>');
    expect(pipsOf({ id: 'db', type: 'database' })[0]).toMatch(/data-delta="-1" disabled/);
  });

  it('un bâtiment sans évolution n’a pas de pastille', () => {
    expect(upgradePips({ id: 'q', type: 'pubsub' }, catalog)).toBe('');
  });
});

describe('pastilles déplacer et retirer', () => {
  it('en tête de colonne, selon ce que le bâtiment permet', () => {
    const html = upgradePips({ id: 'app', type: 'app-server' }, catalog, { move: true, remove: true });
    expect(html.indexOf('data-tool="move"')).toBeLessThan(html.indexOf('data-upgrade'));
    expect(html).toContain('data-action="remove-node" data-node="app"');
    const fixed = upgradePips({ id: 'mail', type: 'domain-service' }, catalog, { move: true, remove: false });
    expect(fixed).not.toContain('remove-node');
    expect(upgradePips({ id: 'bus', type: 'pubsub' }, catalog, { move: true, remove: true })).toContain('data-tool="move"');
  });
});

describe('construire sur une case vide', () => {
  const view = (draft = A.minimal): ViewState =>
    ({ catalog, scenario: urlShortener, game: newGame(), draft, attempts: [], tool: { kind: 'select' }, phase: 'build', history: { undo: 0, redo: 0 } }) as unknown as ViewState;

  it('une fiche par bâtiment de la palette, avec ses chiffres et ses évolutions', () => {
    const html = renderBuildMenu(view(), { q: 5, r: 3 });
    const palette = Object.values(catalog.components).filter((d) => d.behavior !== 'source' && !d.prePlaced);
    expect(html.match(/data-action="build-at"/g)).toHaveLength(palette.length);
    expect(html).not.toContain('data-type="domain-service"');
    expect(html).toContain('Autoscaling');
  });

  it('sur un chemin, dit que le bâtiment s’insère dans le lien', () => {
    const draft = { ...A.minimal, links: A.minimal.links.map((l, i) => (i === 0 ? { ...l, path: [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }] } : l)) };
    expect(renderBuildMenu(view(draft), { q: 1, r: 0 })).toContain('s’insère dans le lien');
    expect(renderBuildMenu(view(draft), { q: 7, r: 2 })).not.toContain('s’insère');
  });
});

describe('le bouton « Un indice »', () => {
  // Vague 3 du raccourcisseur, depuis le cache validé en vague 2.
  const view = (replays: number, extra: Partial<ViewState> = {}): ViewState =>
    ({
      catalog,
      scenario: urlShortener,
      game: { ...newGame(), waveIndex: 2, committed: A.withCache, history: [{ nodes: [], links: [] }, A.minimal, A.withCache], replays, hints: [] },
      draft: A.withCache,
      attempts: [],
      tool: { kind: 'select' },
      phase: 'build',
      history: { undo: 0, redo: 0 },
      ...extra,
    }) as unknown as ViewState;
  const button = (html: string) => html.match(/<button data-action="hint"[^>]*>/)![0];

  it('grisé avant le premier essai perdu, et dit pourquoi', () => {
    const html = renderToolbar(view(0));
    expect(button(html)).toContain('disabled');
    expect(html).toContain('Disponible après un essai perdu.');
  });

  it('actif après un essai perdu ; un indice donné s’affiche et fait clignoter son bouton', () => {
    expect(button(renderToolbar(view(1)))).not.toContain('disabled');
    const s = view(1);
    const html = renderToolbar({ ...s, game: { ...s.game, hints: ['place|cdn|1'] } });
    expect(button(html)).toContain('disabled');
    expect(html).toContain('Un indice de plus après le prochain essai perdu.');
    expect(html).toContain('CDN (Avant-poste)');
    expect(html).toMatch(/class="tool build hint" data-action="tool" data-tool="place" data-type="cdn"/);
  });

  it('la pastille de l’évolution désignée clignote', () => {
    const html = upgradePips({ id: 'db', type: 'database' }, catalog, { move: true, remove: true }, { node: 'db', upgrade: 'read-replica' });
    expect(html).toMatch(/class="pip leveled hint"/);
    expect(upgradePips({ id: 'db', type: 'database' }, catalog, { move: true, remove: true }, { node: 'app', upgrade: 'read-replica' })).not.toContain('hint');
  });

  it('au debrief d’une vague perdue', async () => {
    const { simulateWave } = await import('../src/engine/simulate.ts');
    const wave = urlShortener.waves[2]!;
    const result = simulateWave(A.withCache, wave, catalog, A.withCache);
    expect(result.won).toBe(false);
    const attempt = { id: 1, label: 'x', waveIndex: 2, result, score: 0, played: true, settings: [], arch: A.withCache, stars: { held: false, firstTry: false, thrifty: false } };
    const html = renderDialog(view(1, { phase: 'debrief', attempts: [attempt], current: 1, debriefTab: 'analysis' } as Partial<ViewState>));
    expect(button(html)).not.toContain('disabled');
  });
});
