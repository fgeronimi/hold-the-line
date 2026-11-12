import { syncWait } from '../circuits.ts';
import { mergeFlows, sumRps, work, type Flow } from '../flow.ts';
import { retryingShare, timedOut } from '../retries.ts';
import { REQUEST_KINDS, type ArchNode, type ComponentDef } from '../types.ts';
import { instancesOf, withEffect } from '../upgrades.ts';
import { instancesNow, type Now, type World } from '../world.ts';
import { allForwarded, deferExcess, fits, ratio, serveWithin, splitQueued, type NodeOutcome } from './common.ts';

export function processService(node: ArchNode, def: ComponentDef, incoming: Flow, w: World, now: Now): NodeOutcome {
  const base = instancesNow(w, now.incidents, node);
  const auto = autoscale(node, def, base, w, now.ledger.tick);
  // Une panne retire d'abord des instances fixes, puis des instances à la demande (M2) : un
  // déploiement raté touche aussi les neuves, qui démarrent avec la même version cassée. Celles
  // que l'autoscaler lance pendant la panne n'y échappent donc pas, et ne servent qu'après.
  const autoDown = Math.max(0, now.incidents.down(node.type) - instancesOf(w.upgrades.get(node.id)!));
  const instances = base + Math.max(0, (auto?.active ?? 0) - autoDown);
  const capacity = def.capacity * instances;
  const { direct, queued } = splitQueued(incoming);
  const own = pressure(node.id, def, direct, instances, w, now);
  let passed = serveWithin(node.id, direct, timedOut(own.load, capacity, retryingShare(direct, def, w.retrying)), capacity, now.ledger);
  let taken = own;
  if (queued.size > 0) {
    // Les messages d'une file passent après le trafic direct et prennent ce qu'il laisse ; ils
    // ne font pas s'effondrer le serveur (S19) : ce ne sont pas des clients qui relancent.
    const all = pressure(node.id, def, mergeFlows(direct, queued), instances, w, now);
    const share = fits(all.load - own.load, capacity - Math.min(own.load, capacity));
    const served = deferExcess(node.id, queued, share, w, now.ledger);
    taken = pressure(node.id, def, mergeFlows(direct, served), instances, w, now);
    // Des fils tous pris par une dépendance lente laissent les messages en file : la cause reste à dire.
    if (share < 1 && all.blockedBy) taken = { ...taken, blockedBy: all.blockedBy };
    passed = mergeFlows(passed, served);
  }
  auto?.plan(taken.demand);
  return {
    passed,
    utilization: taken.utilization,
    syncForwardShare: allForwarded(),
    instances,
    ...(auto && auto.starting() > 0 ? { starting: auto.starting() } : {}),
    ...(taken.threads !== undefined ? { threads: taken.threads } : {}),
    ...(taken.blockedBy ? { blockedBy: taken.blockedBy } : {}),
  };
}

/**
 * Ce qu'un flux demande au serveur : son travail, ou plus si les fils manquent avant le
 * processeur, ou si un quota le limite. `load` est le travail à servir, `utilization` la charge.
 */
function pressure(id: string, def: ComponentDef, flow: Flow, instances: number, w: World, now: Now) {
  const capacity = def.capacity * instances;
  const demand = work(flow, def);
  let utilization = ratio(demand, capacity);
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
      for (const s of flow.values()) if (s.kind === kind) rps += s.rps / s.batch;
      const wait = syncWait(w, now, id, kind);
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
    const quota = (sumRps(flow) / (def.maxRps * instances)) * capacity;
    if (quota > load) {
      load = quota;
      utilization = Math.max(utilization, ratio(quota, capacity));
    }
  }
  return { demand, load, utilization, threads, blockedBy };
}

/**
 * Autoscaling réactif : il dimensionne sur la charge du tick courant, mais les instances
 * demandées n'arrivent qu'après leur délai de démarrage. Réduire est immédiat.
 */
/**
 * Instances d'un serveur qui serviront à ce tick, lues sans toucher à l'autoscaler : le
 * délestage du load balancer (M11) passe avant le serveur dans l'ordre du trafic, et doit
 * compter les instances à la demande prêtes à ce tick comme le serveur les comptera.
 */
export function servingInstances(node: ArchNode, w: World, now: Now): number {
  const base = instancesNow(w, now.incidents, node);
  const s = w.autoscalers.get(node.id);
  const tick = now.ledger.tick;
  const active = s ? s.active + s.pending.filter((p) => p.readyAt <= tick).reduce((a, p) => a + p.count, 0) : 0;
  const autoDown = Math.max(0, now.incidents.down(node.type) - instancesOf(w.upgrades.get(node.id)!));
  return base + Math.max(0, active - autoDown);
}

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
