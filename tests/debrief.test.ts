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
  it('ouvre sur la défaite, puis le lien manquant', () => {
    const findings = analyze(A.noDatabase, 'launch');
    expect(findings[0]).toMatchObject({ tone: 'bad' });
    expect(findings[0]!.says).toContain('tombée');
    expect(findings[1]).toMatchObject({ tone: 'bad', node: 'app', concept: 'Chemin d’une requête' });
    expect(findings[1]!.tech).toContain('Application server (Tour des scribes)');
  });

  it('désigne les archives comme goulot quand les lectures explosent', () => {
    const finding = analyze(A.minimal, 'read-surge').find((f) => f.node === 'db')!;
    expect(finding).toMatchObject({ tone: 'bad', concept: 'Cache, réplication' });
    expect(finding.says).toContain('Archives royales');
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

  it('une vague tenue s’ouvre sur ce qui a marché, chiffré', () => {
    const [opening] = analyze(A.scaled(3, { rateLimitTier: A.TIER_40 }), 'noisy-client');
    expect(opening!.tone).toBe('good');
    expect(opening!.says).toContain('pillards');
    expect(opening!.says).toContain('tours de scribes');
    expect(opening!.tech).toContain('des lectures');
  });

  it('une vague tenue n’a pas de rouge : l’incident encaissé est une alerte, raconté une seule fois', () => {
    const findings = analyze(A.withCache, 'read-surge');
    expect(findings[0]!.says).toMatch(/Votre Carnet du scribe a fait le travail : 9\d voyageurs sur 100/);
    expect(findings.some((f) => f.tone === 'bad')).toBe(false);
    expect(findings.filter((f) => f.tone === 'warn').map((f) => f.concept)).toEqual(['Cache stampede']);
    expect(findings.some((f) => f.tone === 'tip')).toBe(false);
  });

  it('ne propose de retirer que ce dont la vague se passe vraiment', () => {
    const tip = analyze(A.withCache, 'launch').find((f) => f.tone === 'tip')!;
    expect(tip.says).toContain('Carnet du scribe');
    expect(tip.says).not.toContain('Archives');
    expect(analyze(A.minimal, 'launch').some((f) => f.tone === 'tip')).toBe(false);
  });

  it('raconte l’incident : un serveur unique qui tombe est un SPOF, la redondance l’encaisse', () => {
    const spof = analyze(A.withCdn(), 'marketing-peak').find((f) => f.concept === 'Redondance, SPOF')!;
    expect(spof.tone).toBe('warn');
    const redundant = analyze(A.scaled(3), 'marketing-peak').find((f) => f.concept === 'Redondance, SPOF')!;
    expect(redundant.tone).toBe('good');
  });
});
