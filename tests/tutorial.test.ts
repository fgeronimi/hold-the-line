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

  it('signale un service attendu que rien n’alimente', async () => {
    const { market } = await import('../src/data/scenarios/market.ts');
    const M = await import('../src/data/scenarios/market.archetypes.ts');
    const first = market.waves[0]!;
    const noQueue = { nodes: M.inline.nodes, links: M.inline.links };
    expect(guideStep(noQueue, catalog, first, 0, { nodes: [], links: [] }, false).id).toBe('feed-consumer');
    expect(guideStep(M.queued, catalog, first, 0, { nodes: [], links: [] }, false).id).toBe('launch');
  });

  it('signale un bâtiment qui reçoit du travail sans rien pour l’évacuer', async () => {
    const { market } = await import('../src/data/scenarios/market.ts');
    const M = await import('../src/data/scenarios/market.archetypes.ts');
    const mailToDb = M.queued.links.findIndex((l) => l.from === 'mail' && l.to === 'db');
    const deadEnd = { ...M.queued, links: M.queued.links.filter((_, i) => i !== mailToDb) };
    const step = guideStep(deadEnd, catalog, market.waves[0]!, 0, { nodes: [], links: [] }, false);
    expect(step.id).toBe('dead-end');
    expect(step.real).toContain('Service e-mail');
    // Le cache est consulté, pas traversé : sans lien sortant, il n'est pas une impasse.
    expect(guideStep(A.withCache, catalog, urlShortener.waves[1]!, 1, { nodes: [], links: [] }).id).toBe('launch');
  });
});
