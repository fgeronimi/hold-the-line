import { work, type Flow } from './flow.ts';
import { REQUEST_KINDS, SYNC_KINDS, type ComponentDef, type RequestKind, type TrafficSource, type Wave } from './types.ts';
import { activeEffect, type NodeUpgrades } from './upgrades.ts';

export const syncOf = (src: TrafficSource) => SYNC_KINDS.reduce((a, k) => a + (src.rps[k] ?? 0), 0);

type ByKind = Record<RequestKind, number>;
const none = (): ByKind => ({ read: 0, write: 0, async: 0 });

/** Relances des clients (S19) : ce que chaque source renverra aux ticks suivants. */
export interface RetryPlan {
  retrying: TrafficSource[];
  /** Relances prévues, par source, par tick et par type : chaque source relance ce qu'elle a perdu. */
  at: Map<string, ByKind[]>;
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
    at: new Map(retrying.map((s) => [s.id, Array.from({ length: wave.ticks }, none)])),
    spread: backoff?.type === 'backoff' ? backoff.spreadTicks : 1,
    total: 0,
  };
}

/**
 * Chaque échec synchrone d'un client qui relance revient (S19) : au tick suivant sans
 * backoff, tous ensemble ; étalé sur les ticks suivants avec. Au plus `retries` relances
 * par requête neuve : au-delà, le client abandonne et l'échec est le sien. Chaque source ne
 * relance que ses propres échecs (M10), et une requête relancée réémet son événement s'il a
 * échoué avec elle (C5) : au plus un par requête, au prorata de la source.
 */
export function planRetries(plan: RetryPlan, ticks: number, tick: number, factor: number, failed: ReadonlyMap<string, ByKind>): void {
  for (const src of plan.retrying) {
    const lost = failed.get(src.id);
    if (!lost) continue;
    const sync = SYNC_KINDS.reduce((a, k) => a + lost[k], 0);
    if (sync <= 0) continue;
    const again = Math.min(sync, (src.retries ?? 0) * syncOf(src) * factor);
    const share = again / sync;
    const events = Math.min(lost.async, (again * (src.rps.async ?? 0)) / syncOf(src));
    const schedule = plan.at.get(src.id)!;
    for (let d = 1; d <= plan.spread; d++) {
      // Une relance prévue après la fin de la vague n'a pas lieu : son échec reste.
      if (tick + d >= ticks) break;
      const slot = schedule[tick + d]!;
      for (const k of SYNC_KINDS) slot[k] += (lost[k] * share) / plan.spread;
      slot.async += events / plan.spread;
      plan.total += (again + events) / plan.spread;
    }
  }
}

/** Ce qu'une source relance à ce tick, par type. */
export function retriesAt(plan: RetryPlan, sourceId: string, tick: number): ByKind {
  return plan.at.get(sourceId)?.[tick] ?? none();
}

export const sumKinds = (k: ByKind) => REQUEST_KINDS.reduce((a, x) => a + k[x], 0);

/** Part du travail de `flow` qui vient de clients qui relancent : la seule qui s'effondre (M10). */
export function retryingShare(flow: Flow, def: ComponentDef, retrying: ReadonlySet<string>): number {
  if (retrying.size === 0) return 0;
  const total = work(flow, def);
  return total > 0 ? work(flow, def, (s) => retrying.has(s.source)) / total : 0;
}

/**
 * Des clients qui relancent n'attendent pas d'être rejetés (S19) : au-delà de la capacité,
 * le nœud traite des requêtes déjà abandonnées et ne sert plus que capacité / charge de ce
 * qu'il pourrait. C'est ce qui entretient la tempête une fois la panne passée. Seule la part
 * `share` du travail venue de ces clients-là s'effondre ainsi (M10) : un client qui attend
 * sa réponse ne laisse pas de travail abandonné derrière lui.
 */
export function timedOut(demand: number, capacity: number, share: number): number {
  if (share <= 0 || demand <= capacity || capacity <= 0) return demand;
  return demand + share * ((demand * demand) / capacity - demand);
}
