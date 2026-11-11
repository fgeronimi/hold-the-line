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
  /** Événement perdu avant publication : le messager s'évapore à mi-chemin de son dernier tronçon. */
  lost?: boolean;
  /**
   * Copie d'un message livré deux fois : elle part du lien où le bus l'a dupliqué. Traitée
   * une seconde fois (`twice`) ou reconnue et écartée par l'idempotence (`ignored`).
   */
  copy?: 'twice' | 'ignored';
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
  /** Refoulé à la porte : de 0 à 1 pendant le rebond, au début du retour. */
  bounce?: number;
  /** Événement perdu : de 0 à 1 pendant qu'il s'évapore. */
  vanish?: number;
  copy?: Journey['copy'];
  /** Copie qui vient de se détacher : de 0 à 1 au début de son premier tronçon. */
  split?: number;
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
        let lost = false;
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
          // Le serveur tombe entre l'écriture et la publication : l'événement ne part jamais.
          const lostHere = kind === 'async' ? (tick.nodes[node]?.lost ?? 0) : 0;
          if (lostHere > 0 && rand(t, i, k, step, 3) < lostHere / (lostHere + total)) {
            lost = true;
            break;
          }
          node = pick.to;
          const failed = tick.nodes[node]?.failed ?? 0;
          if (failed > 0 && rand(t, i, k, step, 2) < Math.min(1, failed / Math.max(inbound(tick, node), 1e-9))) {
            failedFrom = legs.length;
            break;
          }
        }
        if (legs.length === 0) continue;
        const start = t + i / n;
        if (lost) {
          out.push({ kind, start, legs, lost: true });
          continue;
        }
        const journey: Journey = {
          kind,
          start,
          legs: kind === 'async' && failedFrom === undefined ? legs : withReturn(legs),
        };
        if (failedFrom !== undefined) journey.failedFrom = failedFrom;
        out.push(journey);
        const copy = kind === 'async' && failedFrom === undefined ? copyOf(tick, legs, start, node, rand(t, i, k, 4), rand(t, i, k, 5)) : undefined;
        if (copy) out.push(copy);
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

/**
 * Le double d'un message arrivé à un service qui reçoit des doublons, dans leur proportion.
 * Le rendu ne connaît pas les types de bâtiments : la copie se détache sur l'avant-dernier
 * lien, celui qui sort du bus quand chaque service a sa file.
 */
function copyOf(tick: TickMetrics, legs: Leg[], start: number, service: string, roll: number, which: number): Journey | undefined {
  const twice = tick.nodes[service]?.duplicates ?? 0;
  const ignored = tick.nodes[service]?.deduplicated ?? 0;
  if (twice + ignored <= 0 || roll >= (twice + ignored) / Math.max(inbound(tick, service), 1e-9)) return undefined;
  const from = Math.max(0, legs.length - 2);
  return {
    kind: 'async',
    start: start + legs.slice(0, from).reduce((a, l) => a + l.duration, 0),
    legs: legs.slice(from),
    copy: which < twice / (twice + ignored) ? 'twice' : 'ignored',
  };
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

/** Un événement perdu ne fait que la moitié de son dernier tronçon. */
const legDuration = (j: Journey, i: number) => j.legs[i]!.duration * (j.lost && i === j.legs.length - 1 ? 0.5 : 1);

export function journeyDuration(j: Journey): number {
  return j.legs.reduce((a, _, i) => a + legDuration(j, i), 0);
}

/** Où est le voyageur à l'instant `time`, ou `undefined` s'il n'est pas (ou plus) en route. */
export function journeyAt(j: Journey, time: number): Position | undefined {
  let elapsed = time - j.start;
  if (elapsed < 0) return undefined;
  for (let i = 0; i < j.legs.length; i++) {
    const leg = j.legs[i]!;
    if (elapsed < legDuration(j, i)) {
      const f = elapsed / leg.duration;
      const at: Position = {
        link: leg.link,
        f: leg.back ? 1 - f : f,
        returning: leg.back,
        failed: j.failedFrom !== undefined && i >= j.failedFrom,
      };
      if (i === j.failedFrom && !j.hostile && f < 0.25) at.bounce = f / 0.25;
      if (j.lost && i === j.legs.length - 1) at.vanish = Math.min(1, Math.max(0, (f - 0.3) / 0.2));
      if (j.copy) {
        at.copy = j.copy;
        if (i === 0 && f < 0.25) at.split = f / 0.25;
      }
      return at;
    }
    elapsed -= legDuration(j, i);
  }
  return undefined;
}

/** Ce qui arrive à une requête, où et quand : de quoi afficher un +1, un −1 ou un bouclier. */
export interface Outcome {
  node: string;
  /** Instant, en ticks, où la requête atteint le bâtiment qui la sert ou la refuse. */
  at: number;
  /** `twice` et `ignored` : la copie d'un doublon, traitée une seconde fois ou écartée. */
  result: 'served' | 'refused' | 'repelled' | 'twice' | 'ignored';
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
  if (j.copy) return { ...reached, result: j.copy };
  // Perdu en route : le −1 tombe sur le serveur qui n'a pas publié.
  if (j.lost) return { node: last.link.split('→')[0]!, at: j.start + journeyDuration(j), result: 'refused' };
  if (j.failedFrom !== undefined) return { ...reached, result: 'refused' };
  const returns = j.legs.length > forward.length;
  if (!returns) return { ...reached, result: 'served' };
  return { node: forward[0]!.link.split('→')[0]!, at: j.start + journeyDuration(j), result: 'served' };
}

/** Un trajet et l'instant où il s'achève, calculé une fois pour toutes. */
export interface TimedJourney {
  j: Journey;
  end: number;
}

/**
 * Les trajets en route à un instant donné (`start <= time < end`), sans refiltrer toute la
 * vague à chaque image. Les trajets sont connus d'avance : un index avance sur ceux triés par
 * départ, et seuls les trajets en cours sont revus. Reculer dans le temps (curseur, courbes)
 * repart de zéro : c'est rare. L'ordre rendu est celui du tableau d'origine, comme un filtre.
 */
export class JourneyWindow {
  private readonly byStart: number[];
  private next = 0;
  private active: number[] = [];
  private last = -Infinity;

  private readonly items: readonly TimedJourney[];

  constructor(items: readonly TimedJourney[]) {
    this.items = items;
    this.byStart = items.map((_, i) => i).sort((a, b) => items[a]!.j.start - items[b]!.j.start || a - b);
  }

  at(time: number): Journey[] {
    if (time < this.last) {
      this.next = 0;
      this.active = [];
    }
    this.last = time;
    while (this.next < this.byStart.length && this.items[this.byStart[this.next]!]!.j.start <= time) {
      this.active.push(this.byStart[this.next]!);
      this.next++;
    }
    // Compactage sur place : un trajet fini ne revient jamais tant que le temps avance.
    let kept = 0;
    for (const i of this.active) if (this.items[i]!.end > time) this.active[kept++] = i;
    this.active.length = kept;
    this.active.sort((a, b) => a - b);
    return this.active.map((i) => this.items[i]!.j);
  }
}

/** Premier indice de `sorted` dont la valeur dépasse `x` (recherche dichotomique). */
function firstAbove(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Les issues qui viennent d'arriver (`time - 1 < at <= time`), sur des issues triées par `at`. */
export class RecentOutcomes {
  private readonly sorted: readonly Outcome[];
  private readonly ats: number[];

  constructor(sorted: readonly Outcome[]) {
    this.sorted = sorted;
    this.ats = sorted.map((o) => o.at);
  }

  at(time: number): Outcome[] {
    return this.sorted.slice(firstAbove(this.ats, time - 1), firstAbove(this.ats, time));
  }
}

/**
 * Les cumuls d'issues par type, lus à n'importe quel instant par dichotomie : plus de
 * parcours des résultats à chaque image. Reçoit les issues dans n'importe quel ordre.
 */
export class OutcomeTally {
  private readonly ats: Record<Outcome['result'], number[]> = { served: [], refused: [], repelled: [], twice: [], ignored: [] };

  constructor(outcomes: readonly Outcome[]) {
    for (const o of outcomes) this.ats[o.result].push(o.at);
    for (const list of Object.values(this.ats)) list.sort((a, b) => a - b);
  }

  /** Combien d'issues de ce type sont arrivées à l'instant `time` (inclus). */
  count(result: Outcome['result'], time: number): number {
    return firstAbove(this.ats[result], time);
  }
}
