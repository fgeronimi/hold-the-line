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
    link('cache', 'db'),
    link('app', 'db'),
  ],
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
      link('cache', 'db'),
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
    nodes: [...base.nodes, { id: 'queue', type: 'message-queue' }, { id: 'worker', type: 'app-server' }],
    links: [
      ...base.links,
      link('app', 'queue'),
      link('queue', 'worker'),
      link('worker', 'db'),
    ],
  };
}

/** Réponse CDN de la vague 3 : les redirections sont servies en bordure. */
export function withCdn(opts: { rateLimitTier?: number; queue?: boolean } = {}): Architecture {
  const nodes: ArchNode[] = [source, { id: 'cdn', type: 'cdn' }, { id: 'app', type: 'app-server' }, { id: 'cache', type: 'cache' }, db];
  const links: ArchLink[] = [link('src', 'cdn')];

  if (opts.rateLimitTier) {
    nodes.push({ id: 'lb', type: 'load-balancer', upgrades: { 'rate-limiting': opts.rateLimitTier } });
    links.push(link('cdn', 'lb'), link('lb', 'app'));
  } else {
    links.push(link('cdn', 'app'));
  }
  links.push(link('app', 'cache'), link('cache', 'db'), link('app', 'db'));

  if (opts.queue) {
    nodes.push({ id: 'queue', type: 'message-queue' }, { id: 'worker', type: 'app-server' });
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
