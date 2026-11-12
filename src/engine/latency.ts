import { classOf, type Flow } from './flow.ts';
import type { Delivery } from './route.ts';
import type { NodeTick, RequestKind, TickLatency, Wave } from './types.ts';
import { defOf, type World } from './world.ts';

/**
 * Au-delà, la latence d'un nœud saturé n'augmente plus : les requêtes en trop
 * échouent au lieu d'attendre indéfiniment. Plafonne le facteur à 1 / (1 - 0.95) = 20.
 */
const MAX_UTILIZATION_FOR_LATENCY = 0.95;

export const P95 = 0.95;

export function loadedLatency(baseMs: number, utilization: number): number {
  return baseMs / (1 - Math.min(utilization, MAX_UTILIZATION_FOR_LATENCY));
}

/**
 * Un chemin servi pendant un tick (M4) : sa latence de bout en bout, et le débit des réponses
 * servies par lui, qui le pèse dans le p95. Une classe de requête (source × type) en donne un
 * par chemin : une lecture servie par le cache et une lecture qui l'a raté et attend la base
 * sont deux points.
 */
export interface LatencyPoint {
  ms: number;
  rps: number;
  source: string;
  kind: RequestKind;
}

/** Ce que le calcul des latences lit d'un tick déjà traité. */
export interface TickPaths {
  sourceId: string;
  injected: Flow;
  classes: Delivery['classes'];
  /** Requêtes du client arrêtées à chaque nœud sans réponse, par classe. */
  lost: Map<string, Map<string, number>>;
  /** Appels abandonnés par le délai d'attente de chaque nœud, par classe (déjà dans `lost`). */
  waited: Map<string, Map<string, number>>;
  timeoutMs: (id: string) => number;
  /** Nœud sans instance qui se tait au lieu de refuser : ses échecs ont attendu sa latence. */
  silent: (id: string) => boolean;
  nodeTicks: Record<string, NodeTick>;
}

/**
 * Les chemins du tick, classe par classe. À chaque nœud, ce qui y arrive se partage entre ce
 * qu'il sert lui-même (un succès du cache, de la bordure, ce qu'une file accepte, ce qu'une
 * base termine), ce qu'il transmet à chaque voisin, et ce qui s'arrête là sans réponse. La
 * latence porte sur ce que le client a attendu : un refus (saturation, rate limiting,
 * délestage, disjoncteur, route manquante) est immédiat, il ne compte que dans le taux
 * d'échec ; un appel abandonné par un délai d'attente compte pour ce délai, et un appel à une
 * dépendance qui se tait pour le délai du client (M12). Un pub/sub copie l'événement à
 * chacun : le client attend la copie la plus lente, pas la somme.
 */
export function latencyPoints(w: World, { sourceId, injected, classes, lost, waited, timeoutMs, silent, nodeTicks }: TickPaths): LatencyPoint[] {
  const injectedByClass = new Map<string, number>();
  for (const s of injected.values()) {
    const cls = classOf(s);
    if (cls !== undefined) injectedByClass.set(cls, (injectedByClass.get(cls) ?? 0) + s.rps);
  }
  const points: LatencyPoint[] = [];
  for (const [cls, rps] of injectedByClass) {
    if (rps <= 0) continue;
    const [source, kind] = cls.split('|') as [string, RequestKind];
    const arrived = new Map<string, number>([[sourceId, rps]]);
    for (const [, byClass] of classes) {
      for (const [to, x] of byClass.get(cls) ?? []) arrived.set(to, (arrived.get(to) ?? 0) + x);
    }
    const memo = new Map<string, { ms: number; rps: number }[]>();
    const served = (id: string): { ms: number; rps: number }[] => {
      const known = memo.get(id);
      if (known) return known;
      const own = nodeTicks[id]?.latencyMs ?? 0;
      const into = arrived.get(id) ?? 0;
      const sent = classes.get(id)?.get(cls) ?? new Map<string, number>();
      const out: { ms: number; rps: number }[] = [];
      const stopped = lost.get(id)?.get(cls) ?? 0;
      const here = into - [...sent.values()].reduce((a, x) => a + x, 0) - stopped;
      if (here > 1e-9) out.push({ ms: own, rps: here });
      const gaveUp = waited.get(id)?.get(cls) ?? 0;
      if (gaveUp > 0) out.push({ ms: own + timeoutMs(id), rps: gaveUp });
      else if (stopped > 0 && silent(id)) out.push({ ms: own, rps: stopped });
      // La part de l'aval qui vient d'ici : un nœud peut être atteint par plusieurs chemins.
      const below = (to: string) => {
        const share = (sent.get(to) ?? 0) / (arrived.get(to) ?? 1);
        return served(to).map((p) => ({ ms: own + p.ms, rps: p.rps * share }));
      };
      if (defOf(w, id).fanOut && sent.size > 0) {
        const mean = (ps: { ms: number; rps: number }[]) => {
          const total = ps.reduce((a, p) => a + p.rps, 0);
          return total > 0 ? ps.reduce((a, p) => a + p.ms * p.rps, 0) / total : 0;
        };
        const branches = [...sent.keys()].map(below);
        out.push(...branches.reduce((slowest, b) => (mean(b) > mean(slowest) ? b : slowest)));
      } else {
        for (const to of sent.keys()) out.push(...below(to));
      }
      memo.set(id, out);
      return out;
    };
    for (const p of served(sourceId)) if (p.rps > 1e-9) points.push({ ...p, source, kind });
  }
  return points;
}

/**
 * Le centile pondéré par le débit : la plus petite latence telle que les réponses servies
 * aussi vite pèsent au moins `p` du total. Une minorité lente compte dès qu'elle pèse plus
 * de 1 − `p` des réponses. Sans réponse servie, 0.
 */
export function weightedPercentile(points: readonly { ms: number; rps: number }[], p: number): number {
  const sorted = points.filter((x) => x.rps > 0).sort((a, b) => a.ms - b.ms);
  const total = sorted.reduce((a, x) => a + x.rps, 0);
  if (total <= 0) return 0;
  let cumulative = 0;
  for (const x of sorted) {
    cumulative += x.rps;
    if (cumulative >= p * total) return x.ms;
  }
  return sorted.at(-1)!.ms;
}

/** Moyenne des latences servies, pondérée par le débit. */
export function weightedMean(points: readonly { ms: number; rps: number }[]): number {
  const total = points.reduce((a, x) => a + x.rps, 0);
  return total > 0 ? points.reduce((a, x) => a + x.ms * x.rps, 0) / total : 0;
}

/**
 * Le tick où la vague est perdue sur la latence, sans attendre sa fin : le premier où les
 * réponses plus lentes que la limite, cumulées depuis le début, pèsent plus de 1 − `p` de
 * toutes les réponses de la vague. Passé lui, le centile final dépasse forcément la limite.
 * `lost` dit si le centile final la dépasse : c'est lui qui tranche, au flottant près.
 */
export function breachTick(byTick: readonly (readonly { ms: number; rps: number }[])[], p: number, limit: number, lost: boolean): number | undefined {
  if (!lost) return undefined;
  const total = byTick.reduce((a, ps) => a + ps.reduce((b, x) => b + x.rps, 0), 0);
  let slow = 0;
  let lastSlow: number | undefined;
  for (let i = 0; i < byTick.length; i++) {
    for (const x of byTick[i]!) {
      if (x.ms > limit) {
        slow += x.rps;
        lastSlow = i;
      }
    }
    if (slow > (1 - p) * total) return i;
  }
  return lastSlow;
}

/**
 * Un objectif de latence et les réponses qu'il juge : le général couvre tous les types qui
 * n'ont pas le leur (`Wave.sla.maxP95LatencyMsByKind`).
 */
export interface LatencyObjective {
  /** Absent : l'objectif général. */
  kind?: RequestKind;
  limitMs: number;
}

export function latencyObjectives(sla: Wave['sla']): LatencyObjective[] {
  const own = Object.entries(sla.maxP95LatencyMsByKind ?? {}) as [RequestKind, number][];
  return [{ limitMs: sla.maxP95LatencyMs }, ...own.map(([kind, limitMs]) => ({ kind, limitMs }))];
}

/** Les réponses qu'un objectif juge. */
export function judgedBy(objective: LatencyObjective, sla: Wave['sla']): (p: LatencyPoint) => boolean {
  if (objective.kind !== undefined) return (p) => p.kind === objective.kind;
  const own = sla.maxP95LatencyMsByKind ?? {};
  return (p) => own[p.kind] === undefined;
}

/** Un objectif jugé sur toute la vague : son p95, et le tick où il est perdu s'il l'est. */
export interface ObjectiveVerdict {
  objective: LatencyObjective;
  p95Ms: number;
  breachTick?: number;
}

export function judgeLatency(byTick: readonly (readonly LatencyPoint[])[], sla: Wave['sla']): ObjectiveVerdict[] {
  return latencyObjectives(sla).map((objective) => {
    const pick = judgedBy(objective, sla);
    const ticks = byTick.map((ps) => ps.filter(pick));
    const p95Ms = weightedPercentile(ticks.flat(), P95);
    const breach = breachTick(ticks, P95, objective.limitMs, p95Ms > objective.limitMs);
    return { objective, p95Ms, ...(breach !== undefined ? { breachTick: breach } : {}) };
  });
}

/** Ce qu'un tick montre d'un objectif : son p95, ses réponses, et celles au-delà de la limite. */
export function tickLatencyOf(points: readonly LatencyPoint[], objective: LatencyObjective, sla: Wave['sla']): TickLatency {
  const judged = points.filter(judgedBy(objective, sla));
  return {
    p95Ms: weightedPercentile(judged, P95),
    answeredRps: judged.reduce((a, p) => a + p.rps, 0),
    slowRps: judged.reduce((a, p) => a + (p.ms > objective.limitMs ? p.rps : 0), 0),
  };
}
