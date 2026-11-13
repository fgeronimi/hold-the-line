import { describe, expect, it } from 'vitest';
import { enumerate, maxedChoice } from '../src/balance/canonical.ts';
import { answersOf, balanceSpaces } from '../src/data/balance-space.ts';
import { catalog } from '../src/data/catalog.ts';
import { lossMessage, lossMessages } from '../src/engine/messages.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import type { Architecture, RequestKind, Wave, WaveResult } from '../src/engine/types.ts';

/**
 * Pour chaque vague des quatre scénarios : ses réponses attendues, l'architecture la plus
 * nue, la plus chargée, et un échantillon régulier de l'espace d'équilibrage.
 */
function cases(): { label: string; wave: Wave; arch: Architecture }[] {
  const out: { label: string; wave: Wave; arch: Architecture }[] = [];
  for (const { scenario, space } of balanceSpaces) {
    const all = [...enumerate(space)];
    const step = Math.max(1, Math.floor(all.length / 12));
    const sample = all.filter((_, i) => i % step === 0).map((c) => c.arch);
    scenario.waves.forEach((wave, w) => {
      const label = `${scenario.id}/${wave.id}`;
      for (const arch of answersOf(scenario.id, w)) out.push({ label: `${label} réponse`, wave, arch });
      for (const arch of [all[0]!.arch, space.build(maxedChoice(space)), ...sample]) out.push({ label, wave, arch });
    });
  }
  return out;
}

const played = cases().map((c) => ({ ...c, r: simulateWave(c.arch, c.wave, catalog) }));

const sum = (r: WaveResult, f: (t: WaveResult['ticks'][number]) => number) => r.ticks.reduce((a, t) => a + f(t), 0);

describe('une seule définition du SLA, publiée par le moteur', () => {
  it('couvre des vagues gagnées et perdues, sur l’échec comme sur la latence', () => {
    expect(played.some((p) => p.r.won)).toBe(true);
    expect(played.some((p) => p.r.gauges.failureRate.value > p.r.gauges.failureRate.limit)).toBe(true);
    expect(played.some((p) => p.r.latencyBreachTick !== undefined)).toBe(true);
    expect(played.some((p) => sum(p.r, (t) => t.retries ?? 0) > 0)).toBe(true);
  });

  it('en fin de vague, les échecs vus du client sur les requêtes comptées donnent le taux du verdict', () => {
    for (const { label, r } of played) {
      const last = r.ticks.at(-1);
      const counted = last?.countedSoFar ?? 0;
      const rate = counted > 0 ? last!.clientFailedSoFar / counted : 0;
      expect(rate, label).toBeCloseTo(r.gauges.failureRate.value, 9);
    }
  });

  it('chaque tick cumule son trafic, écarté et relances injectées déduits', () => {
    for (const { label, wave, r } of played) {
      let counted = 0;
      let failed = 0;
      // Avec n services à livrer, une copie d'événement perdue ne pèse que 1 / n (B9) : le
      // cumul du SLA reste entre les échecs en messages divisés par n et ces échecs entiers.
      const fanOut = Math.max(1, wave.consumers?.length ?? 0);
      for (const t of r.ticks) {
        const shed = Object.values(t.nodes).reduce((a, n) => a + (n.shed ?? 0), 0);
        counted += t.offered - shed - (t.retries ?? 0);
        failed += t.failed - (t.retries ?? 0);
        expect(t.countedSoFar, label).toBe(counted);
        if (fanOut === 1) expect(t.clientFailedSoFar, label).toBeCloseTo(failed, 6);
        else {
          expect(t.clientFailedSoFar, label).toBeLessThanOrEqual(failed + 1e-6);
          expect(t.clientFailedSoFar, label).toBeGreaterThanOrEqual(failed / fanOut - 1e-6);
        }
      }
    }
  });

  it('le tick de rupture existe si et seulement si la jauge de latence dépasse sa limite', () => {
    for (const { label, wave, r } of played) {
      const { value, limit } = r.gauges.latency;
      expect(r.latencyBreachTick !== undefined, label).toBe(value > limit);
      // Pour chaque objectif (le général, puis ceux propres à un type), le premier tick où ses
      // réponses lentes cumulées dépassent 5 % de ses réponses sur la vague (M4).
      const views: ((t: WaveResult['ticks'][number]) => { answered: number; slow: number })[] = [
        (t) => ({ answered: t.answeredRps, slow: t.slowRps }),
        ...Object.keys(wave.sla.maxP95LatencyMsByKind ?? {}).map((k) => (t: WaveResult['ticks'][number]) => {
          const x = t.latencyByKind![k as RequestKind]!;
          return { answered: x.answeredRps, slow: x.slowRps };
        }),
      ];
      const sealed = views.flatMap((view) => {
        const total = r.ticks.reduce((a, t) => a + view(t).answered, 0);
        let slow = 0;
        const at = r.ticks.findIndex((t) => (slow += view(t).slow) > 0.05 * total * (1 + 1e-9));
        return at >= 0 ? [at] : [];
      });
      if (r.latencyBreachTick === undefined) expect(sealed, label).toEqual([]);
      else expect(r.latencyBreachTick, label).toBe(Math.min(...sealed));
    }
  });

  it('une architecture invalide ne publie pas de tick de rupture', () => {
    const wave = balanceSpaces[0]!.scenario.waves[0]!;
    const r = simulateWave({ nodes: [], links: [] }, wave, catalog);
    expect(r.won).toBe(false);
    expect(r.latencyBreachTick).toBeUndefined();
  });
});

describe('raisons de défaite typées', () => {
  it('une raison par jauge dépassée, avec ses nombres, et la vague gagnée sans aucune', () => {
    for (const { label, r } of played) {
      const g = r.gauges;
      const kinds = r.losses.map((l) => l.kind);
      expect(kinds.filter((k) => k !== 'latency'), label).toEqual(
        [
          g.cost.value > g.cost.limit && 'budget',
          g.complexity.value > g.complexity.limit && 'complexity',
          g.failureRate.value > g.failureRate.limit && 'failure-rate',
        ].filter(Boolean),
      );
      // Une raison par objectif de latence dépassé (M4) ; la jauge retient le plus serré.
      expect(kinds.includes('latency'), label).toBe(g.latency.value > g.latency.limit);
      expect(r.won, label).toBe(r.losses.length === 0);
      for (const l of r.losses) {
        if (l.kind === 'budget') expect(l, label).toEqual({ kind: 'budget', cost: g.cost.value, limit: g.cost.limit, autoscaling: r.bill.autoscaling });
        if (l.kind === 'latency' && l.requestKind) {
          const own = r.latencyByKind![l.requestKind]!;
          expect(l, label).toEqual({ kind: 'latency', p95Ms: own.value, limitMs: own.limit, requestKind: l.requestKind });
        }
        if (l.kind === 'latency') expect(l.p95Ms, label).toBeGreaterThan(l.limitMs);
        if (l.kind === 'failure-rate') expect(l, label).toEqual({ kind: 'failure-rate', value: g.failureRate.value, limit: g.failureRate.limit });
      }
    }
  });

  it('les phrases de `lossReasons` sont celles des raisons typées, une pour une', () => {
    for (const { label, r } of played) expect(r.lossReasons, label).toEqual(lossMessages(r.losses));
  });

  it('met en forme chaque raison', () => {
    expect(lossMessage({ kind: 'budget', cost: 195, limit: 170, autoscaling: 0 })).toBe('Budget dépassé : 195 / 170');
    expect(lossMessage({ kind: 'budget', cost: 180.25, limit: 170, autoscaling: 10.25 })).toBe('Budget dépassé : 180.3 / 170, dont 10.3 d\'autoscaling');
    expect(lossMessage({ kind: 'complexity', value: 5, limit: 4 })).toBe('Trop complexe : 5 / 4 points');
    expect(lossMessage({ kind: 'failure-rate', value: 0.0234, limit: 0.01 })).toBe('SLA rompu : 2.34 % d\'échecs (max 1.00 %)');
    expect(lossMessage({ kind: 'latency', p95Ms: 312.5, limitMs: 200 })).toBe('SLA rompu : latence p95 312.5 ms (max 200 ms)');
    expect(lossMessage({ kind: 'latency', p95Ms: 4200, limitMs: 500, requestKind: 'async' })).toBe('SLA rompu : latence p95 des événements 4200 ms (max 500 ms)');
  });

  it('une architecture invalide dit pourquoi, erreur par erreur', () => {
    const wave = balanceSpaces[0]!.scenario.waves[0]!;
    const r = simulateWave({ nodes: [], links: [] }, wave, catalog);
    expect(r.losses.length).toBeGreaterThan(0);
    expect(r.losses.every((l) => l.kind === 'invalid')).toBe(true);
    expect(r.lossReasons[0]).toMatch(/^Architecture invalide : /);
  });
});
