import type { FailureReason, NodeTick, SimEvent } from './types.ts';

/** Ce que le rendu doit montrer et que les échecs confondent, par nœud et par tick. */
export interface Tally {
  duplicates: number;
  deduplicated: number;
  lost: number;
  stale: number;
  /** Messages de file que ce nœud n'a pas pu traiter, rendus à leur file sans échec (M1). */
  deferred: number;
  /** File : messages que l'aval lui a rendus ce tick. */
  requeued: number;
}

/** Les compteurs d'un tick : ce que les nœuds font échouer, écartent et signalent. */
export interface Ledger {
  tick: number;
  failures: Record<FailureReason, number>;
  nodeFailed: Map<string, number>;
  /** Trafic abusif écarté par nœud pendant le tick : voulu, donc hors échecs. */
  nodeShed: Map<string, number>;
  /** Ce que le rendu doit montrer et que les échecs confondent : doublons reçus, événements perdus. */
  nodeTally: Map<string, Tally>;
  events: SimEvent[];
  shed: { value: number };
  /** Cumul de la vague : événements async en échec, et copies arrivées au bout de leur chemin. */
  asyncTally: { failed: number; delivered: number };
}

export function noFailures(): Record<FailureReason, number> {
  return {
    saturation: 0,
    'no-route': 0,
    'rate-limited': 0,
    'queue-overflow': 0,
    'lost-at-edge': 0,
    duplicate: 0,
    'lost-event': 0,
    undelivered: 0,
    'circuit-open': 0,
    'stale-read': 0,
  };
}

export function sumFailures(f: Record<FailureReason, number>): number {
  return Object.values(f).reduce((a, x) => a + x, 0);
}

/** `events` : la part de ces échecs qui sont des événements async, pour compter ce qui reste à livrer. */
export function fail(ctx: Ledger, nodeId: string, reason: FailureReason, rps: number, events = 0): void {
  if (rps <= 0) return;
  ctx.failures[reason] += rps;
  ctx.nodeFailed.set(nodeId, (ctx.nodeFailed.get(nodeId) ?? 0) + rps);
  ctx.asyncTally.failed += events;
}

export function tally(ctx: Ledger, nodeId: string, key: keyof Tally, rps: number): void {
  const t = ctx.nodeTally.get(nodeId) ?? { duplicates: 0, deduplicated: 0, lost: 0, stale: 0, deferred: 0, requeued: 0 };
  t[key] += rps;
  ctx.nodeTally.set(nodeId, t);
}

export function nonZero(t: Tally | undefined): Partial<NodeTick> {
  if (!t) return {};
  return Object.fromEntries(Object.entries(t).filter(([, v]) => v > 0));
}
