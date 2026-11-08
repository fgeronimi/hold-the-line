import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import { firstSaturations, replayStats } from '../src/render/hud.ts';

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
