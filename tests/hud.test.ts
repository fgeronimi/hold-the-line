import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import { firstSaturations, latencyBreachTick, replayStats } from '../src/render/hud.ts';

describe('tableau de bord du rejeu', () => {
  const peak = simulateWave(A.scaled(1), urlShortener.waves[2]!, catalog);

  it('cumule les échecs tick après tick, jusqu’au taux final de la vague', () => {
    expect(replayStats(peak, [], 5).failureRate).toBe(0);
    expect(replayStats(peak, [], 30).failureRate).toBeGreaterThan(0);
    expect(replayStats(peak, [], 60).failureRate).toBeCloseTo(peak.gauges.failureRate.value, 6);
  });

  it('compte les issues déjà arrivées', () => {
    const outcomes = [
      { node: 'src', at: 1, result: 'served' as const },
      { node: 'app', at: 2, result: 'refused' as const },
      { node: 'lb', at: 9, result: 'repelled' as const },
    ];
    expect(replayStats(peak, outcomes, 3)).toMatchObject({ served: 1, refused: 1, repelled: 0 });
  });

  it('donne le premier instant de saturation de chaque bâtiment, dans l’ordre', () => {
    const alerts = firstSaturations(peak.events);
    // La rampe monte à ×2 puis ×3,5 : avec 2 instances, la tour cède au passage à ×3,5.
    expect(alerts[0]).toEqual({ node: 'app', tick: 22 });
    expect(new Set(alerts.map((a) => a.node)).size).toBe(alerts.length);
  });
});

describe('alarme de latence', () => {
  it('sonne au tick où le p95 ne peut plus tenir, et jamais si la vague tient sa latence', async () => {
    const { market } = await import('../src/data/scenarios/market.ts');
    const M = await import('../src/data/scenarios/market.archetypes.ts');
    const wave = market.waves[0]!;
    const inline = simulateWave(M.inline, wave, catalog);
    expect(inline.won).toBe(false);
    const at = latencyBreachTick(inline, wave.sla.maxP95LatencyMs)!;
    // Le 4e tick lent sur 60 : trois sont tolérés par le p95.
    const slowBefore = inline.ticks.slice(0, at + 1).filter((t) => t.avgLatencyMs > wave.sla.maxP95LatencyMs).length;
    expect(slowBefore).toBe(4);
    expect(latencyBreachTick(simulateWave(M.queued, wave, catalog), wave.sla.maxP95LatencyMs)).toBeUndefined();
  });

  it('ne sonne jamais pour une vague que le moteur donne gagnée sur la latence', () => {
    for (const w of urlShortener.waves) {
      const r = simulateWave(A.minimal, w, catalog);
      const breach = latencyBreachTick(r, w.sla.maxP95LatencyMs);
      expect(breach !== undefined).toBe(r.gauges.latency.value > w.sla.maxP95LatencyMs);
    }
  });
});
