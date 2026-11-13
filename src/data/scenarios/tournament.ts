import type { Scenario, TrafficSource } from '../../engine/types.ts';

const TICKS = 60;
const flat = [{ until: TICKS, factor: 1 }];
/** Le trafic monte au départ et retombe à la fin (décision S11). */
const RAMP = { up: 8, down: 8 };
/**
 * L'envoi du billet a son propre objectif (M4) : 50 achats sur 1 700 requêtes ne pèseraient pas
 * 5 % des réponses, et un prestataire d'e-mail appelé en direct met ses 200 ms sur chaque achat.
 */
const SLA = { maxFailureRate: 0.01, maxP95LatencyMs: 60, maxP95LatencyMsByKind: { async: 60 } };
/**
 * Comme tous les clients, ceux de la billetterie relancent ce qui échoue (décision S19) : cinq
 * fois, de quoi couvrir les cinq minutes d'un déploiement raté (SC7).
 */
const RETRIES = 5;

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

/**
 * La vérification qu'une place est libre, au moment d'acheter : une donnée qui doit être à jour,
 * jamais servie d'un cache ni d'un réplica coupé (S21). Afficher un nombre de places un peu
 * périmé serait bénin ; confirmer une place déjà vendue ne l'est pas.
 */
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
        'Les ventes ouvrent : 1 600 consultations et 50 achats par seconde, chaque billet envoyé par e-mail au prestataire, qui en accepte 10 000 par seconde. Un déploiement raté arrêtera tous les serveurs cinq minutes. Et les clients relancent aussitôt, jusqu’à cinq fois, ce qui échoue : ces clients sont votre application, vous en écrivez le code, c’est pourquoi vous pouvez y régler les relances.',
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
        // La parade que l'opérateur possède, même quand les clients ne sont pas les siens (M11) :
        // la porte refuse ce que les serveurs ne serviront pas, la tempête se vide en dix minutes.
        { shedding: 1, scaling: 1, cache: 1, queue: 1 },
        // Plus d'autoscaling depuis SC7 : après cinq minutes de panne, le surplus des relances
        // arrive plus vite que les instances ne démarrent, et le plafond coûte plus que le budget.
      ],
      consumers: ['mail'],
      incidents: [{ id: 'bad-deploy', title: 'Un déploiement raté redémarre tous les guichetiers', component: 'app-server', from: 20, until: 25, effect: { type: 'instance-down', count: 10 } }],
    },
    {
      id: 'pigeons-grounded',
      title: 'Les pigeons restent au colombier',
      briefing:
        'Le prestataire d’e-mail tombe en panne pendant une demi-heure. Les achats continuent, 100 par seconde, et les abonnés aux alertes de places reçoivent 8 000 e-mails par seconde. Une file de messages garde 200 000 messages avant de déborder (à l’échelle du jeu : ce plafond se lit en minutes de trafic, arrivées par seconde × minutes d’attente).',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [fans(1000, 100), alerts(8000)],
      sla: SLA,
      // 155 : depuis la réponse « délestage » de la vague 1, garder ou couper le délestage coûte
      // 10 de plus ; à 150, la réponse que l'aide conseille menait dans le mur (M11). L'autoscaling
      // y regagne, plus cher que l'instance fixe (M9b) : l'étoile d'économie reste au scaling.
      budget: 155,
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
        'Les spectateurs cherchent leurs dates (1 000 lectures par seconde, chacune différente : aucun cache n’y aide) et, avant chaque achat, vérifient que la place est encore libre (300 vérifications par seconde) : une réponse qui doit être à jour, sinon la même place est promise à deux spectateurs. Pendant un quart d’heure, les réplicas de la base seront coupés du primaire. En vrai, la garantie finale contre la double vente est une réservation atomique à l’écriture ; la vérification, elle, ne doit pas mentir.',
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
        'La finale : 2 000 consultations, 300 vérifications de places et 50 achats par seconde. Une tour tombera, le colombier fermera, le registre sera coupé : tout ce que vous avez appris, ensemble.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [fans(2000, 50), seats(300)],
      sla: SLA,
      // 255 : depuis la réponse autoscaling de la vague 3, garder ses deux réplicas et passer en
      // instances fixes coûte 250, plus 5 pour couper l'autoscaling (M2, M9b).
      budget: 255,
      complexityCap: 14,
      thriftyCost: 245,
      answers: [
        { backoff: 1, scaling: 2, cache: 1, replicas: 1, leaderReads: 1, queue: 1 },
        { backoff: 1, scaling: 1, autoscaling: 3, cache: 1, replicas: 1, leaderReads: 1, queue: 1 },
        // Les deux réplicas de la vague 3 gardés : la suite la plus directe d'une vague 3 gagnée.
        { backoff: 1, scaling: 2, cache: 1, replicas: 2, leaderReads: 1, queue: 1 },
      ],
      consumers: ['mail'],
      incidents: [
        { id: 'final-crash', title: 'Un déploiement raté redémarre tous les guichetiers', component: 'app-server', from: 12, until: 17, effect: { type: 'instance-down', count: 10 } },
        { id: 'final-mail-down', title: 'Le colombier est fermé', component: 'mail-provider', from: 20, until: 40, effect: { type: 'dependency-down' } },
        { id: 'final-partition', title: 'Les copistes n’entendent plus le grand registre', component: 'database', from: 42, until: 52, effect: { type: 'partition' } },
      ],
    },
  ],
};
