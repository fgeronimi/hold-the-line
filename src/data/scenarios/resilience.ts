import type { Scenario, TrafficSource } from '../../engine/types.ts';

const TICKS = 60;
const flat = [{ until: TICKS, factor: 1 }];
/** Le trafic monte au départ et retombe à la fin (décision S11). */
const RAMP = { up: 8, down: 8 };
const SLA = { maxFailureRate: 0.01, maxP95LatencyMs: 60 };

/**
 * Les clients consultent leurs commandes (lectures) et en passent (écritures) ; chaque
 * commande est payée auprès du prestataire (l'événement async, décision S13). Payé en
 * direct, le client attend la réponse de la banque ; par une file, le paiement est différé.
 */
const customers = (read: number, orders: number): TrafficSource => ({
  id: 'customers',
  clients: 1000,
  rps: { read, write: orders, async: orders },
});

export const resilience: Scenario = {
  id: 'resilience',
  title: 'Le comptoir des paiements',
  subtitle: 'Hold the Line : le banquier lombard',
  // Le prestataire de paiement est déjà là, hors de la cité, de l'autre côté de la rivière.
  fixtures: [{ id: 'bank', type: 'payment-provider', cell: { q: 14, r: 0 }, fixed: { tech: 'Prestataire de paiement', metaphor: 'Banquier lombard' } }],
  waves: [
    {
      id: 'checkout',
      title: 'Le paiement en ligne',
      briefing:
        'La boutique encaisse : 300 consultations de commandes et 30 commandes par seconde. Chaque commande est écrite en base et payée auprès du prestataire de paiement, déjà en place, qui répond en 30 ms.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [customers(300, 30)],
      sla: SLA,
      budget: 80,
      complexityCap: 4,
      thriftyCost: 70,
      singleStrategy: true,
    },
    {
      id: 'slow-banker',
      title: 'Le banquier traîne',
      briefing:
        'Même trafic. Mais pendant quelques secondes, le prestataire mettra 4 secondes à répondre à chaque paiement. Le serveur traite 100 requêtes à la fois par instance.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [customers(300, 30)],
      sla: SLA,
      budget: 100,
      complexityCap: 7,
      thriftyCost: 80,
      incidents: [{ id: 'banker-slow', title: 'Le banquier fait attendre chaque paiement', component: 'payment-provider', from: 25, until: 29, effect: { type: 'slow-dependency', latencyMs: 4000 } }],
    },
    {
      id: 'midnight-expiry',
      title: 'Minuit, tout expire',
      briefing:
        'Les clients consultent beaucoup plus leurs commandes : 900 lectures par seconde, pour une base qui en tient 600. Et à minuit, toutes les entrées du cache expirent en même temps.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [customers(900, 30)],
      sla: SLA,
      budget: 125,
      complexityCap: 10,
      thriftyCost: 90,
      incidents: [{ id: 'midnight', title: 'Tout le cache expire à minuit', component: 'cache', from: 30, until: 32, effect: { type: 'cache-stampede', herd: 4 } }],
    },
    {
      id: 'banker-closed',
      title: 'Le banquier ferme',
      briefing:
        'Le prestataire de paiement tombera en panne pendant une longue partie de la vague. Les commandes, elles, continuent d’arriver.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [customers(900, 30)],
      sla: SLA,
      budget: 140,
      complexityCap: 12,
      thriftyCost: 110,
      incidents: [{ id: 'banker-down', title: 'Le banquier ferme boutique', component: 'payment-provider', from: 15, until: 40, effect: { type: 'dependency-down' } }],
    },
    {
      id: 'fair',
      title: 'La grande foire',
      briefing:
        'La foire : 2 400 lectures et 60 commandes par seconde. Le banquier traînera, et le cache expirera d’un coup, comme avant.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [customers(2400, 60)],
      sla: SLA,
      budget: 250,
      complexityCap: 18,
      thriftyCost: 230,
      incidents: [
        { id: 'fair-slow', title: 'Le banquier fait attendre chaque paiement', component: 'payment-provider', from: 15, until: 19, effect: { type: 'slow-dependency', latencyMs: 4000 } },
        { id: 'fair-midnight', title: 'Tout le cache expire d’un coup', component: 'cache', from: 35, until: 37, effect: { type: 'cache-stampede', herd: 4 } },
      ],
    },
  ],
};
