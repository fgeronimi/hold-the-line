import type { LossReason, RequestKind } from './types.ts';

/**
 * Les phrases des raisons de défaite. Le moteur ne raisonne que sur `LossReason` ; ces
 * phrases remplissent `WaveResult.lossReasons`, que l'interface et l'instantané
 * d'équilibrage lisent mot pour mot.
 */
export function lossMessages(losses: readonly LossReason[]): string[] {
  return losses.map(lossMessage);
}

export function lossMessage(r: LossReason): string {
  switch (r.kind) {
    case 'invalid':
      return `Architecture invalide : ${r.message}`;
    case 'budget': {
      const detail = r.autoscaling > 0 ? `, dont ${fmt(r.autoscaling)} d'autoscaling` : '';
      return `Budget dépassé : ${fmt(r.cost)} / ${fmt(r.limit)}${detail}`;
    }
    case 'complexity':
      return `Trop complexe : ${fmt(r.value)} / ${fmt(r.limit)} points`;
    case 'failure-rate':
      return `SLA rompu : ${pct(r.value)} d'échecs (max ${pct(r.limit)})`;
    case 'latency':
      return `SLA rompu : latence p95${r.requestKind ? ` ${KIND_NAMES[r.requestKind]}` : ''} ${fmt(r.p95Ms)} ms (max ${fmt(r.limitMs)} ms)`;
  }
}

/** Pour un objectif propre à un type de requête (M4). */
export const KIND_NAMES: Record<RequestKind, string> = { read: 'des lectures', write: 'des écritures', async: 'des événements' };

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const pct = (n: number) => `${(n * 100).toFixed(2)} %`;
