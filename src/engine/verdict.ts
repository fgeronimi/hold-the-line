import type { ObjectiveVerdict } from './latency.ts';
import { noFailures } from './ledger.ts';
import { lossMessages } from './messages.ts';
import type { Gauge, LossReason, Wave, WaveResult } from './types.ts';

export function gauge(value: number, limit: number): Gauge {
  return { value, limit, margin: limit > 0 ? (limit - value) / limit : value > 0 ? -Infinity : 0 };
}

/** `latency` : chaque objectif de latence jugé, une raison par objectif dépassé (M4). */
export function lossesFor(g: WaveResult['gauges'], billed: WaveResult['bill'], latency: readonly ObjectiveVerdict[]): LossReason[] {
  const losses: LossReason[] = [];
  if (g.cost.value > g.cost.limit) {
    losses.push({ kind: 'budget', cost: g.cost.value, limit: g.cost.limit, autoscaling: billed.autoscaling, migration: billed.migration });
  }
  if (g.complexity.value > g.complexity.limit) losses.push({ kind: 'complexity', value: g.complexity.value, limit: g.complexity.limit });
  if (g.failureRate.value > g.failureRate.limit) losses.push({ kind: 'failure-rate', value: g.failureRate.value, limit: g.failureRate.limit });
  for (const { objective, p95Ms } of latency) {
    if (p95Ms <= objective.limitMs) continue;
    losses.push({ kind: 'latency', p95Ms, limitMs: objective.limitMs, ...(objective.kind !== undefined ? { requestKind: objective.kind } : {}) });
  }
  return losses;
}

export function invalidResult(
  wave: Wave,
  billed: WaveResult['bill'],
  complexity: number,
  errors: string[],
): WaveResult {
  const losses = errors.map((message): LossReason => ({ kind: 'invalid', message }));
  return {
    won: false,
    lossReasons: lossMessages(losses),
    losses,
    bill: billed,
    avgLatencyMs: 0,
    gauges: {
      cost: gauge(billed.fixed + billed.autoscaling + billed.migration, wave.budget),
      complexity: gauge(complexity, wave.complexityCap),
      failureRate: gauge(1, wave.sla.maxFailureRate),
      latency: gauge(0, wave.sla.maxP95LatencyMs),
    },
    offered: 0,
    failed: 0,
    failuresByReason: noFailures(),
    shed: 0,
    nodes: {},
    ticks: [],
    events: errors.map((message) => ({ type: 'invalid', message })),
  };
}
