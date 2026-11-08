import type { ArchLink, ArchNode, Architecture, RequestKind } from '../../engine/types.ts';

/**
 * Architectures types du raccourcisseur, servant aux tests et à la simulation en masse.
 * Chacune correspond à la réponse attendue d'une vague, ou à son absence.
 */

const link = (from: string, to: string, ...kinds: RequestKind[]): ArchLink => ({ from, to, kinds });

const source = { id: 'src', type: 'traffic-source' };
const db = { id: 'db', type: 'database' };

export const minimal: Architecture = {
  nodes: [source, { id: 'app', type: 'app-server' }, db],
  links: [link('src', 'app', 'read', 'write'), link('app', 'db', 'read', 'write')],
};

export const noDatabase: Architecture = {
  nodes: [source, { id: 'app', type: 'app-server' }],
  links: [link('src', 'app', 'read', 'write')],
};

export const withCache: Architecture = {
  nodes: [source, { id: 'app', type: 'app-server' }, { id: 'cache', type: 'cache' }, db],
  links: [
    link('src', 'app', 'read', 'write'),
    link('app', 'cache', 'read'),
    link('cache', 'db', 'read'),
    link('app', 'db', 'write'),
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
      link('src', 'lb', 'read', 'write', 'async'),
      link('lb', 'app', 'read', 'write', 'async'),
      link('app', 'cache', 'read'),
      link('cache', 'db', 'read'),
      link('app', 'db', 'write'),
    ],
  };
}

/** Palier à 40 req/s par client : au-dessus des partenaires (30), bien sous le scraper (1 000). */
export const TIER_40 = 3;

/** Clics écrits directement en base, sur le chemin de la redirection. */
export function inlineClicks(extraInstances: number): Architecture {
  const base = scaled(extraInstances, { rateLimitTier: TIER_40 });
  return { nodes: base.nodes, links: [...base.links, link('app', 'db', 'async')] };
}

export function queuedClicks(extraInstances: number): Architecture {
  const base = scaled(extraInstances, { rateLimitTier: TIER_40 });
  return {
    nodes: [...base.nodes, { id: 'queue', type: 'message-queue' }, { id: 'worker', type: 'app-server' }],
    links: [
      ...base.links,
      link('app', 'queue', 'async'),
      link('queue', 'worker', 'async'),
      link('worker', 'db', 'async'),
    ],
  };
}

/** Réponse CDN de la vague 3 : les redirections sont servies en bordure. */
export function withCdn(opts: { rateLimitTier?: number; queue?: boolean } = {}): Architecture {
  const all: RequestKind[] = ['read', 'write', 'async'];
  const nodes: ArchNode[] = [source, { id: 'cdn', type: 'cdn' }, { id: 'app', type: 'app-server' }, { id: 'cache', type: 'cache' }, db];
  const links: ArchLink[] = [link('src', 'cdn', ...all)];

  if (opts.rateLimitTier) {
    nodes.push({ id: 'lb', type: 'load-balancer', upgrades: { 'rate-limiting': opts.rateLimitTier } });
    links.push(link('cdn', 'lb', ...all), link('lb', 'app', ...all));
  } else {
    links.push(link('cdn', 'app', ...all));
  }
  links.push(link('app', 'cache', 'read'), link('cache', 'db', 'read'), link('app', 'db', 'write'));

  if (opts.queue) {
    nodes.push({ id: 'queue', type: 'message-queue' }, { id: 'worker', type: 'app-server' });
    links.push(link('app', 'queue', 'async'), link('queue', 'worker', 'async'), link('worker', 'db', 'async'));
  } else {
    links.push(link('app', 'db', 'async'));
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
