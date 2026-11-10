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
  let offered = 0;
  let failed = 0;
  for (const t of done) {
    const shed = Object.values(t.nodes).reduce((a, n) => a + (n.shed ?? 0), 0);
    // Une relance rejoue un échec que le client n'a pas vu : elle compte à sa place (S19),
    // comme dans le verdict du moteur.
    offered += t.offered - shed - (t.retries ?? 0);
    failed += t.failed - (t.retries ?? 0);
  }
  const count = (r: Outcome['result']) => outcomes.filter((o) => o.result === r && o.at <= time).length;
  return {
    failureRate: offered > 0 ? failed / offered : 0,
    latencyMs: done.at(-1)?.slaLatencyMs ?? 0,
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

/**
 * Le tick où la vague est perdue sur la latence, sans attendre sa fin. Le SLA porte sur le
 * p95 des ticks par rang le plus proche (sur 60 ticks, les 3 pires sont écartés) : dès qu'un
 * tick lent de plus que cette marge est passé, le p95 final dépassera forcément la limite.
 */
export function latencyBreachTick(result: WaveResult, maxP95LatencyMs: number): number | undefined {
  const n = result.ticks.length;
  const tolerated = n - Math.max(1, Math.ceil(0.95 * n));
  let slow = 0;
  for (let i = 0; i < n; i++) {
    if (result.ticks[i]!.slaLatencyMs > maxP95LatencyMs && ++slow > tolerated) return i;
  }
  return undefined;
}
