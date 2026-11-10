import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { calibrationGroups, changedSettings, getAt, parseField, setAt } from '../src/ui/calibration.ts';
import { addLink, addNode, nextNodeId, removeLink, removeNode, setUpgrade } from '../src/ui/editor.ts';

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
