import type { SimEvent, WaveResult } from '../engine/types.ts';
import { OutcomeTally, type Outcome } from './traffic.ts';

/** Ce que le tableau de bord du rejeu affiche à l'instant `time`. */
export interface ReplayStats {
  /** Taux d'échec cumulé depuis le début de la vague, trafic abusif écarté exclu. */
  failureRate: number;
  /** Latence moyenne du tick courant. */
  latencyMs: number;
  served: number;
  refused: number;
  repelled: number;
}

/**
 * Les issues peuvent venir en tableau (tests, appels ponctuels) ou déjà cumulées par
 * `OutcomeTally` : le rejeu en construit une pour toute la vague et la relit à chaque image.
 */
export function replayStats(result: WaveResult, outcomes: Outcome[] | OutcomeTally, time: number): ReplayStats {
  const tally = outcomes instanceof OutcomeTally ? outcomes : new OutcomeTally(outcomes);
  const shown = Math.min(Math.floor(time) + 1, result.ticks.length);
  const last = shown > 0 ? result.ticks[shown - 1] : undefined;
  const counted = last?.countedSoFar ?? 0;
  return {
    failureRate: counted > 0 ? last!.clientFailedSoFar / counted : 0,
    latencyMs: last?.slaLatencyMs ?? 0,
    served: tally.count('served', time),
    refused: tally.count('refused', time),
    repelled: tally.count('repelled', time),
  };
}

/** Le premier moment où chaque bâtiment sature : les alertes du rejeu, dans l'ordre. */
export function firstSaturations(events: SimEvent[]): { node: string; tick: number }[] {
  const seen = new Set<string>();
  const out: { node: string; tick: number }[] = [];
  for (const e of events) {
    if (e.type === 'saturation-start' && !seen.has(e.node)) {
      seen.add(e.node);
      out.push({ node: e.node, tick: e.tick });
    }
  }
  return out.sort((a, b) => a.tick - b.tick);
}
