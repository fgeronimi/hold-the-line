import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { calibrationGroups, changedSettings, getAt, parseField, setAt } from '../src/ui/calibration.ts';
import { addLink, addNode, nextNodeId, removeLink, removeNode, setUpgrade } from '../src/ui/editor.ts';
import { renderCard, renderDialog, renderHand, renderHud, renderToolbar, upgradePips, type ViewState } from '../src/ui/views.ts';
import { fan } from '../src/ui/hand.ts';
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

describe('l’éventail de la main', () => {
  it('symétrique, centré, ses bords tombent et penchent vers l’extérieur', () => {
    const slots = fan(5);
    expect(slots.map((x) => x.offset)).toEqual([-2, -1, 0, 1, 2]);
    expect(slots[2]).toEqual({ offset: 0, tilt: 0, drop: 0 });
    expect(slots[0]!.tilt).toBe(-slots[4]!.tilt);
    expect(slots[0]!.tilt).toBeLessThan(0);
    expect(slots[0]!.drop).toBe(1);
    expect(slots[1]!.drop).toBeLessThan(slots[0]!.drop);
  });

  it('une grande main ne s’ouvre pas plus qu’une moyenne', () => {
    const spread = (n: number) => fan(n).at(-1)!.tilt - fan(n)[0]!.tilt;
    expect(spread(3)).toBeLessThan(spread(6));
    expect(spread(11)).toBeCloseTo(spread(20));
    expect(spread(11)).toBeLessThanOrEqual(24);
  });

  it('une carte seule est droite, et une main vide n’a pas de carte', () => {
    expect(fan(1)).toEqual([{ offset: 0, tilt: 0, drop: 0 }]);
    expect(fan(0)).toEqual([]);
  });
});

describe('la main de cartes', () => {
  const view = (extra: Partial<ViewState> = {}, draft = A.minimal): ViewState =>
    ({ catalog, scenario: urlShortener, game: newGame(), draft, attempts: [], tool: { kind: 'select' }, phase: 'build', history: { undo: 0, redo: 0 }, ...extra }) as unknown as ViewState;
  const palette = Object.values(catalog.components).filter((d) => d.behavior !== 'source' && !d.prePlaced);

  it('fermée tant qu’aucune case ni « Bâtir » ne l’ouvre, et hors de la construction', () => {
    expect(renderHand(view())).toBe('');
    expect(renderHand(view({ showHand: true, phase: 'debrief' }))).toBe('');
  });

  it('une carte par bâtiment constructible, avec son prix, ses chiffres et ses évolutions', () => {
    const html = renderHand(view({ buildAt: { q: 5, r: 3 } }));
    expect(html.match(/data-action="pick-card"/g)).toHaveLength(palette.length);
    expect(html).not.toContain('data-type="domain-service"');
    expect(html).toContain('Autoscaling');
    // Chaque carte dit l'ordre de grandeur réel et nomme sa source (D3b) ; le lien est sur la fiche.
    expect(html.match(/class="real named"/g)).toHaveLength(palette.length);
    expect(html).toContain('(quotas Amazon SQS)');
    expect(html).toContain(`</svg> ${catalog.components['app-server']!.cost}</span>`);
    expect(html).toContain('Choisir un bâtiment pour cette case.');
  });

  it('ouverte par « Bâtir », elle demande de désigner la case ensuite', () => {
    expect(renderHand(view({ showHand: true }))).toContain('puis cliquer sa case');
  });

  it('sur un chemin, dit que le bâtiment s’insère dans le lien', () => {
    const draft = { ...A.minimal, links: A.minimal.links.map((l, i) => (i === 0 ? { ...l, path: [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }] } : l)) };
    expect(renderHand(view({ buildAt: { q: 1, r: 0 } }, draft))).toContain('s’insère dans le lien');
    expect(renderHand(view({ buildAt: { q: 7, r: 2 } }, draft))).not.toContain('s’insère');
  });

  it('la miniature du plateau remplace l’icône du thème dès qu’elle existe', () => {
    const card = (html: string) => html.match(/<button class="hcard[^"]*" data-action="pick-card" data-type="cache"[\s\S]*?<\/button>/)![0];
    expect(card(renderHand(view({ showHand: true })))).toContain('class="emoji"');
    const drawn = card(renderHand(view({ showHand: true, thumbnails: { cache: 'data:image/png;base64,AAAA' } })));
    expect(drawn).toContain('<img src="data:image/png;base64,AAAA"');
    expect(drawn).not.toContain('class="emoji"');
  });

  it('un bâtiment au-delà du budget le dit, et reste jouable', () => {
    const tight = { ...urlShortener, waves: urlShortener.waves.map((w) => ({ ...w, budget: 0 })) };
    const html = renderHand(view({ showHand: true, scenario: tight }));
    // Le filet dit ce qui manque (I18) : à budget nul, tout le prix de la carte.
    expect(html.match(/Il manque \d+/g)).toHaveLength(palette.length);
    expect(html).toContain(`Il manque ${catalog.components['app-server']!.cost}<`);
    expect(html).not.toContain('disabled');
    expect(renderHand(view({ showHand: true }))).toContain('</svg> Constructible');
  });

  it('la carte soulevée au doigt annonce le second contact', () => {
    const html = renderHand(view({ buildAt: { q: 5, r: 3 }, liftedCard: 'cache' }));
    expect(html).toMatch(/class="hcard lifted" data-action="pick-card" data-type="cache"/);
    expect(html.match(/class="hcard lifted"/g)).toHaveLength(1);
    expect(html).toContain('Toucher encore pour bâtir');
    expect(renderHand(view({ showHand: true, liftedCard: 'cache' }))).toContain('Toucher encore pour choisir');
  });

  it('la main passe devant la carte du bâtiment sélectionné', () => {
    expect(renderCard(view({ selectedNode: 'db' }))).toContain('detail-card');
    const both = renderCard(view({ selectedNode: 'db', showHand: true }));
    expect(both).toContain('class="hand"');
    expect(both).not.toContain('detail-card');
  });
});

describe('le bouton « Un indice »', () => {
  // Vague 3 du raccourcisseur, depuis le cache validé en vague 2.
  const view = (replays: number, extra: Partial<ViewState> = {}): ViewState =>
    ({
      catalog,
      scenario: urlShortener,
      game: { ...newGame(), waveIndex: 2, committed: A.withLockedCache, history: [{ nodes: [], links: [] }, A.minimal, A.withLockedCache], replays, hints: [] },
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
    const html = renderToolbar({ ...s, game: { ...s.game, hints: ['place|load-balancer|1'] } });
    expect(button(html)).toContain('disabled');
    expect(html).toContain('Un indice de plus après le prochain essai perdu.');
    expect(html).toContain('Load balancer (');
    // L'indice « poser un load balancer » fait clignoter « Bâtir », puis sa carte une fois la main ouverte.
    expect(html).toMatch(/class="tool build hint" data-action="open-hand"/);
    const open = { ...s, showHand: true, game: { ...s.game, hints: ['place|load-balancer|1'] } };
    expect(renderToolbar(open)).toMatch(/class="tool build active" data-action="open-hand"/);
    expect(renderHand(open)).toMatch(/class="hcard hint" data-action="pick-card" data-type="load-balancer"/);
    expect(renderHand(open).match(/class="hcard hint"/g)).toHaveLength(1);
  });

  it('la pastille de l’évolution désignée clignote', () => {
    const html = upgradePips({ id: 'db', type: 'database' }, catalog, { move: true, remove: true }, { node: 'db', upgrade: 'read-replica' });
    expect(html).toMatch(/class="pip leveled hint"/);
    expect(upgradePips({ id: 'db', type: 'database' }, catalog, { move: true, remove: true }, { node: 'app', upgrade: 'read-replica' })).not.toContain('hint');
  });

  it('au debrief d’une vague perdue', async () => {
    const { simulateWave } = await import('../src/engine/simulate.ts');
    const wave = urlShortener.waves[2]!;
    const result = simulateWave(A.withCache, wave, catalog);
    expect(result.won).toBe(false);
    const attempt = { id: 1, label: 'x', waveIndex: 2, result, played: true, settings: [], arch: A.withCache, stars: { held: false, lean: false, thrifty: false } };
    const html = renderDialog(view(1, { phase: 'debrief', attempts: [attempt], current: 1, debriefTab: 'analysis' } as Partial<ViewState>));
    expect(button(html)).not.toContain('disabled');
  });
});

describe('l’accueil (P4)', () => {
  const view = (extra: Partial<ViewState>): ViewState =>
    ({ catalog, scenario: urlShortener, game: newGame(), draft: A.minimal, attempts: [], achievements: {}, tool: { kind: 'select' }, history: { undo: 0, redo: 0 }, phase: 'choose', choices: [], ...extra }) as unknown as ViewState;

  it('passe devant l’écran de choix : le chambellan en pied, les étapes, puis le choix', () => {
    const html = renderDialog(view({ showWelcome: true }));
    expect(html).toContain('class="narrator-full" src="narrator-full.webp"');
    expect(html).toContain('entretien de system design');
    expect(html.match(/<li>/g)!.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('data-action="show-welcome"');
    expect(renderDialog(view({}))).toContain('Comment jouer');
    expect(renderDialog(view({}))).not.toContain('narrator-full');
  });
});

describe('la barre du haut', () => {
  // La vague 2 vient d'être gagnée : la partie a déjà avancé et compté ses étoiles.
  const all = { held: true, lean: true, thrifty: true };
  const won = { ...newGame(), waveIndex: 2, stars: [all, { ...all, lean: false }], history: [{ nodes: [], links: [] }, A.minimal, A.withCache] };
  const view = (extra: Partial<ViewState>): ViewState =>
    ({ catalog, scenario: urlShortener, game: won, draft: A.withCache, attempts: [{ id: 7, waveIndex: 1 }], current: 7, tool: { kind: 'select' }, history: { undo: 0, redo: 0 }, ...extra }) as unknown as ViewState;

  it('n’existe pas avant le choix du scénario', () => {
    expect(renderHud(view({ phase: 'choose' }))).toBe('');
  });

  it('pendant la vague, garde les étoiles d’avant ; le debrief les révèle ; plus de score', () => {
    expect(renderHud(view({ phase: 'wave' }))).toMatch(/<b>3 <em>\/ 18<\/em><\/b>/);
    expect(renderHud(view({ phase: 'debrief' }))).toMatch(/<b>5 <em>\/ 18<\/em><\/b>/);
    expect(renderHud(view({ phase: 'debrief' }))).not.toContain('score');
  });

  it('le menu propose de rejouer chaque vague tenue ; pendant un rejeu, d’en sortir', () => {
    const menu = renderHud(view({ phase: 'build', showMenu: true }));
    expect(menu).toContain('data-action="replay-wave" data-wave="0"');
    expect(menu).toContain('data-action="replay-wave" data-wave="1"');
    expect(menu).not.toContain('data-wave="2"');
    const inPractice = renderHud(view({ phase: 'build', showMenu: true, practice: { game: won, draft: A.withCache } }));
    expect(inPractice).toContain('data-action="leave-practice"');
    expect(inPractice).toContain('Rejeu · Vague');
  });
});
