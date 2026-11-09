import type { ArchLink, ArchNode, Architecture } from '../../engine/types.ts';
import { market } from './market.ts';

/** Architectures types du grand marché : la réponse attendue de chaque vague, et ses contre-exemples. */

const link = (from: string, to: string): ArchLink => ({ from, to });
const source: ArchNode = { id: 'src', type: 'traffic-source' };
const SERVICES = ['stock', 'billing', 'mail'];

/** Les trois services déjà en place ; `idempotence` les rend idempotents. */
const services = (idempotence = false): ArchNode[] =>
  (market.fixtures ?? []).map((n) => ({ ...n, upgrades: { idempotence: idempotence ? 1 : 0 } }));

const base: Architecture = {
  nodes: [source, { id: 'app', type: 'app-server' }, { id: 'db', type: 'database' }, ...services()],
  links: [link('src', 'app'), link('app', 'db')],
};

/** Le serveur appelle le service e-mail en direct : le client attend l'envoi du mail. */
export const inline: Architecture = { nodes: base.nodes, links: [...base.links, link('app', 'mail')] };

/** Une file vers le service e-mail : l'événement sort du chemin critique. */
export const queued: Architecture = {
  nodes: [...base.nodes, { id: 'queue', type: 'message-queue' }],
  links: [...base.links, link('app', 'queue'), link('queue', 'mail')],
};

/** Une file pour les trois services, sans pub/sub : elle partage les événements, chacun n'en voit qu'un tiers. */
export const sharedQueue: Architecture = {
  nodes: queued.nodes,
  links: [...queued.links, link('queue', 'stock'), link('queue', 'billing')],
};

export interface FanOutOptions {
  idempotence?: boolean;
  outbox?: boolean;
  cache?: boolean;
  replicas?: number;
  /** Instances en plus du serveur de façade, derrière un load balancer. */
  extraInstances?: number;
}

/** Le crieur public annonce chaque commande à trois files, une par service. */
export function fannedOut(o: FanOutOptions = {}): Architecture {
  const nodes: ArchNode[] = [
    source,
    { id: 'app', type: 'app-server', upgrades: { 'horizontal-scaling': o.extraInstances ?? 0 } },
    { id: 'db', type: 'database', upgrades: { outbox: o.outbox ? 1 : 0, 'read-replica': o.replicas ?? 0 } },
    { id: 'bus', type: 'pubsub' },
    ...SERVICES.map((s): ArchNode => ({ id: `q-${s}`, type: 'message-queue' })),
    ...services(o.idempotence),
  ];
  const links: ArchLink[] = [
    link('app', 'db'),
    link('app', 'bus'),
    ...SERVICES.flatMap((s) => [link('bus', `q-${s}`), link(`q-${s}`, s)]),
  ];
  if (o.extraInstances) {
    nodes.push({ id: 'lb', type: 'load-balancer' });
    links.unshift(link('src', 'lb'), link('lb', 'app'));
  } else {
    links.unshift(link('src', 'app'));
  }
  if (o.cache) {
    nodes.push({ id: 'cache', type: 'cache' });
    links.push(link('app', 'cache'));
  }
  return { nodes, links };
}
