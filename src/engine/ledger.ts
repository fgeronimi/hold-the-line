import { classOf, isEvent, type Flow, type Stream } from './flow.ts';
import type { FailureReason, NodeTick, RequestKind, SimEvent } from './types.ts';

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
  /**
   * Échecs du tick que le client voit, par source et par type (M3) : chaque source ne relance
   * que les siens. Le reste n'en est pas : un doublon, un événement perdu après la réponse,
   * une lecture périmée, une copie non livrée, un message de file.
   */
  clientFailed: Map<string, Record<RequestKind, number>>;
  /**
   * Requêtes du client qui s'arrêtent à ce nœud sans y être servies (échecs, trafic abusif
   * écarté), par nœud et par classe (`classOf`) : la latence ne porte que sur les réponses
   * servies (M4).
   */
  classLost: Map<string, Map<string, number>>;
}

/** Raisons d'échec qui reviennent au client sous forme d'erreur : il peut relancer. */
const CLIENT_VISIBLE: ReadonlySet<FailureReason> = new Set(['saturation', 'no-route', 'rate-limited', 'circuit-open', 'timed-out', 'load-shed']);

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
    'timed-out': 0,
    'stale-read': 0,
    'load-shed': 0,
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

/** `rps` requêtes du client du flux `s` s'arrêtent ici sans réponse : hors de la latence (M4). */
export function lose(ctx: Ledger, nodeId: string, s: Stream, rps: number): void {
  const cls = classOf(s);
  if (rps <= 0 || cls === undefined) return;
  const byClass = ctx.classLost.get(nodeId) ?? new Map<string, number>();
  byClass.set(cls, (byClass.get(cls) ?? 0) + rps);
  ctx.classLost.set(nodeId, byClass);
}

/** L'échec de `rps` d'un flux élémentaire, attribué à sa source quand le client le voit. */
export function failStream(ctx: Ledger, nodeId: string, reason: FailureReason, s: Stream, rps: number): void {
  if (rps <= 0) return;
  fail(ctx, nodeId, reason, rps, isEvent(s) ? rps : 0);
  lose(ctx, nodeId, s, rps);
  if (!CLIENT_VISIBLE.has(reason) || s.duplicate || s.queue !== undefined) return;
  const bySource = ctx.clientFailed.get(s.source) ?? { read: 0, write: 0, async: 0 };
  bySource[s.kind] += rps;
  ctx.clientFailed.set(s.source, bySource);
}

/** La part `share` de chaque flux élémentaire de `flow` échoue. */
export function failFlow(ctx: Ledger, nodeId: string, reason: FailureReason, flow: Flow, share = 1): void {
  for (const s of flow.values()) failStream(ctx, nodeId, reason, s, s.rps * share);
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
