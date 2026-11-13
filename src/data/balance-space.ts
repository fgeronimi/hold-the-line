import { upTo, type BalanceSpace, type Choice } from '../balance/canonical.ts';
import type { ArchLink, ArchNode, Architecture, Scenario } from '../engine/types.ts';
import { catalog } from './catalog.ts';
import { DELIVERIES, ordering } from './scenarios/market.archetypes.ts';
import { market } from './scenarios/market.ts';
import { checkout } from './scenarios/resilience.archetypes.ts';
import { resilience } from './scenarios/resilience.ts';
import { boxOffice } from './scenarios/tournament.archetypes.ts';
import { tournament } from './scenarios/tournament.ts';
import { urlShortener } from './scenarios/url-shortener.ts';

/**
 * Les espaces d'architectures de `npm run balance`, un par scénario. Chacun énumère les
 * combinaisons de son schéma de référence ; les bornes sont larges pour qu'une réponse
 * imprévue, trouvée par un joueur, y soit déjà.
 */

const levels = (id: string) => catalog.upgrades[id]?.maxLevel ?? 0;
const link = (from: string, to: string): ArchLink => ({ from, to });
const on = (c: Choice, id: string) => (c[id] ?? 0) > 0;

/**
 * Le raccourcisseur : CDN, passerelle d'API et ses limites par classe, load balancer et ses
 * évolutions, cache, réplicas, file et workers. La passerelle se pose derrière le CDN, devant
 * le load balancer : les lectures des partenaires, que le CDN ne garde pas, y arrivent toutes.
 */
function shortener(c: Choice): Architecture {
  const nodes: ArchNode[] = [{ id: 'src', type: 'traffic-source' }];
  const links: ArchLink[] = [];

  let entry = 'src';
  if (on(c, 'cdn')) {
    nodes.push({ id: 'cdn', type: 'cdn' });
    links.push(link('src', 'cdn'));
    entry = 'cdn';
  }
  if (on(c, 'gateway')) {
    nodes.push({ id: 'gateway', type: 'api-gateway', upgrades: { 'partner-quota': c.partnerQuota ?? 0, 'anonymous-quota': c.anonymousQuota ?? 0 } });
    links.push(link(entry, 'gateway'));
    entry = 'gateway';
  }
  if (on(c, 'lb')) {
    nodes.push({ id: 'lb', type: 'load-balancer', upgrades: { 'rate-limiting': c.rateLimit ?? 0 } });
    links.push(link(entry, 'lb'), link('lb', 'app'));
  } else {
    links.push(link(entry, 'app'));
  }
  nodes.push(
    { id: 'app', type: 'app-server', upgrades: { 'horizontal-scaling': c.scaling ?? 0, autoscaling: c.autoscaling ?? 0 } },
    { id: 'db', type: 'database', upgrades: { 'read-replica': c.replicas ?? 0 } },
  );
  // Le serveur est toujours relié à la base ; il consulte le cache quand il est là, et
  // le routage envoie l'async à la file quand elle est là.
  links.push(link('app', 'db'));
  if (on(c, 'cache')) {
    nodes.push({ id: 'cache', type: 'cache', upgrades: { 'request-coalescing': c.coalescing ?? 0 } });
    links.push(link('app', 'cache'));
  }
  if (on(c, 'queue')) {
    nodes.push(
      { id: 'queue', type: 'message-queue' },
      { id: 'worker', type: 'worker', upgrades: { 'worker-scaling': c.workers ?? 0 } },
    );
    links.push(link('app', 'queue'), link('queue', 'worker'), link('worker', 'db'));
  }
  return { nodes, links };
}

export const shortenerSpace: BalanceSpace = {
  dimensions: [
    { id: 'cdn', levels: [0, 1], label: 'CDN' },
    { id: 'lb', levels: [0, 1], label: 'load balancer' },
    { id: 'scaling', levels: upTo(levels('horizontal-scaling')), label: 'scaling', requires: 'lb' },
    { id: 'autoscaling', levels: [0, 3, 6], label: 'autoscaling', requires: 'lb' },
    { id: 'rateLimit', levels: upTo(levels('rate-limiting')), label: 'rate limiting', requires: 'lb' },
    // Seulement devant un load balancer sans limite unique (C7) : avec elle, la passerelle ne
    // gagne rien ou coupe les mêmes partenaires, et sans load balancer, pas de scaling. Les
    // paliers essayés : 80 coupe les partenaires de la vague 5, 160 non ; au-delà de 40, la
    // limite des anonymes laisse passer tout le scraper, comme aucune limite.
    { id: 'gateway', levels: [0, 1], label: 'passerelle d’API', requires: 'lb', excludes: 'rateLimit' },
    { id: 'partnerQuota', levels: [0, 4, 5], label: 'quota par clé', requires: 'gateway' },
    { id: 'anonymousQuota', levels: upTo(3), label: 'limite par adresse', requires: 'gateway' },
    { id: 'cache', levels: [0, 1], label: 'cache' },
    { id: 'coalescing', levels: [0, 1], label: 'verrou de recalcul', requires: 'cache' },
    { id: 'replicas', levels: upTo(levels('read-replica')), label: 'réplica' },
    { id: 'queue', levels: [0, 1], label: 'file' },
    { id: 'workers', levels: upTo(2), requires: 'queue' },
  ],
  build: shortener,
};

const DELIVERY_LABELS: Record<(typeof DELIVERIES)[number], string | undefined> = {
  none: undefined,
  inline: 'e-mail en direct',
  queue: 'file',
  'shared-queue': 'file partagée',
  pubsub: 'pub/sub',
  'pubsub-direct': 'pub/sub sans files',
};

export const marketSpace: BalanceSpace = {
  dimensions: [
    { id: 'delivery', levels: upTo(DELIVERIES.length - 1), label: DELIVERIES.map((d) => DELIVERY_LABELS[d] ?? '') },
    { id: 'scaling', levels: upTo(3), label: 'scaling' },
    { id: 'idempotence', levels: [0, 1], label: 'idempotence' },
    { id: 'outbox', levels: [0, 1], label: 'outbox' },
    { id: 'cache', levels: [0, 1], label: 'cache' },
    { id: 'replicas', levels: upTo(3), label: 'réplica' },
    // Sur chaque file : sans livraison, il n'y a pas de file à protéger.
    { id: 'deadLetter', levels: [0, 1], label: 'lettres mortes', requires: 'delivery' },
  ],
  build: (c) =>
    ordering(DELIVERIES[c.delivery ?? 0]!, {
      deadLetter: on(c, 'deadLetter'),
      extraInstances: c.scaling ?? 0,
      idempotence: on(c, 'idempotence'),
      outbox: on(c, 'outbox'),
      cache: on(c, 'cache'),
      replicas: c.replicas ?? 0,
    }),
};

export const resilienceSpace: BalanceSpace = {
  dimensions: [
    { id: 'scaling', levels: upTo(3), label: 'scaling' },
    { id: 'timeout', levels: [0, 1], label: 'délai d’attente' },
    { id: 'breaker', levels: [0, 1], label: 'circuit breaker' },
    { id: 'queue', levels: [0, 1], label: 'file' },
    { id: 'cache', levels: [0, 1], label: 'cache' },
    { id: 'coalescing', levels: [0, 1], label: 'verrou de recalcul', requires: 'cache' },
    { id: 'replicas', levels: upTo(3), label: 'réplica' },
  ],
  build: (c) =>
    checkout({
      extraInstances: c.scaling ?? 0,
      timeout: on(c, 'timeout'),
      breaker: on(c, 'breaker'),
      queue: on(c, 'queue'),
      cache: on(c, 'cache'),
      coalescing: on(c, 'coalescing'),
      replicas: c.replicas ?? 0,
    }),
};

export const tournamentSpace: BalanceSpace = {
  dimensions: [
    { id: 'backoff', levels: [0, 1], label: 'backoff' },
    { id: 'shedding', levels: [0, 1], label: 'délestage' },
    { id: 'scaling', levels: upTo(4), label: 'scaling' },
    { id: 'autoscaling', levels: [0, 3, 6], label: 'autoscaling' },
    { id: 'cache', levels: [0, 1], label: 'cache' },
    { id: 'replicas', levels: upTo(3), label: 'réplica' },
    { id: 'leaderReads', levels: [0, 1], label: 'lecture au primaire', requires: 'replicas' },
    // Sans file, le serveur envoie les billets en direct au prestataire.
    { id: 'queue', levels: [0, 1], label: 'file' },
    { id: 'retention', levels: upTo(3), label: 'capacité de file', requires: 'queue' },
  ],
  build: (c) =>
    boxOffice({
      backoff: on(c, 'backoff'),
      shedding: on(c, 'shedding'),
      extraInstances: c.scaling ?? 0,
      autoscaling: c.autoscaling ?? 0,
      cache: on(c, 'cache'),
      replicas: c.replicas ?? 0,
      leaderReads: on(c, 'leaderReads'),
      queue: on(c, 'queue'),
      retention: c.retention ?? 0,
    }),
};

export const balanceSpaces: { scenario: Scenario; space: BalanceSpace }[] = [
  { scenario: urlShortener, space: shortenerSpace },
  { scenario: market, space: marketSpace },
  { scenario: resilience, space: resilienceSpace },
  { scenario: tournament, space: tournamentSpace },
];

/** L'espace d'un scénario, par son id. */
export function spaceOf(scenarioId: string): BalanceSpace {
  const found = balanceSpaces.find((b) => b.scenario.id === scenarioId);
  if (!found) throw new Error(`Scénario sans espace d'équilibrage : ${scenarioId}`);
  return found.space;
}

/**
 * Les architectures des réponses attendues d'une vague (`Wave.answers`), construites par
 * l'espace du scénario : une seule définition de « la réponse » pour les tests, l'aide et
 * l'équilibrage. Vide si la vague n'en déclare pas.
 */
export function answersOf(scenarioId: string, waveIndex: number): Architecture[] {
  const found = balanceSpaces.find((b) => b.scenario.id === scenarioId);
  if (!found) throw new Error(`Scénario sans espace d'équilibrage : ${scenarioId}`);
  const wave = found.scenario.waves[waveIndex];
  if (!wave) throw new Error(`Vague ${waveIndex} inconnue dans ${scenarioId}`);
  return (wave.answers ?? []).map((choice) => found.space.build(choice));
}
