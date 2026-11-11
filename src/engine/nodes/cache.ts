import { work, type Flow } from '../flow.ts';
import type { ArchNode, ComponentDef } from '../types.ts';
import { instancesNow, type Now, type World } from '../world.ts';
import { allForwarded, ratio, serveWithin, type NodeOutcome } from './common.ts';

/**
 * Cache-aside : le routage ne lui envoie que les lectures qu'il sert, il n'a donc qu'à
 * tenir la charge. Les absences ne passent jamais par lui ; seuls les succès comptent
 * dans sa charge, les consultations ratées sont négligées. Un pub/sub fait de même : il
 * tient la charge, le routage se charge des copies.
 */
export function processCache(node: ArchNode, def: ComponentDef, incoming: Flow, w: World, now: Now): NodeOutcome {
  const capacity = def.capacity * instancesNow(w, now.incidents, node);
  const demand = work(incoming, def);
  return {
    passed: serveWithin(node.id, incoming, demand, capacity, now.ledger),
    utilization: ratio(demand, capacity),
    syncForwardShare: allForwarded(),
  };
}
