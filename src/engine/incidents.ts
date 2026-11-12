import type { Incident } from './types.ts';

/**
 * Ce qu'attend l'appelant d'une dépendance qui ne répond plus du tout (M12) : elle ne refuse
 * pas, elle se tait, et chaque appel attend jusqu'au délai du client. Un ordre de grandeur de
 * délai par défaut ; ceux des clients HTTP sont souvent plus longs encore.
 */
export const UNANSWERED_MS = 5000;

export type MessagingIncident = 'duplicate-delivery' | 'publish-loss';

/** Ce que les incidents en cours font à chaque type de composant, à un tick donné. */
export interface IncidentState {
  tick: number;
  active: readonly Incident[];
  /** Instances mises hors service ; une dépendance tombée les perd toutes (Infinity). */
  down(type: string): number;
  /** Facteur appliqué au taux de succès d'un cache froid ou vidé par une ruée. */
  hitFactor(type: string): number;
  /** Recalculs de chaque absence en base pendant une ruée, verrou de recalcul non compris. */
  herd(type: string): number;
  /** Latence hors charge d'un composant, ralentie par un incident en cours. */
  latencyMs(type: string, baseMs: number): number;
  /** Les réplicas de ce composant sont coupés de leur primaire (S21). */
  partitioned(type: string): boolean;
  /** Part d'un incident de messagerie en cours sur ce type de composant. */
  share(type: string, effect: MessagingIncident): number;
}

export function activeAt(incidents: readonly Incident[] | undefined, tick: number): Incident[] {
  return (incidents ?? []).filter((i) => tick >= i.from && tick < i.until);
}

export function incidentState(active: readonly Incident[], tick: number): IncidentState {
  return {
    tick,
    active,
    down: (type) =>
      active.reduce(
        (a, i) =>
          a + (i.component !== type ? 0 : i.effect.type === 'instance-down' ? i.effect.count : i.effect.type === 'dependency-down' ? Infinity : 0),
        0,
      ),
    // Une ruée vers le cache vide le cache comme un redémarrage à froid.
    hitFactor: (type) =>
      active.reduce(
        (f, i) => (i.component === type && (i.effect.type === 'cold-cache' || i.effect.type === 'cache-stampede') ? f * ((tick - i.from) / (i.until - i.from)) : f),
        1,
      ),
    herd: (type) => active.reduce((h, i) => (i.component === type && i.effect.type === 'cache-stampede' ? Math.max(h, i.effect.herd) : h), 1),
    latencyMs: (type, baseMs) =>
      active.reduce(
        (l, i) =>
          i.component !== type
            ? l
            : i.effect.type === 'slow-dependency'
              ? Math.max(l, i.effect.latencyMs)
              : i.effect.type === 'dependency-down'
                ? Math.max(l, UNANSWERED_MS)
                : l,
        baseMs,
      ),
    partitioned: (type) => active.some((i) => i.component === type && i.effect.type === 'partition'),
    share: (type, effect) => active.reduce((a, i) => a + (i.component === type && i.effect.type === effect ? i.effect.share : 0), 0),
  };
}
