import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import type { Architecture } from '../src/engine/types.ts';
import { tutorialStep } from '../src/ui/tutorial.ts';

const src = { id: 'src', type: 'traffic-source' };
const app = { id: 'app', type: 'app-server' };
const db = { id: 'db', type: 'database' };
const step = (arch: Architecture) => tutorialStep(arch, catalog).id;

describe('tutorialStep', () => {
  it('guide pas à pas jusqu’à l’architecture minimale', () => {
    expect(step({ nodes: [src], links: [] })).toBe('place-server');
    expect(step({ nodes: [src, app], links: [] })).toBe('link-source');
    expect(step({ nodes: [src, app], links: [{ from: 'src', to: 'app' }] })).toBe('place-database');
    expect(step({ nodes: [src, app, db], links: [{ from: 'src', to: 'app' }] })).toBe('link-database');
    expect(step(A.minimal)).toBe('launch');
  });

  it('suit un joueur qui construit dans le désordre', () => {
    expect(step({ nodes: [src, db, app], links: [{ from: 'app', to: 'db' }] })).toBe('link-source');
  });

  it('montre le bouton à utiliser', () => {
    expect(tutorialStep({ nodes: [src], links: [] }, catalog).highlight).toEqual({ tool: 'place', type: 'app-server' });
    expect(tutorialStep(A.minimal, catalog).highlight).toEqual({ tool: 'launch' });
  });
});
