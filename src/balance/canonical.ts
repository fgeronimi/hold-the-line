import type { ArchLink, ArchNode, Architecture } from '../engine/types.ts';

/**
 * Bornes de l'énumération (décision B3). Chaque composant a une place fixe dans le
 * schéma de référence ; seuls varient sa présence et ses niveaux d'évolution.
 */
export interface SearchSpace {
  maxExtraInstances: number;
  maxReplicas: number;
  rateLimitTiers: number;
  maxExtraWorkers: number;
  /** Plafonds d'autoscaling essayés ; 0 = pas d'autoscaling. */
  autoscalingLevels: number[];
}

export interface CanonicalChoice {
  cdn: boolean;
  loadBalancer: boolean;
  autoscaling: number;
  extraInstances: number;
  rateLimitTier: number;
  cache: boolean;
  replicas: number;
  queue: boolean;
  extraWorkers: number;
}

export interface Candidate {
  choice: CanonicalChoice;
  arch: Architecture;
  /** Décision B2 : composants et évolutions activés, niveaux ignorés. */
  strategy: string;
  parts: string[];
}

const link = (from: string, to: string): ArchLink => ({ from, to });

export function buildCanonical(c: CanonicalChoice): Architecture {
  const nodes: ArchNode[] = [{ id: 'src', type: 'traffic-source' }];
  const links: ArchLink[] = [];

  let entry = 'src';
  if (c.cdn) {
    nodes.push({ id: 'cdn', type: 'cdn' });
    links.push(link('src', 'cdn'));
    entry = 'cdn';
  }
  if (c.loadBalancer) {
    nodes.push({ id: 'lb', type: 'load-balancer', upgrades: { 'rate-limiting': c.rateLimitTier } });
    links.push(link(entry, 'lb'), link('lb', 'app'));
  } else {
    links.push(link(entry, 'app'));
  }
  nodes.push({
    id: 'app',
    type: 'app-server',
    upgrades: { 'horizontal-scaling': c.extraInstances, autoscaling: c.autoscaling },
  });
  nodes.push({ id: 'db', type: 'database', upgrades: { 'read-replica': c.replicas } });

  // Le serveur est toujours relié à la base ; le routage envoie les lectures au cache
  // et l'async à la file quand ils sont là.
  links.push(link('app', 'db'));
  if (c.cache) {
    nodes.push({ id: 'cache', type: 'cache' });
    links.push(link('app', 'cache'), link('cache', 'db'));
  }
  if (c.queue) {
    nodes.push(
      { id: 'queue', type: 'message-queue' },
      { id: 'worker', type: 'app-server', upgrades: { 'horizontal-scaling': c.extraWorkers } },
    );
    links.push(link('app', 'queue'), link('queue', 'worker'), link('worker', 'db'));
  }

  return { nodes, links };
}

export function strategyParts(c: CanonicalChoice): string[] {
  return [
    c.cdn && 'CDN',
    c.loadBalancer && 'load balancer',
    c.extraInstances > 0 && 'scaling',
    c.autoscaling > 0 && 'autoscaling',
    c.rateLimitTier > 0 && 'rate limiting',
    c.cache && 'cache',
    c.replicas > 0 && 'réplica',
    c.queue && 'file',
  ].filter((p): p is string => typeof p === 'string');
}

export function strategyName(parts: string[]): string {
  return parts.length > 0 ? parts.join(' + ') : 'serveur + base';
}

/** Tout au maximum : la réponse sur-dimensionnée type, qui doit perdre partout. */
export function maxedChoice(space: SearchSpace): CanonicalChoice {
  return {
    cdn: true,
    loadBalancer: true,
    autoscaling: Math.max(...space.autoscalingLevels),
    extraInstances: space.maxExtraInstances,
    rateLimitTier: space.rateLimitTiers,
    cache: true,
    replicas: space.maxReplicas,
    queue: true,
    extraWorkers: space.maxExtraWorkers,
  };
}

export function choiceKey(c: CanonicalChoice): string {
  return [c.cdn, c.loadBalancer, c.autoscaling, c.extraInstances, c.rateLimitTier, c.cache, c.replicas, c.queue, c.extraWorkers].join('|');
}

/**
 * Les architectures obtenues en retirant un seul élément, avec ce qui en dépend :
 * retirer le load balancer retire aussi le scaling, l'autoscaling et le rate limiting.
 */
export function reductions(c: CanonicalChoice): CanonicalChoice[] {
  const out: CanonicalChoice[] = [];
  if (c.cdn) out.push({ ...c, cdn: false });
  if (c.loadBalancer) out.push({ ...c, loadBalancer: false, extraInstances: 0, autoscaling: 0, rateLimitTier: 0 });
  if (c.extraInstances > 0) out.push({ ...c, extraInstances: 0 });
  if (c.autoscaling > 0) out.push({ ...c, autoscaling: 0 });
  if (c.rateLimitTier > 0) out.push({ ...c, rateLimitTier: 0 });
  if (c.cache) out.push({ ...c, cache: false });
  if (c.replicas > 0) out.push({ ...c, replicas: 0 });
  if (c.queue) out.push({ ...c, queue: false, extraWorkers: 0 });
  return out;
}

/** Toutes les architectures canoniques valides de l'espace, sans doublon. */
export function* enumerate(space: SearchSpace): Generator<Candidate> {
  for (const cdn of [false, true]) for (const loadBalancer of [false, true]) {
    // Sans load balancer, ni scaling, ni autoscaling, ni rate limiting ne sont possibles.
    const instanceRange = loadBalancer ? space.maxExtraInstances : 0;
    const tierRange = loadBalancer ? space.rateLimitTiers : 0;
    const autoLevels = loadBalancer ? space.autoscalingLevels : [0];
    for (const autoscaling of autoLevels)
    for (let extraInstances = 0; extraInstances <= instanceRange; extraInstances++) {
      for (let rateLimitTier = 0; rateLimitTier <= tierRange; rateLimitTier++) {
        for (const cache of [false, true]) {
          for (let replicas = 0; replicas <= space.maxReplicas; replicas++) {
            for (const queue of [false, true]) {
              for (let extraWorkers = 0; extraWorkers <= (queue ? space.maxExtraWorkers : 0); extraWorkers++) {
                const choice = { cdn, loadBalancer, autoscaling, extraInstances, rateLimitTier, cache, replicas, queue, extraWorkers };
                const parts = strategyParts(choice);
                yield { choice, arch: buildCanonical(choice), strategy: strategyName(parts), parts };
              }
            }
          }
        }
      }
    }
  }
}
