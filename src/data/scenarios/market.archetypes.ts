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

/**
 * Comment les événements de commande atteignent les services : pas du tout, appel
 * direct au service e-mail, file vers l'e-mail, une file partagée par les trois, un
 * pub/sub qui copie à une file par service, ou un pub/sub abonné sans file.
 */
export const DELIVERIES = ['none', 'inline', 'queue', 'shared-queue', 'pubsub', 'pubsub-direct'] as const;
export type Delivery = (typeof DELIVERIES)[number];

export interface FanOutOptions {
  idempotence?: boolean;
  outbox?: boolean;
  cache?: boolean;
  replicas?: number;
  /** Instances en plus du serveur de façade, derrière un load balancer. */
  extraInstances?: number;
}

/** Le schéma de référence du marché, toutes variantes de livraison confondues. */
export function ordering(delivery: Delivery, o: FanOutOptions = {}): Architecture {
  const nodes: ArchNode[] = [
    source,
    { id: 'app', type: 'app-server', upgrades: { 'horizontal-scaling': o.extraInstances ?? 0 } },
    { id: 'db', type: 'database', upgrades: { outbox: o.outbox ? 1 : 0, 'read-replica': o.replicas ?? 0 } },
    ...services(o.idempotence),
  ];
  const links: ArchLink[] = [link('app', 'db')];
  if (o.extraInstances) {
    nodes.push({ id: 'lb', type: 'load-balancer' });
    links.unshift(link('src', 'lb'), link('lb', 'app'));
  } else {
    links.unshift(link('src', 'app'));
  }
  switch (delivery) {
    case 'none':
      break;
    case 'inline':
      links.push(link('app', 'mail'));
      break;
    case 'queue':
    case 'shared-queue':
      nodes.push({ id: 'queue', type: 'message-queue' });
      links.push(link('app', 'queue'), ...(delivery === 'queue' ? ['mail'] : SERVICES).map((s) => link('queue', s)));
      break;
    case 'pubsub':
      nodes.push({ id: 'bus', type: 'pubsub' }, ...SERVICES.map((s): ArchNode => ({ id: `q-${s}`, type: 'message-queue' })));
      links.push(link('app', 'bus'), ...SERVICES.flatMap((s) => [link('bus', `q-${s}`), link(`q-${s}`, s)]));
      break;
    case 'pubsub-direct':
      nodes.push({ id: 'bus', type: 'pubsub' });
      links.push(link('app', 'bus'), ...SERVICES.map((s) => link('bus', s)));
      break;
  }
  if (o.cache) {
    nodes.push({ id: 'cache', type: 'cache' });
    links.push(link('app', 'cache'));
  }
  return { nodes, links };
}

/** Le crieur public annonce chaque commande à trois files, une par service. */
export const fannedOut = (o: FanOutOptions = {}): Architecture => ordering('pubsub', o);
