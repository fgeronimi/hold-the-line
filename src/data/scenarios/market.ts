import type { Scenario, TrafficSource } from '../../engine/types.ts';

const TICKS = 60;
const flat = [{ until: TICKS, factor: 1 }];
/** Le trafic monte au départ et retombe à la fin (décision S11). */
const RAMP = { up: 8, down: 8 };
/**
 * La commande a son propre objectif (M4) : le client veut la sienne validée en 60 ms, et 80
 * commandes sur 1 660 requêtes ne pèseraient pas 5 % des réponses. Un service appelé en
 * direct met ses 200 ms sur le chemin de chaque commande (S10).
 */
const SLA = { maxFailureRate: 0.01, maxP95LatencyMs: 60, maxP95LatencyMsByKind: { async: 60 } };

/**
 * Les trois services des autres équipes, déjà en place de l'autre côté de la rivière
 * (décisions S8, S10) : il reste à leur faire parvenir chaque commande.
 */
const SERVICES = { stock: ['Service stock', 'Magasinier'], billing: ['Service facturation', 'Trésorier'], mail: ['Service e-mail', 'Messager'] } as const;
const CELLS = { stock: { q: 15, r: -3 }, billing: { q: 14, r: 0 }, mail: { q: 13, r: 3 } };
const ALL = Object.keys(SERVICES);

/**
 * Les chalands : ils consultent leurs commandes (lectures), en passent (écritures), et
 * chaque commande passée émet un événement (async) que les services doivent recevoir.
 */
const shoppers = (read: number, orders: number): TrafficSource => ({
  id: 'shoppers',
  clients: 1000,
  rps: { read, write: orders, async: orders },
});

export const market: Scenario = {
  id: 'market',
  title: 'Prise de commande',
  subtitle: 'Hold the Line : le grand marché',
  fixtures: Object.entries(SERVICES).map(([id, [tech, metaphor]]) => ({
    id,
    type: 'domain-service',
    cell: CELLS[id as keyof typeof CELLS],
    fixed: { tech, metaphor },
  })),
  waves: [
    {
      id: 'market-open',
      title: 'Ouverture du marché',
      briefing:
        'La boutique ouvre : 100 commandes par seconde, chacune écrite en base, et chacune émet un événement que le service e-mail, déjà en place, doit recevoir pour envoyer la confirmation. Envoyer un mail prend 200 ms ; le client, lui, veut sa commande validée en moins de 60 ms.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [shoppers(100, 100)],
      sla: SLA,
      budget: 100,
      complexityCap: 5,
      thriftyCost: 95,
      answers: [
        { delivery: 2 },
      ],
      consumers: ['mail'],
      singleStrategy: true,
    },
    {
      id: 'three-trades',
      title: 'Trois services à prévenir',
      briefing:
        'Les services stock et facturation, déjà en place eux aussi, veulent maintenant chaque commande. Chacun des trois services doit recevoir chaque événement.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [shoppers(200, 100)],
      sla: SLA,
      budget: 180,
      complexityCap: 12,
      thriftyCost: 175,
      answers: [
        { delivery: 4 },
      ],
      consumers: ALL,
      singleStrategy: true,
    },
    {
      id: 'double-delivery',
      title: 'Livrés deux fois',
      briefing:
        'Le bus garantit qu’un message arrive au moins une fois… pas exactement une fois. En temps normal, quelques doublons passent déjà ; pendant un pic de relivraisons, une part des messages sera livrée deux fois.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [shoppers(200, 100)],
      sla: SLA,
      budget: 210,
      complexityCap: 15,
      thriftyCost: 205,
      answers: [
        { delivery: 4, idempotence: 1 },
      ],
      consumers: ALL,
      singleStrategy: true,
      incidents: [{ id: 'redelivery', title: 'Pic de relivraisons sur le bus', component: 'pubsub', from: 20, until: 40, effect: { type: 'duplicate-delivery', share: 0.2 } }],
    },
    {
      id: 'lost-orders',
      title: 'Commandes perdues',
      briefing:
        'Le serveur écrit la commande en base, puis publie l’événement. Pendant un incident, il tombera parfois entre les deux.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [shoppers(200, 80)],
      sla: SLA,
      budget: 260,
      complexityCap: 19,
      thriftyCost: 240,
      // Les deux premières gardent l'idempotence de la vague 3 : sans incident de doublon ici elle
      // est superflue (les deux dernières), mais la retirer coûterait une migration au joueur.
      answers: [
        { delivery: 4, idempotence: 1, outbox: 1, cache: 1 },
        { delivery: 4, idempotence: 1, outbox: 1, replicas: 1 },
        { delivery: 4, outbox: 1, cache: 1 },
        { delivery: 4, outbox: 1, replicas: 1 },
      ],
      consumers: ALL,
      incidents: [{ id: 'crash-before-publish', title: 'Le serveur tombe avant de publier', component: 'app-server', from: 20, until: 35, effect: { type: 'publish-loss', share: 0.3 } }],
    },
    {
      id: 'poison-order',
      title: 'Une commande empoisonnée',
      briefing:
        'Une nouvelle version de l’application mobile envoie, pendant cinq minutes, des commandes mal formées : 5 % des commandes de ce moment-là font planter chaque service qui les lit. La file les relivre tant qu’elles ne sont pas traitées.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [shoppers(200, 80)],
      sla: SLA,
      budget: 275,
      complexityCap: 22,
      thriftyCost: 190,
      // Les quatre premières gardent l'architecture de la vague 4 : sans ses incidents ici,
      // outbox, cache et réplica sont superflus, mais les retirer coûterait une migration.
      answers: [
        { delivery: 4, idempotence: 1, outbox: 1, cache: 1, deadLetter: 1 },
        { delivery: 4, idempotence: 1, outbox: 1, replicas: 1, deadLetter: 1 },
        { delivery: 4, outbox: 1, cache: 1, deadLetter: 1 },
        { delivery: 4, outbox: 1, replicas: 1, deadLetter: 1 },
        { delivery: 4, deadLetter: 1 },
      ],
      consumers: ALL,
      singleStrategy: true,
      incidents: [{ id: 'poison', title: 'Des commandes mal formées', component: 'message-queue', from: 30, until: 35, effect: { type: 'poison-message', share: 0.05 } }],
    },
    {
      id: 'sales',
      title: 'Les soldes',
      briefing:
        'Les soldes commencent : 1 500 consultations de commandes par seconde, 80 commandes par seconde, et les trois incidents connus peuvent revenir à tout moment.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [shoppers(1500, 80)],
      sla: SLA,
      budget: 325,
      complexityCap: 25,
      thriftyCost: 320,
      answers: [
        { delivery: 4, scaling: 1, idempotence: 1, outbox: 1, cache: 1, replicas: 1, deadLetter: 1 },
      ],
      consumers: ALL,
      // Ni le cache ni le réplica de la vague 4 ne suffisent seuls : l'outbox double les écritures,
      // et les lectures qui ratent le cache, avec les écritures, plus de 5 % des requêtes,
      // attendent une base chargée (M4).
      singleStrategy: true,
      incidents: [
        // Plus forts qu'aux vagues 3 et 4 : noyés dans 1 500 lectures par seconde, ils doivent encore compter.
        { id: 'sales-redelivery', title: 'Pic de relivraisons sur le bus', component: 'pubsub', from: 10, until: 30, effect: { type: 'duplicate-delivery', share: 0.3 } },
        { id: 'sales-crash', title: 'Le serveur tombe avant de publier', component: 'app-server', from: 30, until: 50, effect: { type: 'publish-loss', share: 0.8 } },
        { id: 'sales-poison', title: 'Des commandes mal formées', component: 'message-queue', from: 20, until: 25, effect: { type: 'poison-message', share: 0.05 } },
      ],
    },
  ],
};
