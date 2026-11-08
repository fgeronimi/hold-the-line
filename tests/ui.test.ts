import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { calibrationGroups, changedSettings, getAt, parseField, setAt } from '../src/ui/calibration.ts';
import { addLink, addNode, nextNodeId, removeLink, removeNode, setUpgrade, toggleLinkKind } from '../src/ui/editor.ts';

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

  it('fusionne les types d’un lien existant et ignore les liens absurdes', () => {
    const r = addLink(A.withCache, 'app', 'cache', ['write', 'read']);
    expect(r.links.find((l) => l.from === 'app' && l.to === 'cache')!.kinds).toEqual(['read', 'write']);
    expect(addLink(A.minimal, 'app', 'app', ['read'])).toBe(A.minimal);
    expect(addLink(A.minimal, 'app', 'db', [])).toBe(A.minimal);
  });

  it('retirer le dernier type d’un lien retire le lien', () => {
    const one = { nodes: A.minimal.nodes, links: [{ from: 'src', to: 'app', kinds: ['read' as const] }] };
    expect(toggleLinkKind(one, 0, 'read').links).toEqual([]);
    expect(toggleLinkKind(one, 0, 'write').links[0]!.kinds).toEqual(['read', 'write']);
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
