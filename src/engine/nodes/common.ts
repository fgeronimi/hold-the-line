import { addStream, filterFlow, isEvent, scaleFlow, sumRps, work, type Flow, type Stream } from '../flow.ts';
import { fail, tally, type Ledger } from '../ledger.ts';
import type { ComponentDef, RequestKind } from '../types.ts';
import type { World } from '../world.ts';

export interface NodeOutcome {
  /** Flux servi par ce nœud et qui continue vers l'aval (avant routage). */
  passed: Flow;
  utilization: number;
  /** Part de chaque type servi qui poursuit sa route de façon synchrone. */
  syncForwardShare: Partial<Record<RequestKind, number>>;
  instances?: number;
  /** Instances d'autoscaling demandées et pas encore prêtes. */
  starting?: number;
  /** Serveur : part de ses fils occupés, et la dépendance qui les retient s'ils sont tous pris. */
  threads?: number;
  blockedBy?: string;
}

/** Charge affichée d'un composant sans aucune instance en service qui reçoit du trafic. */
const OUTAGE_UTILIZATION = 10;

export function ratio(demand: number, capacity: number): number {
  if (demand === 0) return 0;
  return capacity > 0 ? demand / capacity : OUTAGE_UTILIZATION;
}

export function allForwarded(): Partial<Record<RequestKind, number>> {
  return { read: 1, write: 1, async: 1 };
}

/** Sert ce qui tient dans la capacité, fait échouer le reste à parts égales. */
export function serveWithin(nodeId: string, flow: Flow, demand: number, capacity: number, ctx: Ledger): Flow {
  if (demand <= capacity || demand === 0) return flow;
  const servedShare = capacity / demand;
  const lostShare = 1 - servedShare;
  fail(ctx, nodeId, 'saturation', sumRps(flow) * lostShare, sumRps(flow, isEvent) * lostShare);
  return scaleFlow(flow, servedShare);
}

export function failAll(nodeId: string, flow: Flow, ctx: Ledger): Flow {
  fail(ctx, nodeId, 'saturation', sumRps(flow), sumRps(flow, isEvent));
  return new Map();
}

export const fromQueue = (s: Stream) => s.queue !== undefined;

/** Le trafic arrivé en direct, et les messages relâchés par une file, pas encore acquittés. */
export function splitQueued(flow: Flow): { direct: Flow; queued: Flow } {
  return { direct: filterFlow(flow, (s) => !fromQueue(s)), queued: filterFlow(flow, fromQueue) };
}

/** Part d'un travail `demand` qui tient dans `left` de capacité libre. */
export function fits(demand: number, left: number): number {
  if (demand <= left) return 1;
  return left > 0 ? left / demand : 0;
}

/**
 * Un consommateur qui n'arrive pas à traiter un message ne l'acquitte pas : il reste dans sa
 * file et sera repris au tick suivant (M1). Seule la part `share` des messages de file est
 * servie ici ; le reste n'est ni servi ni en échec, il retourne d'où il vient.
 */
export function deferExcess(nodeId: string, queued: Flow, share: number, w: World, ctx: Ledger): Flow {
  if (share >= 1) return queued;
  const served: Flow = new Map();
  for (const s of queued.values()) {
    addStream(served, { ...s, rps: s.rps * share });
    const back = s.rps * (1 - share);
    if (back <= 0) continue;
    const pending = w.requeued.get(s.queue!) ?? new Map<string, Stream>();
    addStream(pending, { ...s, rps: back });
    w.requeued.set(s.queue!, pending);
    tally(ctx, nodeId, 'deferred', back);
  }
  return served;
}

/**
 * Sert ce qui tient dans la capacité, pour un nœud dont la charge n'est que le travail des
 * requêtes. Le trafic direct passe d'abord et fait échouer son excédent ; les messages de
 * file prennent la capacité qu'il laisse, le reste retourne dans sa file (M1). `demand` est
 * le travail réellement pris, qui fait la charge affichée.
 */
export function serveShared(nodeId: string, flow: Flow, def: ComponentDef, capacity: number, w: World, ctx: Ledger): { passed: Flow; demand: number } {
  const { direct, queued } = splitQueued(flow);
  const directDemand = work(direct, def);
  const passed = serveWithin(nodeId, direct, directDemand, capacity, ctx);
  if (queued.size === 0) return { passed, demand: directDemand };
  const queuedDemand = work(queued, def);
  const share = fits(queuedDemand, capacity - Math.min(directDemand, capacity));
  const out = new Map(passed);
  for (const s of deferExcess(nodeId, queued, share, w, ctx).values()) addStream(out, s);
  return { passed: out, demand: directDemand + queuedDemand * share };
}
