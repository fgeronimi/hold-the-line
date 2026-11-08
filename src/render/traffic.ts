import type { RequestKind, TickMetrics } from '../engine/types.ts';
import { REQUEST_KINDS } from '../engine/types.ts';

export interface Vehicle {
  link: string;
  kind: RequestKind;
  /** Départ, en ticks depuis le début de la vague. */
  start: number;
  /** Durée du trajet aller, en ticks. */
  duration: number;
  /** Aller-retour : une consultation (cache-aside) revient à son point de départ. */
  roundTrip: boolean;
  /** Requête en échec : elle arrive au nœud qui la refuse et fait demi-tour. */
  failed?: boolean;
  /** Trafic abusif repoussé par le rate limiting : il fait demi-tour lui aussi. */
  hostile?: boolean;
}

export interface TrafficScale {
  rpsPerVehicle: number;
  maxPerLinkKind: number;
}

/**
 * Échelle commune à toute la vague : le lien le plus chargé reçoit `maxPerLinkKind`
 * véhicules par tick, les autres proportionnellement. Sans ça, une vague à 100 req/s
 * serait vide et une vague à 5 000 req/s illisible.
 */
export function trafficScale(ticks: TickMetrics[], maxPerLinkKind = 8): TrafficScale {
  let peak = 0;
  for (const t of ticks) for (const kinds of Object.values(t.links)) for (const rps of Object.values(kinds)) peak = Math.max(peak, rps);
  return { rpsPerVehicle: Math.max(peak / maxPerLinkKind, 1e-9), maxPerLinkKind };
}

/**
 * Durée d'un trajet : plus le nœud d'arrivée répond lentement, plus les véhicules roulent
 * lentement vers lui. C'est ce qui fait apparaître les embouteillages devant un nœud saturé.
 */
export function tripDuration(targetLatencyMs: number): number {
  return Math.min(0.6 + targetLatencyMs / 40, 3);
}

/** Véhicules qui partent pendant le tick `t`, répartis régulièrement dans le tick. */
export function vehiclesForTick(
  tick: TickMetrics,
  t: number,
  scale: TrafficScale,
  roundTrips: Set<string>,
): Vehicle[] {
  const out: Vehicle[] = [];
  for (const [link, kinds] of Object.entries(tick.links)) {
    const to = link.split('→')[1]!;
    const duration = tripDuration(tick.nodes[to]?.latencyMs ?? 0);
    for (const kind of REQUEST_KINDS) {
      const rps = kinds[kind] ?? 0;
      if (rps <= 0) continue;
      // Au moins un véhicule dès qu'il y a du trafic : un lien utilisé ne doit jamais paraître vide.
      const count = Math.min(scale.maxPerLinkKind, Math.max(1, Math.round(rps / scale.rpsPerVehicle)));
      for (let i = 0; i < count; i++) {
        out.push({ link, kind, start: t + i / count, duration, roundTrip: roundTrips.has(link) });
      }
    }
  }
  return out;
}

/**
 * Demi-tours du tick : pour chaque nœud qui fait échouer des requêtes, des véhicules
 * repartent en sens inverse sur sa route d'arrivée la plus chargée. Même échelle que le
 * trafic, pour qu'un échec massif se voie autant que le trafic qu'il perd.
 */
export function failuresForTick(tick: TickMetrics, t: number, scale: TrafficScale): Vehicle[] {
  const out: Vehicle[] = [];
  for (const [node, metrics] of Object.entries(tick.nodes)) {
    const incoming = Object.entries(tick.links)
      .filter(([key]) => key.endsWith(`→${node}`))
      .map(([key, kinds]) => ({ key, rps: Object.values(kinds).reduce((a, x) => a + x, 0) }))
      .sort((a, b) => b.rps - a.rps)[0];
    // Sans route d'arrivée (la source elle-même), rien à animer : l'étiquette suffit.
    if (!incoming) continue;
    const turnBack = (rps: number, flag: 'failed' | 'hostile') => {
      if (rps <= 0) return;
      const count = Math.min(scale.maxPerLinkKind, Math.max(1, Math.round(rps / scale.rpsPerVehicle)));
      for (let i = 0; i < count; i++) {
        out.push({ link: incoming.key, kind: 'read', start: t + i / count, duration: 0.8, roundTrip: true, [flag]: true });
      }
    };
    turnBack(metrics.failed, 'failed');
    turnBack(metrics.shed ?? 0, 'hostile');
  }
  return out;
}

/** Fraction parcourue du trajet à l'instant `time`, ou `undefined` si le véhicule n'est pas sur la route. */
export function progressAt(v: Vehicle, time: number): number | undefined {
  const elapsed = time - v.start;
  const total = v.roundTrip ? v.duration * 2 : v.duration;
  if (elapsed < 0 || elapsed >= total) return undefined;
  if (!v.roundTrip) return elapsed / v.duration;
  // Aller puis retour sur la même route.
  return elapsed < v.duration ? elapsed / v.duration : 2 - elapsed / v.duration;
}
