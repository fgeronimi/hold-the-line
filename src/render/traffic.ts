import type { RequestKind, TickMetrics } from '../engine/types.ts';
import { REQUEST_KINDS } from '../engine/types.ts';

/** Un tronçon de trajet : un lien parcouru à l'aller, ou au retour avec la réponse. */
export interface Leg {
  /** Clé `from→to` du lien, comme dans les ticks. */
  link: string;
  back: boolean;
  /** Durée du tronçon, en ticks. */
  duration: number;
}

/**
 * Le voyage d'une requête : des hameaux jusqu'au bâtiment qui la sert, puis le même
 * chemin en sens inverse avec la réponse. Une requête async ne revient pas : personne
 * n'attend sa réponse.
 */
export interface Journey {
  kind: RequestKind;
  /** Départ, en ticks depuis le début de la vague. */
  start: number;
  legs: Leg[];
  /** Refusée en route : à partir de ce tronçon (le retour), le voyageur est refoulé. */
  failedFrom?: number;
  /** Trafic abusif repoussé par le rate limiting. */
  hostile?: boolean;
}

export interface TrafficScale {
  rpsPerJourney: number;
  maxPerKind: number;
}

/** Où se trouve le voyageur : sur quel lien, à quelle fraction (du départ du lien vers son arrivée). */
export interface Position {
  link: string;
  f: number;
  returning: boolean;
  failed: boolean;
}

/** Les nœuds d'où part le trafic d'un tick : ceux qui envoient sans jamais recevoir. */
function sourcesOf(tick: TickMetrics): string[] {
  const from = new Set<string>();
  const to = new Set<string>();
  for (const key of Object.keys(tick.links)) {
    const [a, b] = key.split('→');
    from.add(a!);
    to.add(b!);
  }
  return [...from].filter((n) => !to.has(n));
}

function outgoing(tick: TickMetrics, node: string, kind: RequestKind): { link: string; to: string; rps: number }[] {
  return Object.entries(tick.links)
    .filter(([key, kinds]) => key.startsWith(`${node}→`) && (kinds[kind] ?? 0) > 0)
    .map(([key, kinds]) => ({ link: key, to: key.split('→')[1]!, rps: kinds[kind]! }));
}

function inbound(tick: TickMetrics, node: string): number {
  return Object.entries(tick.links)
    .filter(([key]) => key.endsWith(`→${node}`))
    .reduce((a, [, kinds]) => a + Object.values(kinds).reduce((x, y) => x + y, 0), 0);
}

/**
 * Échelle commune à toute la vague : le type de requête le plus envoyé reçoit
 * `maxPerKind` voyageurs par tick, les autres proportionnellement. Sans ça, une vague à
 * 100 req/s serait vide et une vague à 5 000 req/s illisible.
 */
export function trafficScale(ticks: TickMetrics[], maxPerKind = 8): TrafficScale {
  let peak = 0;
  for (const t of ticks) {
    for (const s of sourcesOf(t)) {
      for (const kind of REQUEST_KINDS) peak = Math.max(peak, outgoing(t, s, kind).reduce((a, o) => a + o.rps, 0));
    }
  }
  return { rpsPerJourney: Math.max(peak / maxPerKind, 1e-9), maxPerKind };
}

/**
 * Durée d'un tronçon : plus le nœud d'arrivée répond lentement, plus on marche lentement
 * vers lui. C'est ce qui fait apparaître les embouteillages devant un nœud saturé.
 */
export function tripDuration(targetLatencyMs: number): number {
  return Math.min(0.6 + targetLatencyMs / 40, 3);
}

function count(rps: number, scale: TrafficScale): number {
  // Au moins un voyageur dès qu'il y a du trafic : un chemin utilisé ne doit jamais paraître vide.
  return rps > 0 ? Math.min(scale.maxPerKind, Math.max(1, Math.round(rps / scale.rpsPerJourney))) : 0;
}

/** Tirage déterministe dans [0, 1[ : le même rejeu montre les mêmes voyages. */
function rand(...seed: number[]): number {
  const x = Math.sin(seed.reduce((a, s, i) => a + s * (12.9898 + i * 78.233), 0)) * 43758.5453;
  return x - Math.floor(x);
}

function withReturn(forward: Leg[]): Leg[] {
  return [...forward, ...[...forward].reverse().map((l) => ({ ...l, back: true }))];
}

/**
 * Les voyages qui partent pendant le tick `t`. À chaque bâtiment, la requête choisit son
 * lien de sortie au prorata des débits réels du tick (une lecture va au carnet dans la
 * proportion des succès du cache, sinon aux archives), et risque d'être refusée dans la
 * proportion des échecs de ce bâtiment. Elle va jusqu'au bout de son chemin, puis revient.
 */
export function journeysForTick(tick: TickMetrics, t: number, scale: TrafficScale): Journey[] {
  const out: Journey[] = [];
  const legTo = (link: string): Leg => ({
    link,
    back: false,
    duration: tripDuration(tick.nodes[link.split('→')[1]!]?.latencyMs ?? 0),
  });

  for (const source of sourcesOf(tick)) {
    REQUEST_KINDS.forEach((kind, k) => {
      const n = count(outgoing(tick, source, kind).reduce((a, o) => a + o.rps, 0), scale);
      for (let i = 0; i < n; i++) {
        const legs: Leg[] = [];
        let failedFrom: number | undefined;
        let node = source;
        const seen = new Set([source]);
        for (let step = 0; step < 12; step++) {
          const options = outgoing(tick, node, kind);
          const total = options.reduce((a, o) => a + o.rps, 0);
          if (total === 0) break;
          let roll = rand(t, i, k, step, 1) * total;
          const pick = options.find((o) => (roll -= o.rps) < 0) ?? options.at(-1)!;
          if (seen.has(pick.to)) break;
          seen.add(pick.to);
          legs.push(legTo(pick.link));
          node = pick.to;
          const failed = tick.nodes[node]?.failed ?? 0;
          if (failed > 0 && rand(t, i, k, step, 2) < Math.min(1, failed / Math.max(inbound(tick, node), 1e-9))) {
            failedFrom = legs.length;
            break;
          }
        }
        if (legs.length === 0) continue;
        const journey: Journey = {
          kind,
          start: t + i / n,
          legs: kind === 'async' && failedFrom === undefined ? legs : withReturn(legs),
        };
        if (failedFrom !== undefined) journey.failedFrom = failedFrom;
        out.push(journey);
      }
    });
  }

  // Les pillards : de la source jusqu'au bâtiment qui les écarte, puis refoulés.
  for (const [node, metrics] of Object.entries(tick.nodes)) {
    const n = count(metrics.shed ?? 0, scale);
    const path = pathTo(tick, node);
    if (!path) continue;
    for (let i = 0; i < n; i++) {
      out.push({ kind: 'read', start: t + i / n, legs: withReturn(path.map(legTo)), failedFrom: path.length, hostile: true });
    }
  }
  return out;
}

/** Un chemin de liens actifs depuis une source jusqu'à `node`, s'il existe. */
function pathTo(tick: TickMetrics, node: string): string[] | undefined {
  const queue: { at: string; links: string[] }[] = sourcesOf(tick).map((s) => ({ at: s, links: [] }));
  const seen = new Set(queue.map((q) => q.at));
  while (queue.length > 0) {
    const { at, links } = queue.shift()!;
    if (at === node) return links.length > 0 ? links : undefined;
    for (const key of Object.keys(tick.links).filter((k) => k.startsWith(`${at}→`))) {
      const to = key.split('→')[1]!;
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push({ at: to, links: [...links, key] });
    }
  }
  return undefined;
}

export function journeyDuration(j: Journey): number {
  return j.legs.reduce((a, l) => a + l.duration, 0);
}

/** Où est le voyageur à l'instant `time`, ou `undefined` s'il n'est pas (ou plus) en route. */
export function journeyAt(j: Journey, time: number): Position | undefined {
  let elapsed = time - j.start;
  if (elapsed < 0) return undefined;
  for (let i = 0; i < j.legs.length; i++) {
    const leg = j.legs[i]!;
    if (elapsed < leg.duration) {
      const f = elapsed / leg.duration;
      return {
        link: leg.link,
        f: leg.back ? 1 - f : f,
        returning: leg.back,
        failed: j.failedFrom !== undefined && i >= j.failedFrom,
      };
    }
    elapsed -= leg.duration;
  }
  return undefined;
}

/** Ce qui arrive à une requête, où et quand : de quoi afficher un +1, un −1 ou un bouclier. */
export interface Outcome {
  node: string;
  /** Instant, en ticks, où la requête atteint le bâtiment qui la sert ou la refuse. */
  at: number;
  result: 'served' | 'refused' | 'repelled';
}

/**
 * L'issue d'un trajet. Une requête servie ne compte qu'une fois la réponse revenue au
 * client : son +1 apparaît aux hameaux, à la fin du retour. Un refus ou un pillard
 * repoussé se lit là où il a lieu, au bout de l'aller. Un async, qui ne revient pas,
 * compte au bout de son aller simple.
 */
export function outcomeOf(j: Journey): Outcome | undefined {
  const forward = j.legs.filter((l) => !l.back);
  const last = forward.at(-1);
  if (!last) return undefined;
  const reached = { node: last.link.split('→')[1]!, at: j.start + forward.reduce((a, l) => a + l.duration, 0) };
  if (j.hostile) return { ...reached, result: 'repelled' };
  if (j.failedFrom !== undefined) return { ...reached, result: 'refused' };
  const returns = j.legs.length > forward.length;
  if (!returns) return { ...reached, result: 'served' };
  return { node: forward[0]!.link.split('→')[0]!, at: j.start + journeyDuration(j), result: 'served' };
}
