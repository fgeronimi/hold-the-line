import type { ArchLink, ArchNode, Architecture } from '../../engine/types.ts';

/**
 * Architectures types du raccourcisseur, servant aux tests et à la simulation en masse.
 * Chacune correspond à la réponse attendue d'une vague, ou à son absence.
 */

const link = (from: string, to: string): ArchLink => ({ from, to });

const source = { id: 'src', type: 'traffic-source' };
const db = { id: 'db', type: 'database' };

export const minimal: Architecture = {
  nodes: [source, { id: 'app', type: 'app-server' }, db],
  links: [link('src', 'app'), link('app', 'db')],
};

export const noDatabase: Architecture = {
  nodes: [source, { id: 'app', type: 'app-server' }],
  links: [link('src', 'app')],
};

export const withCache: Architecture = {
  nodes: [source, { id: 'app', type: 'app-server' }, { id: 'cache', type: 'cache' }, db],
  links: [
    link('src', 'app'),
    link('app', 'cache'),
    link('app', 'db'),
  ],
};

/** La réponse de la vague 2 depuis X12 : le verrou encaisse le redémarrage à froid. */
export const withLockedCache: Architecture = {
  ...withCache,
  nodes: withCache.nodes.map((n) => (n.type === 'cache' ? { ...n, upgrades: { 'request-coalescing': 1 } } : n)),
};

export const withReplica: Architecture = {
  nodes: [source, { id: 'app', type: 'app-server' }, { ...db, upgrades: { 'read-replica': 1 } }],
  links: minimal.links,
};

/** `rateLimitTier` : index du palier de limite par client, 0 = désactivé. */
export function scaled(extraInstances: number, opts: { rateLimitTier?: number } = {}): Architecture {
  return {
    nodes: [
      source,
      { id: 'lb', type: 'load-balancer', upgrades: { 'rate-limiting': opts.rateLimitTier ?? 0 } },
      { id: 'app', type: 'app-server', upgrades: { 'horizontal-scaling': extraInstances } },
      { id: 'cache', type: 'cache' },
      db,
    ],
    links: [
      link('src', 'lb'),
      link('lb', 'app'),
      link('app', 'cache'),
        link('app', 'db'),
    ],
  };
}

/** Palier à 40 req/s par client : au-dessus des partenaires (30), bien sous le scraper (1 000). */
export const TIER_40 = 3;

/** Clics écrits directement en base, sur le chemin de la redirection. */
export function inlineClicks(extraInstances: number): Architecture {
  // Sans file, le routage envoie l'async à la base : les clics sont écrits en ligne.
  return scaled(extraInstances, { rateLimitTier: TIER_40 });
}

export function queuedClicks(extraInstances: number): Architecture {
  const base = scaled(extraInstances, { rateLimitTier: TIER_40 });
  return {
    nodes: [...base.nodes, { id: 'queue', type: 'message-queue' }, { id: 'worker', type: 'worker' }],
    links: [
      ...base.links,
      link('app', 'queue'),
      link('queue', 'worker'),
      link('worker', 'db'),
    ],
  };
}

/**
 * Réponse CDN de la vague 3 avec `extraInstances: 1` (X12) : les redirections sont servies en
 * bordure, une seconde instance encaisse la panne. Le scaling exige le load balancer.
 */
export function withCdn(opts: { rateLimitTier?: number; queue?: boolean; extraInstances?: number } = {}): Architecture {
  const app: ArchNode = { id: 'app', type: 'app-server', ...(opts.extraInstances ? { upgrades: { 'horizontal-scaling': opts.extraInstances } } : {}) };
  const nodes: ArchNode[] = [source, { id: 'cdn', type: 'cdn' }, app, { id: 'cache', type: 'cache' }, db];
  const links: ArchLink[] = [link('src', 'cdn')];

  if (opts.rateLimitTier || opts.extraInstances) {
    nodes.push({ id: 'lb', type: 'load-balancer', upgrades: { 'rate-limiting': opts.rateLimitTier ?? 0 } });
    links.push(link('cdn', 'lb'), link('lb', 'app'));
  } else {
    links.push(link('cdn', 'app'));
  }
  links.push(link('app', 'cache'), link('app', 'db'));

  if (opts.queue) {
    nodes.push({ id: 'queue', type: 'message-queue' }, { id: 'worker', type: 'worker' });
    links.push(link('app', 'queue'), link('queue', 'worker'), link('worker', 'db'));
  }
  return { nodes, links };
}

/** Réponse autoscaling de la vague 3 : un socle d'instances fixes, le pic absorbé à la demande. */
export function autoscaled(extraInstances: number, maxAuto: number): Architecture {
  const base = scaled(extraInstances);
  return {
    nodes: base.nodes.map((n) =>
      n.id === 'app' ? { ...n, upgrades: { 'horizontal-scaling': extraInstances, autoscaling: maxAuto } } : n,
    ),
    links: base.links,
  };
}

/**
 * Une passerelle d'API à l'entrée (C7), derrière le CDN s'il y en a un, devant le load
 * balancer : un quota par clé pour les partenaires, une limite par adresse pour les anonymes.
 * `singleLimit` garde en plus la limite unique du load balancer ; `noBalancer` relie la
 * passerelle directement au serveur, sans scaling possible.
 */
export function gated(opts: {
  partnerTier: number;
  anonymousTier: number;
  cdn?: boolean;
  extraInstances?: number;
  replicas?: number;
  queue?: boolean;
  singleLimit?: number;
  noBalancer?: boolean;
}): Architecture {
  const nodes: ArchNode[] = [source];
  const links: ArchLink[] = [];
  let entry = 'src';
  if (opts.cdn) {
    nodes.push({ id: 'cdn', type: 'cdn' });
    links.push(link('src', 'cdn'));
    entry = 'cdn';
  }
  nodes.push({ id: 'gateway', type: 'api-gateway', upgrades: { 'partner-quota': opts.partnerTier, 'anonymous-quota': opts.anonymousTier } });
  links.push(link(entry, 'gateway'));
  if (opts.noBalancer) {
    links.push(link('gateway', 'app'));
    nodes.push({ id: 'app', type: 'app-server' });
  } else {
    nodes.push(
      { id: 'lb', type: 'load-balancer', upgrades: { 'rate-limiting': opts.singleLimit ?? 0 } },
      { id: 'app', type: 'app-server', upgrades: { 'horizontal-scaling': opts.extraInstances ?? 0 } },
    );
    links.push(link('gateway', 'lb'), link('lb', 'app'));
  }
  nodes.push({ id: 'cache', type: 'cache' }, { ...db, upgrades: { 'read-replica': opts.replicas ?? 0 } });
  links.push(link('app', 'cache'), link('app', 'db'));
  if (opts.queue) {
    nodes.push({ id: 'queue', type: 'message-queue' }, { id: 'worker', type: 'worker' });
    links.push(link('app', 'queue'), link('queue', 'worker'), link('worker', 'db'));
  }
  return { nodes, links };
}

/** Quota par clé à 160 req/s : au-dessus des partenaires (125), il coupe la clé qui boucle (2 000). */
export const PARTNER_160 = 5;
/** Limite par adresse à 10 req/s : au-dessus d'un visiteur (3), bien sous le scraper (60). */
export const ANONYMOUS_10 = 1;
