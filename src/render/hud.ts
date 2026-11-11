import type { SimEvent, WaveResult } from '../engine/types.ts';
import type { Outcome } from './traffic.ts';

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

export function replayStats(result: WaveResult, outcomes: Outcome[], time: number): ReplayStats {
  const done = result.ticks.slice(0, Math.min(Math.floor(time) + 1, result.ticks.length));
  const last = done.at(-1);
  const counted = last?.countedSoFar ?? 0;
  const count = (r: Outcome['result']) => outcomes.filter((o) => o.result === r && o.at <= time).length;
  return {
    failureRate: counted > 0 ? last!.clientFailedSoFar / counted : 0,
    latencyMs: last?.slaLatencyMs ?? 0,
    served: count('served'),
    refused: count('refused'),
    repelled: count('repelled'),
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
