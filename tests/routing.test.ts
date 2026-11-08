import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { linkFlows, routeTable } from '../src/engine/routing.ts';
import type { Architecture } from '../src/engine/types.ts';
import { validateArchitecture } from '../src/engine/validate.ts';

describe('routeTable', () => {
  it('envoie les lectures au cache plutôt qu’à la base', () => {
    const r = routeTable(A.withCache, catalog).get('app')!;
    expect(r).toEqual({ read: ['cache'], write: ['db'], async: ['db'] });
  });

  it('envoie l’async à la file quand elle est reliée, sinon à la base', () => {
    expect(routeTable(A.queuedClicks(0), catalog).get('app')!.async).toEqual(['queue']);
    expect(routeTable(A.inlineClicks(0), catalog).get('app')!.async).toEqual(['db']);
  });

  it('répartit entre voisins équivalents', () => {
    const arch: Architecture = {
      nodes: [{ id: 'lb', type: 'load-balancer' }, { id: 'a1', type: 'app-server' }, { id: 'a2', type: 'app-server' }],
      links: [{ from: 'lb', to: 'a1' }, { from: 'lb', to: 'a2' }],
    };
    expect(routeTable(arch, catalog).get('lb')!.read).toEqual(['a1', 'a2']);
  });

  it('ne route rien vers un voisin qui n’accepte pas le type', () => {
    const arch: Architecture = {
      nodes: [{ id: 'app', type: 'app-server' }, { id: 'cache', type: 'cache' }],
      links: [{ from: 'app', to: 'cache' }],
    };
    expect(routeTable(arch, catalog).get('app')!.write).toEqual([]);
  });
});

describe('linkFlows', () => {
  it('n’affiche que ce qui circule vraiment', () => {
    const flows = linkFlows(A.withCache, catalog);
    expect(flows.get('src→app')).toEqual(['read', 'write', 'async']);
    expect(flows.get('app→cache')).toEqual(['read']);
    expect(flows.get('cache→db')).toEqual(['read']);
    expect(flows.get('app→db')).toEqual(['write', 'async']);
  });

  it('montre la file et le worker sur le chemin de l’async', () => {
    const flows = linkFlows(A.queuedClicks(0), catalog);
    expect(flows.get('app→queue')).toEqual(['async']);
    expect(flows.get('worker→db')).toEqual(['async']);
    expect(flows.get('app→db')).toEqual(['write']);
  });
});

it('refuse un lien en double', () => {
  const arch = { ...A.minimal, links: [...A.minimal.links, { from: 'app', to: 'db' }] };
  const v = validateArchitecture(arch, catalog);
  expect(v.ok ? [] : v.errors).toEqual(['Lien en double : app → db']);
});
