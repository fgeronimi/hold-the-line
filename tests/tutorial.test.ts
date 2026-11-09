import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import type { Architecture } from '../src/engine/types.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { guideStep, tutorialStep } from '../src/ui/tutorial.ts';

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

describe('guideStep', () => {
  const wave = (id: string) => urlShortener.waves.find((w) => w.id === id)!;

  it('reste affiché après la vague 1 : le défi, sans souffler la parade', () => {
    const step = guideStep(A.minimal, catalog, wave('read-surge'), 1, A.minimal);
    expect(step.id).toBe('launch');
    expect(step.real).toContain('900 lectures');
    expect(step.real).toContain('Incident annoncé');
    expect(step.real).not.toMatch(/réplica|ajoute[rz] un cache/i);
  });

  it('dit ce qui bloque : budget, complexité, plan invalide', () => {
    expect(guideStep(A.scaled(4), catalog, wave('marketing-peak'), 2, A.withCache).id).toBe('over-budget');
    const cycle = { nodes: A.minimal.nodes, links: [...A.minimal.links, { from: 'db', to: 'app' }] };
    expect(guideStep(cycle, catalog, wave('read-surge'), 1, A.minimal).id).toBe('fix');
  });

  it('garde le pas-à-pas en vague 1', () => {
    expect(guideStep({ nodes: [{ id: 'src', type: 'traffic-source' }], links: [] }, catalog, wave('launch'), 0, { nodes: [], links: [] }).id).toBe('place-server');
  });
});
