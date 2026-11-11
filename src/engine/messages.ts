import type { LossReason } from './types.ts';

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
      const parts = [
        r.autoscaling > 0 && `${fmt(r.autoscaling)} d'autoscaling`,
        r.migration > 0 && `${fmt(r.migration)} de migration`,
      ].filter(Boolean);
      const detail = parts.length > 0 ? `, dont ${parts.join(' et ')}` : '';
      return `Budget dépassé : ${fmt(r.cost)} / ${fmt(r.limit)}${detail}`;
    }
    case 'complexity':
      return `Trop complexe : ${fmt(r.value)} / ${fmt(r.limit)} points`;
    case 'failure-rate':
      return `SLA rompu : ${pct(r.value)} d'échecs (max ${pct(r.limit)})`;
    case 'latency':
      return `SLA rompu : latence p95 (approx.) ${fmt(r.p95Ms)} ms (max ${fmt(r.limitMs)} ms)`;
  }
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const pct = (n: number) => `${(n * 100).toFixed(2)} %`;
