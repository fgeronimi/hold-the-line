/**
 * Les succès (décision I20) : un concept de system design appliqué, constaté dans une vague
 * tenue. Le nom technique d'abord, la métaphore entre parenthèses (I6), puis « en vrai ». La
 * détection est dans `src/ui/achievements.ts` : elle lit ce que le moteur a publié.
 */
export interface Achievement {
  id: string;
  /** La notion, comme le debrief la nomme dans « À réviser ». */
  concept: string;
  tech: string;
  metaphor: string;
  /** Ce qu'on a fait, en vrai, pour le mériter. */
  real: string;
  /** Un pictogramme du sprite (`src/ui/sprite.ts`). */
  icon: string;
}

export const CONCEPT_ACHIEVEMENTS: Achievement[] = [
  {
    id: 'client-server',
    concept: 'Chemin d’une requête',
    tech: 'Client, serveur, base',
    metaphor: 'la tour et les archives',
    real: 'Un serveur d’application qui répond aux clients et s’appuie sur une base de données : le socle de tout service web.',
    icon: 'hammer',
  },
  {
    id: 'horizontal-scaling',
    concept: 'Scalabilité horizontale',
    tech: 'Scalabilité horizontale',
    metaphor: 'plusieurs tours de scribes',
    real: 'Plusieurs instances derrière un load balancer se sont partagé la charge.',
    icon: 'scale',
  },
  {
    id: 'autoscaling',
    concept: 'Autoscaling',
    tech: 'Autoscaling',
    metaphor: 'des tours bâties à la demande',
    real: 'L’autoscaler a lancé des instances quand la charge montait, au prix de leur délai de démarrage.',
    icon: 'autoscale',
  },
  {
    id: 'redundancy',
    concept: 'Redondance, SPOF',
    tech: 'Redondance',
    metaphor: 'la relève',
    real: 'Une instance est tombée sans qu’aucune requête n’échoue : pas de point de défaillance unique.',
    icon: 'swords',
  },
  {
    id: 'cache',
    concept: 'Cache',
    tech: 'Cache-aside',
    metaphor: 'le carnet du scribe',
    real: 'Le cache a servi des lectures que la base n’a jamais vues.',
    icon: 'read',
  },
  {
    id: 'cold-cache',
    concept: 'Cache stampede',
    tech: 'Cache froid encaissé',
    metaphor: 'le carnet perdu',
    real: 'Le cache a redémarré vide et la vague a tenu le temps qu’il se remplisse.',
    icon: 'warn',
  },
  {
    id: 'cdn',
    concept: 'CDN',
    tech: 'CDN',
    metaphor: 'l’avant-poste',
    real: 'Des lectures ont été servies en bordure, sans jamais entrer dans la cité.',
    icon: 'target',
  },
  {
    id: 'read-replica',
    concept: 'Cache, réplication',
    tech: 'Réplicas en lecture',
    metaphor: 'les copies des archives',
    real: 'Les lectures se sont réparties sur des copies, le primaire a gardé les écritures.',
    icon: 'replica',
  },
  {
    id: 'rate-limiting',
    concept: 'Rate Limiting',
    tech: 'Rate limiting',
    metaphor: 'la garde de la porte',
    real: 'Le trafic abusif a été écarté à l’entrée, les clients légitimes sont passés.',
    icon: 'portcullis',
  },
  {
    id: 'api-quotas',
    concept: 'Passerelle d’API',
    tech: 'Quotas par client',
    metaphor: 'les laissez-passer',
    real: 'La passerelle a appliqué une limite par classe de client : chacun la sienne.',
    icon: 'key',
  },
  {
    id: 'queue-worker',
    concept: 'Traitement asynchrone',
    tech: 'File de messages',
    metaphor: 'le relais de poste',
    real: 'Le travail lent est sorti du chemin critique : une file, et un consommateur qui la vide à son rythme.',
    icon: 'crate',
  },
  {
    id: 'pubsub',
    concept: 'Pub/sub',
    tech: 'Pub/sub',
    metaphor: 'le crieur public',
    real: 'Chaque événement a été diffusé à plusieurs services, sans que l’émetteur les connaisse.',
    icon: 'async',
  },
  {
    id: 'idempotence',
    concept: 'Idempotence',
    tech: 'Idempotence',
    metaphor: 'le sceau',
    real: 'Des messages livrés deux fois ont été reconnus et écartés : rien n’a été traité en double.',
    icon: 'seal',
  },
  {
    id: 'outbox',
    concept: 'Transactional outbox',
    tech: 'Transactional outbox',
    metaphor: 'le registre',
    real: 'Le serveur est tombé avant de publier, et aucun événement n’a été perdu.',
    icon: 'ledger',
  },
  {
    id: 'dead-letter',
    concept: 'Message empoisonné, file des lettres mortes',
    tech: 'Dead-letter queue',
    metaphor: 'la boîte aux lettres mortes',
    real: 'Un message qui faisait planter son consommateur a été mis de côté ; la file a repris.',
    icon: 'mailbox',
  },
  {
    id: 'circuit-breaker',
    concept: 'Circuit breaker, cascade de pannes',
    tech: 'Circuit breaker',
    metaphor: 'la guérite du disjoncteur',
    real: 'Face à une dépendance lente, le disjoncteur a coupé les appels au lieu de bloquer les fils.',
    icon: 'switch',
  },
  {
    id: 'deferred-payment',
    concept: 'Découplage par file, paiement différé',
    tech: 'Paiement différé',
    metaphor: 'les paiements mis en file',
    real: 'Le prestataire de paiement a traîné ou fermé, et la file a gardé les paiements : le client n’a pas attendu.',
    icon: 'coin',
  },
  {
    id: 'coalescing',
    concept: 'Ruée vers le cache',
    tech: 'Request coalescing',
    metaphor: 'le verrou du carnet',
    real: 'Tout le cache a expiré d’un coup ; le verrou n’a laissé recalculer chaque page qu’une fois.',
    icon: 'lock',
  },
  {
    id: 'backoff',
    concept: 'Tempête de relances, délestage, backoff exponentiel',
    tech: 'Backoff exponentiel',
    metaphor: 'les voyageurs patients',
    real: 'Les clients ont relancé en s’espaçant : pas de tempête de relances.',
    icon: 'hourglass',
  },
  {
    id: 'load-shedding',
    concept: 'Tempête de relances, délestage, backoff exponentiel',
    tech: 'Load shedding',
    metaphor: 'la barrière',
    real: 'Au-delà de sa capacité, la porte a refusé tout de suite plutôt que de laisser tout ralentir.',
    icon: 'barrier',
  },
  {
    id: 'partition',
    concept: 'Partition réseau, cohérence (CAP)',
    tech: 'Lecture sur le primaire',
    metaphor: 'le registre royal',
    real: 'Les réplicas étaient coupés du primaire ; les lectures qui devaient être à jour l’ont été.',
    icon: 'crown',
  },
  {
    id: 'retention',
    concept: 'Backpressure, dimensionner une file',
    tech: 'Capacité de la file',
    metaphor: 'les pigeons au colombier',
    real: 'Le prestataire d’e-mail est tombé ; la file a gardé les messages jusqu’à son retour.',
    icon: 'mailbox',
  },
];

/** Finir un scénario sans aucun indice : un succès par scénario. */
export const noHintId = (scenarioId: string) => `no-hint:${scenarioId}`;
