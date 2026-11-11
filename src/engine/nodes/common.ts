import { isEvent, scaleFlow, sumRps, type Flow } from '../flow.ts';
import { fail, type Ledger } from '../ledger.ts';
import type { RequestKind } from '../types.ts';

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
