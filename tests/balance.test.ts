import { beforeAll, describe, expect, it, vi } from 'vitest';
import { enumerate, reductions, strategyName, strategyParts, type BalanceSpace, type Choice } from '../src/balance/canonical.ts';
import { runMassSim, type MassSimReport } from '../src/balance/mass-sim.ts';
import { formatScenarioReport } from '../src/balance/report.ts';
import { answersOf, balanceSpaces, marketSpace, resilienceSpace, shortenerSpace, tournamentSpace } from '../src/data/balance-space.ts';
import { catalog } from '../src/data/catalog.ts';
import { market } from '../src/data/scenarios/market.ts';
import { resilience } from '../src/data/scenarios/resilience.ts';
import { tournament } from '../src/data/scenarios/tournament.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import { validateArchitecture } from '../src/engine/validate.ts';

// Ces tests énumèrent des milliers d'architectures : une seconde ici en vaut quatre sur la
// machine de CI, bien au-delà des délais par défaut de Vitest (5 s par test, 30 s par hook).
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

/** Le même espace avec d'autres bornes. */
const narrowed = (space: BalanceSpace, levels: Record<string, number[]>): BalanceSpace => ({
  ...space,
  dimensions: space.dimensions.map((d) => (levels[d.id] ? { ...d, levels: levels[d.id]! } : d)),
});

/**
 * Espace réduit mais qui contient toutes les réponses attendues du raccourcisseur :
 * l'espace complet (`npm run balance`) prend une trentaine de secondes.
 */
const shortener = narrowed(shortenerSpace, {
  scaling: [0, 1, 2, 3, 4],
  replicas: [0, 1],
  workers: [0],
  autoscaling: [0, 3],
  partnerQuota: [0, 5],
  anonymousQuota: [0, 1],
});

const base: Choice = { cdn: 0, lb: 1, scaling: 3, autoscaling: 0, rateLimit: 0, gateway: 0, partnerQuota: 0, anonymousQuota: 0, cache: 1, replicas: 0, queue: 0, workers: 0 };

describe('enumerate', () => {
  const candidates = [...enumerate(shortener)];

  it('couvre tout l’espace canonique', () => {
    // Sans LB : CDN × cache × réplicas × file.
    const withoutLb = 2 * 2 * 2 * 2;
    // Avec LB : en plus, autoscaling × instances × (5 paliers de limite unique, ou sans elle :
    // pas de passerelle, ou une passerelle et ses 2 × 2 limites par classe).
    const withLb = withoutLb * 2 * 5 * (5 + 1 + 2 * 2);
    expect(candidates).toHaveLength(withoutLb + withLb);
  });

  it('ne produit que des architectures valides, dans chaque scénario', () => {
    for (const space of [shortener, marketSpace, resilienceSpace, tournamentSpace]) {
      const invalid = [...enumerate(space)].filter((c) => !validateArchitecture(c.arch, catalog).ok);
      expect(invalid.map((c) => c.strategy)).toEqual([]);
    }
  });

  it('nomme une stratégie par ses composants, niveaux ignorés', () => {
    expect(strategyName(strategyParts(shortener, base))).toBe('load balancer + scaling + cache');
    expect(strategyName(strategyParts(shortener, { ...base, scaling: 7 }))).toBe('load balancer + scaling + cache');
    expect(strategyName([])).toBe('serveur + base');
  });

  it('nomme chaque variante d’une dimension à plusieurs façons de faire', () => {
    const delivery = (d: number) => strategyName(strategyParts(marketSpace, { delivery: d }));
    expect([1, 2, 3, 4, 5].map(delivery)).toEqual(['e-mail en direct', 'file', 'file partagée', 'pub/sub', 'pub/sub sans files']);
  });

  it('retirer le load balancer retire ce qui en dépend', () => {
    const withLimit = { ...base, rateLimit: 2, autoscaling: 3 };
    expect(reductions(shortener, withLimit)).toContainEqual({ ...withLimit, lb: 0, scaling: 0, autoscaling: 0, rateLimit: 0 });
  });

  it('la passerelle d’API ne s’essaie que devant un load balancer sans limite unique (C7)', () => {
    expect(candidates.some((c) => (c.choice.gateway ?? 0) > 0 && (c.choice.rateLimit ?? 0) > 0)).toBe(false);
    expect(candidates.some((c) => (c.choice.gateway ?? 0) > 0 && (c.choice.lb ?? 0) === 0)).toBe(false);
    const gated = { ...base, gateway: 1, partnerQuota: 5, anonymousQuota: 1 };
    expect(reductions(shortener, gated)).toContainEqual({ ...gated, gateway: 0, partnerQuota: 0, anonymousQuota: 0 });
  });

  it('un simple réglage, sans nom, n’est pas un élément à retirer', () => {
    const queued = { ...base, queue: 1, workers: 2 };
    expect(reductions(shortener, queued).some((r) => r.queue === 1 && r.workers === 0)).toBe(false);
  });
});

describe('runMassSim sur le raccourcisseur', () => {
  let report: MassSimReport;
  const wave = (id: string) => report.waves.find((w) => w.waveId === id)!;

  beforeAll(() => {
    report = runMassSim(urlShortener, catalog, shortener);
  });

  it('aucune architecture ne gagne toutes les vagues', () => {
    expect(report.universalWinners).toEqual([]);
  });

  it('tient le critère des deux stratégies sur la majorité des vagues', () => {
    expect(report.majorityHasTwoStrategies).toBe(true);
    expect(report.waves.every((w) => w.meetsStrategyCriterion)).toBe(true);
  });

  it('vague 2 : cache, réplica, ou CDN depuis son prix revu (M9a)', () => {
    expect([...wave('read-surge').strategies].sort()).toEqual(['CDN', 'cache', 'réplica']);
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

  it('vague 4 : le rate limiting est dans toutes les stratégies, la passerelle dans aucune', () => {
    expect(wave('noisy-client').strategies.every((s) => s.includes('rate limiting') && !s.includes('passerelle'))).toBe(true);
  });

  it('vague 5 : des limites par classe dans toutes les stratégies, la limite unique dans aucune (C7)', () => {
    const strategies = wave('partner-keys').strategies;
    expect(strategies.length).toBeGreaterThanOrEqual(2);
    expect(strategies.every((s) => s.includes('passerelle d’API') && s.includes('quota par clé') && s.includes('limite par adresse'))).toBe(true);
    expect(strategies.some((s) => s.includes('rate limiting'))).toBe(false);
  });

  it('l’architecture au maximum de tout perd chaque vague par le coût ou la complexité', () => {
    expect(report.overprovisioned.filter((o) => !o.losesOnBudget)).toEqual([]);
  });

  it('marque comme dominée une réponse connue alourdie d’un composant inutile', () => {
    expect(wave('launch').groups.find((g) => g.strategy === 'load balancer')?.dominatedBy).toBe('serveur + base');
  });
});

describe.each([
  ['le grand marché', market, marketSpace],
  ['le comptoir des paiements', resilience, resilienceSpace],
  ['la billetterie du tournoi', tournament, tournamentSpace],
] as const)('runMassSim sur %s', (_, scenario, space) => {
  const report = runMassSim(scenario, catalog, space);

  it('chaque vague tient son critère de stratégies, aucune architecture ne gagne partout', () => {
    expect(report.waves.filter((w) => !w.meetsStrategyCriterion).map((w) => [w.waveId, w.strategies])).toEqual([]);
    expect(report.universalWinners).toEqual([]);
  });

  it('l’architecture au maximum de tout perd chaque vague par le coût ou la complexité', () => {
    expect(report.overprovisioned.filter((o) => !o.losesOnBudget)).toEqual([]);
  });
});

describe('ce que la simulation en masse a trouvé', () => {
  it('soldes : des services abonnés au pub/sub sans file ne gagnent plus, noyés dans les lectures (S17)', () => {
    const sales = runMassSim({ ...market, waves: market.waves.filter((w) => w.id === 'sales') }, catalog, marketSpace).waves[0]!;
    expect(sales.groups.some((g) => g.strategy.includes('pub/sub sans files'))).toBe(false);
  });
});

describe('les réponses attendues (Wave.answers)', () => {
  it('sont des architectures valides, sur des dimensions de l’espace', () => {
    for (const { scenario, space } of balanceSpaces) {
      const ids = new Set(space.dimensions.map((d) => d.id));
      scenario.waves.forEach((w, i) => {
        for (const choice of w.answers ?? []) {
          expect(Object.keys(choice).filter((k) => !ids.has(k)), `${scenario.id}/${w.id}`).toEqual([]);
        }
        for (const arch of answersOf(scenario.id, i)) {
          expect(validateArchitecture(arch, catalog).ok, `${scenario.id}/${w.id}`).toBe(true);
        }
      });
    }
  });

  it('la moins chère de chaque vague tient sous le seuil de l’étoile d’économie', () => {
    for (const { scenario } of balanceSpaces) {
      scenario.waves.forEach((w, i) => {
        if (w.thriftyCost === undefined) return;
        const costs = answersOf(scenario.id, i).map((arch) => simulateWave(arch, w, catalog).gauges.cost.value);
        expect(Math.min(...costs), `${scenario.id}/${w.id}`).toBeLessThanOrEqual(w.thriftyCost);
      });
    }
  });
});
