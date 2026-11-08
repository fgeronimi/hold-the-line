import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { fortifiedCity } from '../src/data/themes/fortified-city.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import type { Architecture } from '../src/engine/types.ts';
import { analyzeWave } from '../src/ui/debrief.ts';

const wave = (id: string) => urlShortener.waves.find((w) => w.id === id)!;
const analyze = (arch: Architecture, id: string) =>
  analyzeWave(simulateWave(arch, wave(id), catalog), arch, wave(id), catalog, fortifiedCity);

describe('analyzeWave', () => {
  it('repère un lien manquant : le serveur n’a nulle part où envoyer ses lectures', () => {
    const findings = analyze(A.noDatabase, 'launch');
    expect(findings[0]).toMatchObject({ tone: 'bad', node: 'app', concept: 'Chemin d’une requête' });
    expect(findings[0]!.tech).toContain('lecture');
  });

  it('désigne les archives comme goulot quand les lectures explosent', () => {
    const findings = analyze(A.minimal, 'read-surge');
    expect(findings[0]).toMatchObject({ tone: 'bad', node: 'db', concept: 'Cache, réplication' });
    expect(findings[0]!.says).toContain('Archives royales');
  });

  it('explique le trésor vide et nomme les bâtiments les plus chers', () => {
    const finding = analyze(A.scaled(4), 'marketing-peak').find((f) => f.concept === 'Arbitrage coût / fiabilité')!;
    expect(finding.tech).toContain('175 / 170');
    expect(finding.remedy).toContain('Les plus chers');
  });

  it('signale une garde trop stricte qui refoule les partenaires', () => {
    const findings = analyze(A.scaled(3, { rateLimitTier: 2 }), 'noisy-client');
    expect(findings.some((f) => f.concept === 'Rate Limiting' && f.tone === 'bad')).toBe(true);
  });

  it('explique les clics perdus derrière un CDN', () => {
    const findings = analyze(A.withCdn({ rateLimitTier: A.TIER_40, queue: true }), 'click-tracking');
    expect(findings.some((f) => f.tech?.includes('301 contre 302'))).toBe(true);
  });

  it('félicite une vague tenue, avec le goulot le plus proche et les pillards repoussés', () => {
    const findings = analyze(A.scaled(3, { rateLimitTier: A.TIER_40 }), 'noisy-client');
    expect(findings[0]!.tone).toBe('good');
    expect(findings[0]!.tech).toContain('Le goulot le plus proche');
    expect(findings.some((f) => f.says.includes('pillards'))).toBe(true);
  });

  it('conseille d’alléger un bâtiment qui a tourné à vide', () => {
    const findings = analyze(A.withCache, 'launch');
    expect(findings.some((f) => f.tone === 'tip' && f.says.includes('Carnet du scribe'))).toBe(true);
  });

  it('raconte l’incident : un serveur unique qui tombe est un SPOF', () => {
    const findings = analyze(A.withCdn(), 'marketing-peak');
    expect(findings.some((f) => f.concept === 'Redondance, SPOF' && f.tone === 'bad')).toBe(true);
    const redundant = analyze(A.scaled(3), 'marketing-peak');
    expect(redundant.some((f) => f.concept === 'Redondance, SPOF' && f.tone === 'good')).toBe(true);
  });

  it('nomme les composants par leur nom technique d’abord', () => {
    const findings = analyze(A.noDatabase, 'launch');
    expect(findings[0]!.tech).toContain('Application server (Tour des scribes)');
  });
});
