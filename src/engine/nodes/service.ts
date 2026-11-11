import { syncWait } from '../circuits.ts';
import { sumRps, work, type Flow } from '../flow.ts';
import { timedOut } from '../retries.ts';
import { REQUEST_KINDS, type ArchNode, type ComponentDef } from '../types.ts';
import { withEffect } from '../upgrades.ts';
import { instancesNow, type Now, type World } from '../world.ts';
import { allForwarded, ratio, serveWithin, type NodeOutcome } from './common.ts';

export function processService(node: ArchNode, def: ComponentDef, incoming: Flow, w: World, now: Now): NodeOutcome {
  const base = instancesNow(w, now.incidents, node);
  const auto = autoscale(node, def, base, w, now.ledger.tick);
  const instances = base + (auto?.active ?? 0);
  const capacity = def.capacity * instances;
  const demand = work(incoming, def);
  auto?.plan(demand);
  let utilization = ratio(demand, capacity);
  // Travail à servir : celui des requêtes, ou plus si les fils manquent avant le processeur.
  let load = demand;
  // Loi de Little : fils occupés = débit × temps passé par requête, attente de l'aval comprise.
  let threads: number | undefined;
  let blockedBy: string | undefined;
  if (def.threads && instances > 0) {
    let busy = 0;
    let worst = { busy: 0, dependency: undefined as string | undefined };
    for (const kind of REQUEST_KINDS) {
      // Un envoi groupé n'occupe qu'un fil, comme il ne coûte qu'un travail (le lot d'une file).
      let rps = 0;
      for (const s of incoming.values()) if (s.kind === kind) rps += s.rps / s.batch;
      const wait = syncWait(w, now, node.id, kind);
      const held = (rps * (def.latencyMs + wait.ms)) / 1000;
      busy += held;
      if (wait.dependency && held > worst.busy) worst = { busy: held, dependency: wait.dependency };
    }
    threads = busy / (def.threads * instances);
    if (threads > utilization) {
      utilization = threads;
      load = threads * capacity;
      if (threads > 1) blockedBy = worst.dependency;
    }
  }
  // Un quota compte des messages, pas du travail : un envoi regroupé n'y échappe pas.
  if (def.maxRps) {
    const quota = (sumRps(incoming) / (def.maxRps * instances)) * capacity;
    if (quota > load) {
      load = quota;
      utilization = Math.max(utilization, ratio(quota, capacity));
    }
  }
  load = timedOut(load, capacity, w.timeouts);
  return {
    passed: serveWithin(node.id, incoming, load, capacity, now.ledger),
    utilization,
    syncForwardShare: allForwarded(),
    instances,
    ...(auto && auto.starting() > 0 ? { starting: auto.starting() } : {}),
    ...(threads !== undefined ? { threads } : {}),
    ...(blockedBy ? { blockedBy } : {}),
  };
}

/**
 * Autoscaling réactif : il dimensionne sur la charge du tick courant, mais les instances
 * demandées n'arrivent qu'après leur délai de démarrage. Réduire est immédiat.
 */
function autoscale(node: ArchNode, def: ComponentDef, base: number, w: World, tick: number) {
  for (const { effect, level: max } of withEffect(w.upgrades.get(node.id)!, 'autoscaling')) {
    if (max === 0) continue;
    const { instanceCost, startupTicks, targetUtilization } = effect;

    let state = w.autoscalers.get(node.id);
    if (!state) {
      state = { instanceCost, active: 0, pending: [], instanceTicks: 0 };
      w.autoscalers.set(node.id, state);
    }
    const s = state;
    for (const p of s.pending.filter((x) => x.readyAt <= tick)) s.active += p.count;
    s.pending = s.pending.filter((x) => x.readyAt > tick);
    s.instanceTicks += s.active;

    return {
      active: s.active,
      /** Instances demandées qui démarrent encore, après la décision de ce tick. */
      starting: () => s.pending.reduce((a, p) => a + p.count, 0),
      plan(demand: number) {
        const wanted = Math.ceil(demand / (def.capacity * targetUtilization)) - base;
        const target = Math.min(max, Math.max(0, wanted));
        const inFlight = s.pending.reduce((a, p) => a + p.count, 0);
        if (target > s.active + inFlight) {
          s.pending.push({ readyAt: tick + startupTicks, count: target - s.active - inFlight });
        } else if (target < s.active) {
          s.active = target;
          s.pending = [];
        }
      },
    };
  }
  return undefined;
}
