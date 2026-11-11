import { beforeAll, describe, expect, it } from 'vitest';
import { enumerate, reductions, strategyName, strategyParts, type BalanceSpace, type Choice } from '../src/balance/canonical.ts';
import { runMassSim, type MassSimReport } from '../src/balance/mass-sim.ts';
import { formatScenarioReport } from '../src/balance/report.ts';
import { answersOf, balanceSpaces, marketSpace, resilienceSpace, shortenerSpace, tournamentSpace } from '../src/data/balance-space.ts';
import { catalog } from '../src/data/catalog.ts';
import { market } from '../src/data/scenarios/market.ts';
import { resilience } from '../src/data/scenarios/resilience.ts';
import { tournament } from '../src/data/scenarios/tournament.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { scoring } from '../src/data/scoring.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import { validateArchitecture } from '../src/engine/validate.ts';

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
});

const base: Choice = { cdn: 0, lb: 1, scaling: 3, autoscaling: 0, rateLimit: 0, cache: 1, replicas: 0, queue: 0, workers: 0 };

describe('enumerate', () => {
  const candidates = [...enumerate(shortener)];

  it('couvre tout l’espace canonique', () => {
    // Sans LB : CDN × cache × réplicas × file.
    const withoutLb = 2 * 2 * 2 * 2;
    // Avec LB : en plus, autoscaling × instances × paliers.
    const withLb = withoutLb * 2 * 5 * 6;
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

  it('un simple réglage, sans nom, n’est pas un élément à retirer', () => {
    const queued = { ...base, queue: 1, workers: 2 };
    expect(reductions(shortener, queued).some((r) => r.queue === 1 && r.workers === 0)).toBe(false);
  });
});

describe('runMassSim sur le raccourcisseur', () => {
  let report: MassSimReport;
  const wave = (id: string) => report.waves.find((w) => w.waveId === id)!;

  beforeAll(() => {
    report = runMassSim(urlShortener, catalog, shortener, scoring);
  }, 30_000);

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

  it('vague 4 : le rate limiting est dans toutes les stratégies', () => {
    expect(wave('noisy-client').strategies.every((s) => s.includes('rate limiting'))).toBe(true);
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
  const report = runMassSim(scenario, catalog, space, scoring);

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
    const sales = runMassSim({ ...market, waves: market.waves.filter((w) => w.id === 'sales') }, catalog, marketSpace, scoring).waves[0]!;
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

describe('le contrôle d’enchaînement', () => {
  // Les deux dernières vagues du tournoi dans un espace réduit, qui contient leurs réponses.
  const small = narrowed(tournamentSpace, { scaling: [0, 1, 3], retention: [0], replicas: [0, 1, 2] });
  const lastTwo = (finalBudget: number): typeof tournament => ({
    ...tournament,
    waves: tournament.waves.slice(2).map((w) => (w.id === 'final-joust' ? { ...w, budget: finalBudget } : w)),
  });

  it('trouve une gagnante depuis chaque réponse de la vague précédente', () => {
    const { chaining } = runMassSim(lastTwo(250), catalog, small, scoring);
    expect(chaining).toHaveLength(1);
    expect(chaining[0]!.starts.map((s) => s.winners > 0)).toEqual([true, true]);
    const cheapest = chaining[0]!.starts[0]!.cheapest!;
    expect(cheapest.cost).toBeLessThanOrEqual(250);
    expect(cheapest.migration).toBeGreaterThan(0);
  });

  it('signale un blocage : aucune réponse de la vague 3 ne mène à gagner la vague 4 à 235 de budget', () => {
    const report = runMassSim(lastTwo(235), catalog, small, scoring);
    expect(report.chaining[0]!.starts.map((s) => s.winners)).toEqual([0, 0]);
    // Elle reste gagnable isolément : c'est ce que l'énumération seule ne voyait pas.
    expect(report.waves[1]!.groups.length).toBeGreaterThan(0);
    const { lines, ko } = formatScenarioReport(lastTwo(235), small, report);
    expect(lines.filter((l) => l.startsWith('[KO] Blocage final-joust'))).toHaveLength(2);
    expect(ko).toBe(1);
  });

  it('une impasse (un seul départ sans gagnante) est listée sans KO', () => {
        const scenario = lastTwo(250);
    const report = runMassSim(scenario, catalog, small, scoring);
    const [first, second] = report.chaining[0]!.starts;
    // Mise en forme seule : le départ 1 est rapporté sans gagnante, le départ 2 en garde.
    const impasse = { ...report, chaining: [{ ...report.chaining[0]!, starts: [{ answerIndex: 0, winners: 0 }, second!] }] };
    expect(first!.winners).toBeGreaterThan(0);
    const { lines, ko } = formatScenarioReport(scenario, small, impasse);
    expect(lines.some((l) => l.startsWith('[impasse] final-joust, depuis la réponse 1') && l.includes('E6'))).toBe(true);
    expect(lines.some((l) => l.includes('Blocage'))).toBe(false);
    expect(ko).toBe(formatScenarioReport(scenario, small, report).ko);
  });

  it('ne rejoue pas les vagues sans réponse déclarée en amont', () => {
    const noAnswers = { ...tournament, waves: lastTwo(250).waves.map(({ answers: _, ...w }) => w) };
    expect(runMassSim(noAnswers, catalog, small, scoring).chaining).toEqual([]);
  });
});
