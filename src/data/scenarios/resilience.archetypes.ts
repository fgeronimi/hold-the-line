import type { ArchLink, ArchNode, Architecture } from '../../engine/types.ts';
import { resilience } from './resilience.ts';

/** Architectures types du comptoir des paiements : la réponse attendue de chaque vague, et ses contre-exemples. */

const link = (from: string, to: string): ArchLink => ({ from, to });

export interface CheckoutOptions {
  /** Circuit breaker sur le serveur. */
  breaker?: boolean;
  /** Le paiement passe par une file : différé, hors du chemin du client. */
  queue?: boolean;
  cache?: boolean;
  /** Verrou de recalcul sur le cache. */
  coalescing?: boolean;
  replicas?: number;
  /** Instances en plus, derrière un load balancer. */
  extraInstances?: number;
}

/** Serveur, base et prestataire, avec les protections demandées. */
export function checkout(o: CheckoutOptions = {}): Architecture {
  const nodes: ArchNode[] = [
    { id: 'src', type: 'traffic-source' },
    { id: 'app', type: 'app-server', upgrades: { 'horizontal-scaling': o.extraInstances ?? 0, 'circuit-breaker': o.breaker ? 1 : 0 } },
    { id: 'db', type: 'database', upgrades: { 'read-replica': o.replicas ?? 0 } },
    ...(resilience.fixtures ?? []),
  ];
  const links: ArchLink[] = [link('app', 'db')];
  if (o.extraInstances) {
    nodes.push({ id: 'lb', type: 'load-balancer' });
    links.unshift(link('src', 'lb'), link('lb', 'app'));
  } else {
    links.unshift(link('src', 'app'));
  }
  if (o.queue) {
    nodes.push({ id: 'queue', type: 'message-queue' });
    links.push(link('app', 'queue'), link('queue', 'bank'));
  } else {
    links.push(link('app', 'bank'));
  }
  if (o.cache) {
    nodes.push({ id: 'cache', type: 'cache', upgrades: { 'request-coalescing': o.coalescing ? 1 : 0 } });
    links.push(link('app', 'cache'));
  }
  return { nodes, links };
}
