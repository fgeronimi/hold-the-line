import type { Scenario, TrafficSource } from '../../engine/types.ts';

const TICKS = 60;
const flat = [{ until: TICKS, factor: 1 }];
/** Le trafic monte au départ et retombe à la fin (décision S11). */
const RAMP = { up: 8, down: 8 };
const SLA = { maxFailureRate: 0.01, maxP95LatencyMs: 60 };
/** Comme tous les clients, ceux de la billetterie relancent ce qui échoue (décision S19). */
const RETRIES = 3;

/**
 * Les spectateurs consultent les tournois (lectures), achètent des places (écritures) ; chaque
 * achat envoie son billet par e-mail (l'événement async), au prestataire d'e-mail déjà en place.
 */
const fans = (read: number, buys: number, o: { longTail?: boolean } = {}): TrafficSource => ({
  id: 'fans',
  clients: 1000,
  retries: RETRIES,
  ...(o.longTail ? { longTail: true } : {}),
  rps: { read, write: buys, async: buys },
});

/** Les abonnés aux alertes : un e-mail chaque fois qu'une place se libère, rien d'autre. */
const alerts = (rps: number): TrafficSource => ({ id: 'alerts', clients: 1000, rps: { async: rps } });

/** Les places restantes : une donnée qui doit être à jour, jamais servie d'un cache ni d'un réplica coupé (S21). */
const seats = (read: number): TrafficSource => ({ id: 'seats', clients: 1000, retries: RETRIES, consistent: true, rps: { read } });

export const tournament: Scenario = {
  id: 'tournament',
  title: 'La billetterie du tournoi',
  subtitle: 'Hold the Line : le grand tournoi',
  // Le prestataire d'e-mail est déjà là, de l'autre côté de la rivière, avec son quota.
  fixtures: [{ id: 'mail', type: 'mail-provider', cell: { q: 13, r: 3 }, fixed: { tech: 'Prestataire d’e-mail', metaphor: 'Colombier' } }],
  waves: [
    {
      id: 'ticket-rush',
      title: 'L’ouverture des ventes',
      briefing:
        'Les ventes ouvrent : 1 600 consultations et 50 achats par seconde, chaque billet envoyé par e-mail au prestataire, qui en accepte 10 000 par seconde. Un déploiement raté arrêtera tous les serveurs trois secondes. Et les clients relancent aussitôt, jusqu’à trois fois, ce qui échoue.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [fans(1600, 50)],
      sla: SLA,
      budget: 150,
      complexityCap: 11,
      thriftyCost: 145,
      answers: [
        { backoff: 1, scaling: 1, cache: 1, queue: 1 },
        { scaling: 1, autoscaling: 3, cache: 1, queue: 1 },
        { backoff: 1, autoscaling: 3, cache: 1, queue: 1 },
      ],
      consumers: ['mail'],
      incidents: [{ id: 'bad-deploy', title: 'Un déploiement raté redémarre tous les guichetiers', component: 'app-server', from: 20, until: 23, effect: { type: 'instance-down', count: 10 } }],
    },
    {
      id: 'pigeons-grounded',
      title: 'Les pigeons restent au colombier',
      briefing:
        'Le prestataire d’e-mail tombe en panne pendant une demi-minute. Les achats continuent, 100 par seconde, et les abonnés aux alertes de places reçoivent 8 000 e-mails par seconde. Une file de messages garde 200 000 messages avant de déborder.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [fans(1000, 100), alerts(8000)],
      sla: SLA,
      budget: 150,
      complexityCap: 11,
      thriftyCost: 145,
      answers: [
        { scaling: 1, cache: 1, queue: 1, retention: 1 },
        { autoscaling: 3, cache: 1, queue: 1, retention: 1 },
      ],
      consumers: ['mail'],
      incidents: [{ id: 'mail-down', title: 'Le colombier est fermé', component: 'mail-provider', from: 15, until: 45, effect: { type: 'dependency-down' } }],
    },
    {
      id: 'split-registry',
      title: 'Le registre coupé en deux',
      briefing:
        'Les spectateurs cherchent leurs dates (1 000 lectures par seconde, chacune différente : aucun cache n’y aide) et regardent les places restantes (300 par seconde), qui doivent être à jour. Pendant un moment, les réplicas de la base seront coupés du primaire.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [fans(1000, 60, { longTail: true }), seats(300)],
      sla: SLA,
      budget: 230,
      complexityCap: 13,
      thriftyCost: 210,
      answers: [
        { scaling: 1, replicas: 2, leaderReads: 1, queue: 1 },
        { autoscaling: 3, replicas: 2, leaderReads: 1, queue: 1 },
      ],
      consumers: ['mail'],
      incidents: [{ id: 'partition', title: 'Les copistes n’entendent plus le grand registre', component: 'database', from: 20, until: 35, effect: { type: 'partition' } }],
    },
    {
      id: 'final-joust',
      title: 'La joute finale',
      briefing:
        'La finale : 2 000 consultations, 300 regards sur les places et 50 achats par seconde. Une tour tombera, le colombier fermera, le registre sera coupé : tout ce que vous avez appris, ensemble.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [fans(2000, 50), seats(300)],
      sla: SLA,
      budget: 250,
      complexityCap: 14,
      thriftyCost: 245,
      answers: [
        { backoff: 1, scaling: 3, cache: 1, replicas: 1, leaderReads: 1, queue: 1 },
        { autoscaling: 3, cache: 1, replicas: 1, leaderReads: 1, queue: 1 },
        // Les deux réplicas de la vague 3 gardés : seule réponse sans retrait de réplica, et
        // donc sans les 40 de migration qui rendaient la vague ingagnable après une vague 3 gagnée.
        { autoscaling: 3, cache: 1, replicas: 2, leaderReads: 1, queue: 1 },
      ],
      consumers: ['mail'],
      incidents: [
        { id: 'final-crash', title: 'Un déploiement raté redémarre tous les guichetiers', component: 'app-server', from: 12, until: 15, effect: { type: 'instance-down', count: 10 } },
        { id: 'final-mail-down', title: 'Le colombier est fermé', component: 'mail-provider', from: 20, until: 40, effect: { type: 'dependency-down' } },
        { id: 'final-partition', title: 'Les copistes n’entendent plus le grand registre', component: 'database', from: 42, until: 52, effect: { type: 'partition' } },
      ],
    },
  ],
};
