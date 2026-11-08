import { beforeAll, describe, expect, it } from 'vitest';
import {
  enumerate,
  reductions,
  strategyName,
  strategyParts,
  type CanonicalChoice,
  type SearchSpace,
} from '../src/balance/canonical.ts';
import { runMassSim, type MassSimReport } from '../src/balance/mass-sim.ts';
import { catalog } from '../src/data/catalog.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { scoring } from '../src/data/scoring.ts';
import { validateArchitecture } from '../src/engine/validate.ts';

/**
 * Espace réduit mais qui contient toutes les réponses attendues du raccourcisseur :
 * l'espace complet (`npm run balance`) prend une trentaine de secondes.
 */
const space: SearchSpace = {
  maxExtraInstances: 4,
  maxReplicas: 1,
  rateLimitTiers: 5,
  maxExtraWorkers: 0,
  autoscalingLevels: [0, 3],
};

const base: CanonicalChoice = {
  cdn: false,
  loadBalancer: true,
  autoscaling: 0,
  extraInstances: 3,
  rateLimitTier: 0,
  cache: true,
  replicas: 0,
  queue: false,
  extraWorkers: 0,
};

describe('enumerate', () => {
  const candidates = [...enumerate(space)];

  it('couvre tout l’espace canonique', () => {
    // Sans LB : CDN × cache × réplicas × file.
    const withoutLb = 2 * 2 * 2 * 2;
    // Avec LB : en plus, autoscaling × instances × paliers.
    const withLb = withoutLb * 2 * 5 * 6;
    expect(candidates).toHaveLength(withoutLb + withLb);
  });

  it('ne produit que des architectures valides', () => {
    const invalid = candidates.filter((c) => !validateArchitecture(c.arch, catalog).ok);
    expect(invalid).toEqual([]);
  });

  it('nomme une stratégie par ses composants, niveaux ignorés', () => {
    expect(strategyName(strategyParts(base))).toBe('load balancer + scaling + cache');
    expect(strategyName(strategyParts({ ...base, extraInstances: 7 }))).toBe('load balancer + scaling + cache');
    expect(strategyName([])).toBe('serveur + base');
  });

  it('retirer le load balancer retire ce qui en dépend', () => {
    const withLimit = { ...base, rateLimitTier: 2, autoscaling: 3 };
    expect(reductions(withLimit)).toContainEqual({
      ...withLimit,
      loadBalancer: false,
      extraInstances: 0,
      autoscaling: 0,
      rateLimitTier: 0,
    });
  });
});

describe('runMassSim sur le raccourcisseur', () => {
  let report: MassSimReport;
  const wave = (id: string) => report.waves.find((w) => w.waveId === id)!;

  beforeAll(() => {
    report = runMassSim(urlShortener, catalog, space, scoring);
  }, 30_000);

  it('aucune architecture ne gagne toutes les vagues', () => {
    expect(report.universalWinners).toEqual([]);
  });

  it('tient le critère des deux stratégies sur la majorité des vagues', () => {
    expect(report.majorityHasTwoStrategies).toBe(true);
    expect(report.waves.every((w) => w.meetsStrategyCriterion)).toBe(true);
  });

  it('vague 2 : cache ou réplica', () => {
    expect([...wave('read-surge').strategies].sort()).toEqual(['cache', 'réplica']);
  });

  it('vague 3 : CDN, scaling permanent et autoscaling sont des stratégies distinctes', () => {
    expect(wave('marketing-peak').strategies).toEqual(
      expect.arrayContaining([
        'CDN + cache',
        'load balancer + scaling + cache',
        'load balancer + scaling + autoscaling + cache',
      ]),
    );
  });

  it('vague 4 : le rate limiting est dans toutes les stratégies', () => {
    expect(wave('noisy-client').strategies.every((s) => s.includes('rate limiting'))).toBe(true);
  });

  it('marque comme dominée une réponse connue alourdie d’un composant inutile', () => {
    expect(wave('launch').groups.find((g) => g.strategy === 'load balancer')?.dominatedBy).toBe('serveur + base');
  });
});
