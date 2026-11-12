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
  it('un service métier appelé en direct : le client attend son travail, la file est la parade', async () => {
    const { market } = await import('../src/data/scenarios/market.ts');
    const M = await import('../src/data/scenarios/market.archetypes.ts');
    const first = market.waves[0]!;
    const findings = analyzeWave(simulateWave(M.inline, first, catalog), M.inline, first, catalog, fortifiedCity);
    const finding = findings.find((f) => f.concept === 'Traitement asynchrone')!;
    expect(finding).toMatchObject({ tone: 'bad', node: 'mail' });
    expect(finding.tech).toContain('200 ms');
  });

  it('raconte le message empoisonné : la file bloquée sans parade, les lettres mises de côté avec (S25)', async () => {
    const { market } = await import('../src/data/scenarios/market.ts');
    const M = await import('../src/data/scenarios/market.archetypes.ts');
    const poison = market.waves.find((w) => w.id === 'poison-order')!;
    const tellOf = (arch: Architecture) => analyzeWave(simulateWave(arch, poison, catalog), arch, poison, catalog, fortifiedCity);
    const concept = 'Message empoisonné, file des lettres mortes';

    const blocked = tellOf(M.fannedOut());
    expect(blocked.find((f) => f.concept === concept)).toMatchObject({ tone: 'bad' });
    expect(blocked.find((f) => f.concept === concept)!.remedy).toContain('file des lettres mortes');
    // Ce qui manque aux services vient du message empoisonné, pas d'un abonnement oublié.
    expect(blocked.some((f) => f.concept === 'Pub/sub' && f.tone === 'bad')).toBe(false);

    const held = tellOf(M.fannedOut({ deadLetter: true }));
    const told = held.find((f) => f.concept === concept)!;
    expect(told.tone).toBe('warn');
    expect(told.says).toMatch(/\d+ plis attendent/);
    expect(told.signal).toContain('Taille de la file des lettres mortes');
    expect(held.find((f) => f.concept === 'Compromis des parades')?.tech).toContain('lettres mortes');
  });

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
    const [opening] = analyze(A.scaled(4, { rateLimitTier: A.TIER_40 }), 'noisy-client');
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
    // Rien à alléger : le seul conseil d'over-engineering serait faux ici.
    expect(findings.some((f) => f.concept === 'Over-engineering')).toBe(false);
  });

  it('ne propose de retirer que ce dont la vague se passe vraiment', () => {
    const tip = analyze(A.withCache, 'launch').find((f) => f.concept === 'Over-engineering' && f.tone === 'tip')!;
    expect(tip.says).toContain('Carnet du scribe');
    expect(tip.says).not.toContain('Archives');
    expect(analyze(A.minimal, 'launch').some((f) => f.concept === 'Over-engineering')).toBe(false);
  });

  it('raconte l’incident : un serveur unique qui tombe est un SPOF, la redondance l’encaisse', () => {
    const spof = analyze(A.withCdn(), 'marketing-peak').find((f) => f.concept === 'Redondance, SPOF')!;
    expect(spof.tone).toBe('warn');
    const redundant = analyze(A.scaled(3), 'marketing-peak').find((f) => f.concept === 'Redondance, SPOF')!;
    expect(redundant.tone).toBe('good');
  });
});

describe('le debrief ne connaît la métaphore que par le thème', () => {
  // Les mots de la cité fortifiée : aucun ne doit venir du code du debrief.
  const CITY_WORDS = /(?<![a-zà-ÿ])(?:Sire|cité|scribe|archives|relais de poste|voyageur|pillard|la garde|atelier|grand livre|corps de métier)/i;

  it('avec un autre thème, ouverture, alertes et allègements ne disent aucun mot de la cité', async () => {
    const { SCENARIOS } = await import('../src/data/scenarios/index.ts');
    const { answersFor } = await import('../src/ui/hints.ts');
    const lines = Object.fromEntries(Object.keys(fortifiedCity.debrief).map((k) => [k, `[${k}] {name}{names}{share}{count}{story}{title}`]));
    const buildings = Object.fromEntries(Object.entries(fortifiedCity.buildings).map(([k, b]) => [k, { ...b, metaphor: `M-${k}` }]));
    const other = { ...fortifiedCity, id: 'test', debrief: lines as typeof fortifiedCity.debrief, buildings };
    let told = 0;
    for (const { scenario } of SCENARIOS) {
      scenario.waves.forEach((w, i) => {
        // Les services déjà en place ont leur propre nom : on le neutralise aussi.
        const arch = structuredClone(answersFor(scenario, i)[0]!);
        for (const n of arch.nodes) if (n.fixed) n.fixed = { tech: n.fixed.tech, metaphor: `M-${n.id}` };
        const findings = analyzeWave(simulateWave(arch, w, catalog), arch, w, catalog, other);
        const own = findings.filter((f, k) => k === 0 || f.tone === 'tip' || (f.tone === 'warn' && !f.concept));
        for (const f of own) {
          expect(f.says, `${scenario.id}/${w.id}`).not.toMatch(CITY_WORDS);
          told++;
        }
      });
    }
    expect(told).toBeGreaterThan(10);
  });

  it('le code du debrief n’écrit aucun mot de la cité ni aucun identifiant d’évolution', async () => {
    const { default: source } = await import('../src/ui/debrief.ts?raw');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(CITY_WORDS);
    expect(code).not.toMatch(/'read-replica'|upgrades\?\.\w|upgrades\?\.\[/);
  });

  it('dit ce qui aurait prévenu, ce qu’ont coûté les parades, et pose le calcul de capacité (D1)', () => {
    // Une base saturée : la leçon dit quelle métrique l'aurait annoncé.
    expect(analyze(A.minimal, 'read-surge').some((f) => f.signal?.includes('Charge du primaire'))).toBe(true);
    const findings = analyze(A.scaled(3, { rateLimitTier: A.TIER_40 }), 'noisy-client');
    const costs = findings.find((f) => f.concept === 'Compromis des parades');
    expect(costs?.tech).toContain('limite par client');
    const sizing = findings.find((f) => f.concept === 'Calcul de capacité');
    expect(sizing?.tech).toMatch(/unités de travail par seconde/);
    expect(sizing?.tech).toMatch(/⌈.*⌉ = \d+ instance/);
  });
});

