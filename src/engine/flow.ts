import type { ComponentDef, RequestKind } from './types.ts';

/**
 * Un flux élémentaire : des requêtes d'un type, d'une source, à un niveau de
 * regroupement donné. `batch` > 1 après une file qui regroupe ses messages :
 * l'aval paie le travail d'un envoi, mais on compte toujours les messages.
 */
export interface Stream {
  kind: RequestKind;
  source: string;
  batch: number;
  rps: number;
  /** Copie livrée une seconde fois par un incident : elle ne compte jamais comme livrée. */
  duplicate?: boolean;
  /**
   * Message sorti de cette file et pas encore acquitté : ce que l'aval ne peut pas traiter y
   * retourne au lieu d'échouer (décision M1).
   */
  queue?: string;
}

/** Un événement async original : ce qu'un service attend de recevoir. */
export const isEvent = (s: Stream) => s.kind === 'async' && !s.duplicate;

export type Flow = Map<string, Stream>;

function streamKey(s: Pick<Stream, 'kind' | 'source' | 'batch' | 'duplicate' | 'queue'>): string {
  return `${s.kind}|${s.source}|${s.batch}${s.duplicate ? '|dup' : ''}${s.queue ? `|q:${s.queue}` : ''}`;
}

export function addStream(flow: Flow, s: Stream): void {
  if (s.rps <= 0) return;
  const key = streamKey(s);
  const existing = flow.get(key);
  if (existing) existing.rps += s.rps;
  else flow.set(key, { ...s });
}

export function scaleFlow(flow: Flow, factor: number): Flow {
  const out: Flow = new Map();
  for (const s of flow.values()) addStream(out, { ...s, rps: s.rps * factor });
  return out;
}

export function filterFlow(flow: Flow, pred: (s: Stream) => boolean): Flow {
  const out: Flow = new Map();
  for (const s of flow.values()) if (pred(s)) addStream(out, s);
  return out;
}

/** Les flux de `a` puis ceux de `b`, réunis. */
export function mergeFlows(a: Flow, b: Flow): Flow {
  const out: Flow = new Map();
  for (const s of a.values()) addStream(out, s);
  for (const s of b.values()) addStream(out, s);
  return out;
}

export function sumRps(flow: Flow, pred: (s: Stream) => boolean = () => true): number {
  let total = 0;
  for (const s of flow.values()) if (pred(s)) total += s.rps;
  return total;
}

export function work(flow: Flow, def: ComponentDef, pred: (s: Stream) => boolean = () => true): number {
  let total = 0;
  for (const s of flow.values()) {
    if (pred(s)) total += (s.rps * (def.workPerRequest[s.kind] ?? 0)) / s.batch;
  }
  return total;
}
