import { SYNC_KINDS, type TrafficSource, type Wave } from './types.ts';
import { activeEffect, type NodeUpgrades } from './upgrades.ts';

export const syncOf = (src: TrafficSource) => SYNC_KINDS.reduce((a, k) => a + (src.rps[k] ?? 0), 0);

/** Relances des clients (S19) : ce que chaque source renverra aux ticks suivants. */
export interface RetryPlan {
  retrying: TrafficSource[];
  /** Relances prévues, par source et par tick. */
  at: Map<string, number[]>;
  /** Ticks sur lesquels une relance s'étale : 1 sans backoff, tous ensemble au tick suivant. */
  spread: number;
  /** Échecs relancés pendant la vague : le client ne les a pas vus, il a réessayé. */
  total: number;
}

export function retryPlan(wave: Wave, clients: NodeUpgrades): RetryPlan {
  const retrying = wave.sources.filter((s) => (s.retries ?? 0) > 0 && !s.abusive);
  const backoff = activeEffect(clients, 'backoff');
  return {
    retrying,
    at: new Map(retrying.map((s) => [s.id, new Array<number>(wave.ticks).fill(0)])),
    spread: backoff?.type === 'backoff' ? backoff.spreadTicks : 1,
    total: 0,
  };
}

/**
 * Chaque échec synchrone d'un client qui relance revient (S19) : au tick suivant sans
 * backoff, tous ensemble ; étalé sur les ticks suivants avec. Au plus `retries` relances
 * par requête neuve : au-delà, le client abandonne et l'échec est le sien.
 */
export function planRetries(plan: RetryPlan, ticks: number, tick: number, factor: number, syncFailed: number): void {
  const weight = plan.retrying.reduce((a, s) => a + syncOf(s), 0);
  for (const src of plan.retrying) {
    const schedule = plan.at.get(src.id)!;
    const fresh = syncOf(src) * factor;
    const again = Math.min((syncFailed * syncOf(src)) / weight, (src.retries ?? 0) * fresh);
    for (let d = 1; d <= plan.spread; d++) {
      // Une relance prévue après la fin de la vague n'a pas lieu : son échec reste.
      if (tick + d >= ticks) break;
      schedule[tick + d]! += again / plan.spread;
      plan.total += again / plan.spread;
    }
  }
}

/**
 * Des clients qui relancent n'attendent pas d'être rejetés (S19) : au-delà de la capacité,
 * le nœud traite des requêtes déjà abandonnées et ne sert plus que capacité / charge de ce
 * qu'il pourrait. C'est ce qui entretient la tempête une fois la panne passée.
 */
export function timedOut(demand: number, capacity: number, timeouts: boolean): number {
  return timeouts && demand > capacity && capacity > 0 ? (demand * demand) / capacity : demand;
}
