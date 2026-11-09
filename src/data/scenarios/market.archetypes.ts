import type { ArchLink, ArchNode, Architecture } from '../../engine/types.ts';

/** Architectures types du grand marché : la réponse attendue de chaque vague, et ses contre-exemples. */

const link = (from: string, to: string): ArchLink => ({ from, to });
const source: ArchNode = { id: 'src', type: 'traffic-source' };

/** Le serveur écrit les commandes en base ; les événements y vont aussi, en ligne. */
export const inline: Architecture = {
  nodes: [source, { id: 'app', type: 'app-server' }, { id: 'db', type: 'database' }],
  links: [link('src', 'app'), link('app', 'db')],
};

/** Une file et un worker : les événements sont traités à part, par lots. */
export const queued: Architecture = {
  nodes: [...inline.nodes, { id: 'queue', type: 'message-queue' }, { id: 'worker', type: 'app-server' }],
  links: [...inline.links, link('app', 'queue'), link('queue', 'worker'), link('worker', 'db')],
};

/** Trois files sans pub/sub : le serveur partage les événements entre elles, chacune n'en voit qu'un tiers. */
export const threeQueues: Architecture = {
  nodes: [
    ...inline.nodes,
    ...['stock', 'billing', 'mail'].map((s): ArchNode => ({ id: `q-${s}`, type: 'message-queue' })),
    { id: 'worker', type: 'app-server' },
  ],
  links: [
    ...inline.links,
    ...['stock', 'billing', 'mail'].flatMap((s) => [link('app', `q-${s}`), link(`q-${s}`, 'worker')]),
    link('worker', 'db'),
  ],
};

export interface FanOutOptions {
  idempotence?: boolean;
  outbox?: boolean;
  cache?: boolean;
  replicas?: number;
  /** Instances en plus du serveur de façade, derrière un load balancer. */
  extraInstances?: number;
  extraWorkers?: number;
}

/** Le crieur public annonce chaque commande à trois files, une par service ; un worker les sert. */
export function fannedOut(o: FanOutOptions = {}): Architecture {
  const services = ['stock', 'billing', 'mail'];
  const nodes: ArchNode[] = [
    source,
    { id: 'app', type: 'app-server', upgrades: { 'horizontal-scaling': o.extraInstances ?? 0 } },
    { id: 'db', type: 'database', upgrades: { outbox: o.outbox ? 1 : 0, 'read-replica': o.replicas ?? 0 } },
    { id: 'bus', type: 'pubsub' },
    ...services.map((s): ArchNode => ({ id: `q-${s}`, type: 'message-queue' })),
    { id: 'worker', type: 'app-server', upgrades: { idempotence: o.idempotence ? 1 : 0, 'horizontal-scaling': o.extraWorkers ?? 0 } },
  ];
  const links: ArchLink[] = [
    link('app', 'db'),
    link('app', 'bus'),
    ...services.flatMap((s) => [link('bus', `q-${s}`), link(`q-${s}`, 'worker')]),
    link('worker', 'db'),
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
