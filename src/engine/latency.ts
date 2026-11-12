import { sumRps, type Flow } from './flow.ts';
import type { NodeOutcome } from './nodes/index.ts';
import type { Routed } from './route.ts';
import type { RouteTable } from './routing.ts';
import { REQUEST_KINDS, type NodeTick, type RequestKind } from './types.ts';
import { defOf, type World } from './world.ts';

/**
 * Au-delà, la latence d'un nœud saturé n'augmente plus : les requêtes en trop
 * échouent au lieu d'attendre indéfiniment. Plafonne le facteur à 1 / (1 - 0.95) = 20.
 */
const MAX_UTILIZATION_FOR_LATENCY = 0.95;

export const P95 = 0.95;
/** Part du trafic au-delà de laquelle des clients lents se voient dans le p95. */
const P95_SHARE = 1 - P95;

export function loadedLatency(baseMs: number, utilization: number): number {
  return baseMs / (1 - Math.min(utilization, MAX_UTILIZATION_FOR_LATENCY));
}

/** Ce que le calcul des latences lit d'un tick déjà traité. */
export interface TickPaths {
  order: string[];
  routes: RouteTable;
  routed: Routed;
  outcomes: Map<string, NodeOutcome>;
  nodeTicks: Record<string, NodeTick>;
  open: Map<string, Set<string>>;
  /** Appels abandonnés par un délai d'attente : ils comptent pour ce délai (M12). */
  waited?: Routed;
  timeouts?: Map<string, { ms: number; cut: Set<string> }>;
}

/**
 * Latence moyenne d'une requête depuis un nœud jusqu'au bout de son chemin synchrone.
 * `skip` écarte des voisins : les caches, pour une lecture qui ne peut pas y tomber.
 */
export function computePathLatencies(
  { order, routes, routed, outcomes, nodeTicks, open, waited, timeouts }: TickPaths,
  skip: (id: string) => boolean = () => false,
): (id: string, kind: RequestKind) => number {
  const memo = new Map<string, number>();
  for (const id of [...order].reverse()) {
    for (const kind of REQUEST_KINDS) {
      const own = nodeTicks[id]?.latencyMs ?? 0;
      const share = outcomes.get(id)?.syncForwardShare[kind] ?? 0;
      const sent = [...(routed.get(id)?.get(kind) ?? new Map<string, number>())].filter(([to]) => !skip(to));
      const gaveUp = [...(waited?.get(id)?.get(kind) ?? new Map<string, number>())].filter(([to]) => !skip(to));
      const total = [...sent, ...gaveUp].reduce((a, [, x]) => a + x, 0);
      let downstream = 0;
      if (total > 0) {
        for (const [to, rps] of sent) downstream += (rps / total) * (memo.get(`${to}|${kind}`) ?? 0);
        // Un appel abandonné a attendu tout le délai, pas la réponse qu'il n'a jamais eue.
        for (const [, rps] of gaveUp) downstream += (rps / total) * (timeouts?.get(id)?.ms ?? 0);
      } else {
        // Pas de trafic ce tick : on suppose une répartition égale, pour que la latence reste définie.
        // Un appel coupé par le disjoncteur échoue tout de suite : il n'attend pas l'aval.
        const targets = (routes.get(id)?.forward[kind] ?? []).filter((t) => !open.get(id)?.has(t) && !skip(t));
        if (targets.length > 0) {
          downstream = targets.reduce((a, to) => a + (memo.get(`${to}|${kind}`) ?? 0), 0) / targets.length;
        }
      }
      memo.set(`${id}|${kind}`, own + share * downstream);
    }
  }
  return (id, kind) => memo.get(`${id}|${kind}`) ?? 0;
}

/**
 * La latence d'un tick : `avg`, la moyenne pondérée par le débit injecté de chaque type,
 * `sla`, ce que le SLA en retient, et `syncRps`, le débit qui pondère la moyenne de la vague.
 */
export function tickLatency(w: World, paths: TickPaths, sourceId: string, injected: Flow): { avg: number; sla: number; syncRps: number } {
  const pathLatency = computePathLatencies(paths);
  // L'événement fait partie de la commande : tant qu'il est traité en direct, le client
  // l'attend. Une file le sort du chemin critique (sa part synchrone s'arrête à elle).
  const injectedSync = REQUEST_KINDS.map((k) => ({ k, rps: sumRps(injected, (s) => s.kind === k) }));
  const syncRps = injectedSync.reduce((a, x) => a + x.rps, 0);
  const avg =
    syncRps > 0
      ? injectedSync.reduce((a, x) => a + x.rps * (pathLatency(sourceId, x.k)), 0) / syncRps
      : 0;
  // Le client qui passe commande attend tout l'événement tant qu'il est traité en direct :
  // sa latence compte entière, pas diluée dans les lectures (décision S17). Derrière une
  // file, la part synchrone de l'événement s'arrête à elle et reste courte.
  const eventRps = injectedSync.find((x) => x.k === 'async')?.rps ?? 0;
  // De même, une lecture qui doit être à jour ne passe par aucun cache : si ces clients
  // pèsent plus de 5 % du trafic, le p95 les voit, leur latence compte entière (S21).
  const consistentRps = sumRps(injected, (s) => s.kind === 'read' && !!w.sourcesById.get(s.source)?.consistent);
  const consistentLatency =
    consistentRps > P95_SHARE * syncRps
      ? computePathLatencies(paths, (id) => !!defOf(w, id).lookaside)(sourceId, 'read')
      : 0;
  const sla = Math.max(avg, eventRps > 0 ? pathLatency(sourceId, 'async') : 0, consistentLatency);
  return { avg, sla, syncRps };
}

/** Percentile par rang le plus proche : sur 60 ticks, le p95 écarte les 3 pires. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

/**
 * Le tick où la vague est perdue sur la latence, sans attendre sa fin : dès qu'un tick
 * au-dessus de la limite de plus que ce que le rang du percentile écarte est passé, le
 * percentile final dépassera forcément la limite. Même règle que `percentile`.
 */
export function breachTick(values: number[], p: number, limit: number): number | undefined {
  const tolerated = values.length - Math.max(1, Math.ceil(p * values.length));
  let over = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i]! > limit && ++over > tolerated) return i;
  }
  return undefined;
}
