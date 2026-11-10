import type { IncidentEffect } from '../engine/types.ts';

/**
 * Ce que le chambellan explique après une vague : par composant qui sature, et par cause
 * d'échec. `says` est dit dans la métaphore (`{name}` : le nom du bâtiment, placé pour que la
 * phrase reste correcte quel que soit son genre ou son nombre), `tech` donne
 * l'explication technique, `remedy` les parades, `concept` la notion à réviser.
 */
export interface Lesson {
  says: string;
  tech: string;
  remedy: string;
  concept: string;
}

/** Composant saturé, par type du catalogue. */
export const saturationLessons: Record<string, Lesson> = {
  'app-server': {
    says: 'Débordement à {name} : plus de voyageurs que de scribes pour les recevoir, les derniers arrivés sont repartis sans réponse.',
    tech: 'Le serveur d’application est le goulot : sa capacité est dépassée, les requêtes en trop échouent et la latence explose.',
    remedy: 'Ajouter des instances derrière un load balancer (scaling horizontal), ou de l’autoscaling si le pic est court ; un CDN si ce sont des lectures de contenu stable.',
    concept: 'Scalabilité horizontale',
  },
  database: {
    says: 'Engorgement à {name} : chaque voyageur y venait chercher sa réponse, plus vite qu’on ne pouvait les servir.',
    tech: 'La base est le goulot classique. En lecture, on la soulage par un cache ou des réplicas ; en écriture, par une file et un traitement par lots.',
    remedy: 'Lectures : poser un cache consulté par le serveur, ou un réplica en lecture. Écritures massives : passer par une file de messages.',
    concept: 'Cache, réplication',
  },
  cache: {
    says: 'Débordement à {name} : même le carnet ne suffisait plus à tant de consultations.',
    tech: 'Le cache lui-même sature : c’est rare, signe d’un volume de lectures très élevé.',
    remedy: 'Un CDN en amont pour servir une partie des lectures avant même le serveur.',
    concept: 'Cache',
  },
  'load-balancer': {
    says: 'Bouchon à {name} : tout le monde passe par là, et la porte n’est pas assez large.',
    tech: 'Le load balancer sature : tout le trafic passe par lui.',
    remedy: 'Écarter le trafic abusif avec du rate limiting, ou servir une partie des lectures en bordure (CDN).',
    concept: 'Load balancing',
  },
  'message-queue': {
    says: 'Débordement à {name} : les colis arrivent plus vite que les coursiers ne les livrent.',
    tech: 'La file grossit : le consommateur ne suit pas le producteur, l’arriéré monte jusqu’à perdre des messages.',
    remedy: 'Plus de workers derrière la file, ou des lots plus gros.',
    concept: 'Backpressure',
  },
  pubsub: {
    says: 'Débordement à {name} : il ne peut pas crier plus vite.',
    tech: 'Le pub/sub sature : il reçoit plus d’événements qu’il ne peut en diffuser.',
    remedy: 'Rare ; vérifier que seuls les événements passent par lui.',
    concept: 'Pub/sub',
  },
  cdn: {
    says: 'Débordement à {name}.',
    tech: 'Le CDN sature : volume de lectures exceptionnel.',
    remedy: 'Rare ; vérifier que seul le contenu cachable passe par lui.',
    concept: 'CDN',
  },
};

/** Causes d'échec qui ne sont pas une simple saturation. */
export const reasonLessons = {
  noRoute: {
    says: 'Des voyageurs repartent de {name} sans savoir où aller.',
    tech: '{name} reçoit des requêtes de type « {kind} » mais n’a aucun voisin qui les accepte : elles échouent faute de route.',
    remedy: 'Relier {name} à un bâtiment qui accepte ce type ; les archives (la base) acceptent tout.',
    concept: 'Chemin d’une requête',
  },
  legitLimited: {
    says: 'La garde refoule aussi d’honnêtes marchands.',
    tech: 'Le rate limiting est trop strict : il rejette du trafic légitime, comptés comme des échecs.',
    remedy: 'Monter le palier au-dessus du débit du plus gros client légitime, tout en restant sous celui de l’abuseur.',
    concept: 'Rate Limiting',
  },
  lostAtEdge: {
    says: 'Des passages ne sont jamais comptés : l’avant-poste répond seul aux voyageurs.',
    tech: 'Le CDN sert la redirection sans que le serveur la voie : l’événement de clic n’est jamais émis (le débat 301 contre 302).',
    remedy: 'Retirer le CDN du chemin des redirections comptées, ou compter les clics côté bordure.',
    concept: 'CDN',
  },
  queueOverflow: {
    says: 'Débordement à {name} : des colis sont perdus.',
    tech: 'L’arriéré de la file dépasse sa capacité : les messages en trop sont perdus.',
    remedy: 'Plus de consommateurs derrière la file.',
    concept: 'Backpressure',
  },
  overBudget: {
    says: 'Sire, le trésor est vide.',
    tech: 'L’architecture coûte plus que le budget de la vague (facture : {cost} / {budget}).',
    remedy: 'Retirer ce qui ne sert pas à cette vague : les bâtiments les moins chargés sont les premiers candidats.',
    concept: 'Arbitrage coût / fiabilité',
  },
  overComplexity: {
    says: 'Trop de rouages à entretenir pour vos gens.',
    tech: 'La complexité dépasse le plafond ({complexity} / {cap}) : chaque composant et chaque évolution ajoute de la charge opérationnelle.',
    remedy: 'Retirer les composants et évolutions qui n’apportent rien à cette vague.',
    concept: 'Over-engineering',
  },
  syncCall: {
    says: 'Chaque chaland attend au comptoir que le {metaphor} ait fini son ouvrage : la commande traîne.',
    tech: '{name} est appelé en direct : le client attend la fin de son travail ({latency} ms) avant d’avoir sa réponse. L’événement est sur le chemin critique.',
    remedy: 'Sortir ce travail du chemin critique : publier l’événement dans une file, que le service vide à son rythme.',
    concept: 'Traitement asynchrone',
  },
  slow: {
    says: 'Les voyageurs attendent trop longtemps leur réponse.',
    tech: 'La latence p95 dépasse le SLA : {name} tourne trop près de sa capacité (charge {load}).',
    remedy: 'Garder de la marge : au-delà de 80 % de charge, l’attente grimpe vite.',
    concept: 'Latence et charge',
  },
  duplicate: {
    says: 'Des clients ont été servis deux fois, et débités deux fois.',
    tech: 'Des messages livrés deux fois ont été traités deux fois par {name} : la livraison « au moins une fois » des files et des bus impose des consommateurs idempotents.',
    remedy: 'Rendre le consommateur idempotent : il garde la clé de chaque message traité et ignore ceux qu’il a déjà vus.',
    concept: 'Idempotence',
  },
  lostEvent: {
    says: 'Des commandes payées n’ont jamais été annoncées : personne ne les préparera.',
    tech: '{name} est tombé entre l’écriture de la commande en base et la publication de l’événement : la commande existe, l’événement est perdu.',
    remedy: 'Une outbox : écrire l’événement dans la même transaction que la commande, puis le relayer vers le bus.',
    concept: 'Transactional outbox',
  },
  circuitOpen: {
    says: 'Le guet a fermé la route du {metaphor} : {failed} paiements ont été refusés sur-le-champ, mais le reste de la cité a tourné.',
    tech: 'Le circuit breaker a coupé {name} : ses appels ont échoué tout de suite au lieu de bloquer le serveur. La cascade est évitée, mais chaque appel coupé reste un échec pour son client.',
    remedy: 'Pour ne rien perdre, différer l’appel : la commande passe par une file, le paiement est fait quand la dépendance revient (paiement différé).',
    concept: 'Circuit breaker, réponse dégradée',
  },
  undelivered: {
    says: 'Certains corps de métier n’ont jamais entendu parler des commandes.',
    tech: 'Chaque événement devait atteindre {fanOut} services, mais en moyenne seuls {reached} l’ont reçu. Une file partage les messages entre ses consommateurs : chacun n’en voit qu’une part.',
    remedy: 'Un pub/sub copie chaque événement à chacun de ses abonnés ; chaque service a son abonnement.',
    concept: 'Pub/sub',
  },
} satisfies Record<string, Lesson>;

/** Incidents annoncés : `hurt` quand la panne a fait échouer des requêtes, `held` quand l'architecture l'a encaissée. */
export const incidentLessons: Record<IncidentEffect['type'], { hurt: Lesson; held: Lesson }> = {
  'instance-down': {
    hurt: {
      says: '{title} : {failed} voyageurs sont restés sans réponse, faute de relève.',
      tech: 'Une instance unique est un point de défaillance unique (SPOF) : quand elle tombe, tout ce qu’elle servait échoue.',
      remedy: 'De la redondance : au moins deux instances derrière un load balancer, ou de l’autoscaling qui remplace l’instance perdue après son délai de démarrage.',
      concept: 'Redondance, SPOF',
    },
    held: {
      says: '{title} : les autres tours ont pris le relais, personne n’a rien vu.',
      tech: 'Les instances restantes ont absorbé la charge : la redondance a fait son travail.',
      remedy: 'Garder assez de marge pour perdre une instance au pic (N+1).',
      concept: 'Redondance, SPOF',
    },
  },
  'cold-cache': {
    hurt: {
      says: '{title}. Le carnet perdu, tout le monde a couru aux archives en même temps : elles ont débordé quelques instants et {failed} voyageurs sont repartis sans réponse.',
      tech: 'Un cache vidé renvoie d’un coup toutes les lectures sur la base, qui sature le temps qu’il se remplisse : c’est le cache stampede.',
      remedy: 'Une base qui tient seule le pic de lectures (réplica en lecture), un cache préchauffé, ou de la marge sur la base.',
      concept: 'Cache stampede',
    },
    held: {
      says: '{title} : les archives ont tenu seules le temps que le carnet se remplisse.',
      tech: 'La base a encaissé les lectures que le cache ne servait plus pendant qu’il se réchauffait.',
      remedy: 'Un cache est une optimisation : la base doit survivre à son absence, au moins un moment.',
      concept: 'Cache stampede',
    },
  },
  'dependency-down': {
    hurt: {
      says: '{title} : {failed} paiements sont restés sans réponse tant que le comptoir était fermé.',
      tech: 'Une dépendance externe en panne fait échouer chaque appel direct. Ce n’est pas un serveur à doubler : le prestataire n’est pas à vous.',
      remedy: 'Ne pas appeler la dépendance sur le chemin du client : une file garde les paiements pendant la panne et les livre à son retour (paiement différé, store and forward).',
      concept: 'Découplage par file, paiement différé',
    },
    held: {
      says: '{title} : les paiements ont attendu au relais de poste et sont partis à la réouverture.',
      tech: 'La file a gardé les appels pendant la panne ; son arriéré s’est vidé au retour de la dépendance.',
      remedy: 'Une file a une capacité : une panne trop longue la fait déborder. Dimensionner l’arriéré sur la plus longue panne qu’on accepte.',
      concept: 'Découplage par file, paiement différé',
    },
  },
  'slow-dependency': {
    hurt: {
      says: '{title}. Les scribes attendaient tous le banquier, plus personne ne servait au comptoir : {failed} voyageurs sont repartis sans réponse, même ceux qui ne voulaient rien payer.',
      tech: 'Un appel synchrone garde un fil d’exécution occupé jusqu’à la réponse. Une dépendance lente épuise tous les fils du serveur, qui ne sert plus rien : la panne se propage en cascade à des requêtes qui n’avaient rien à voir.',
      remedy: 'Un circuit breaker sur le serveur : au-delà d’un délai, il coupe la dépendance et ses appels échouent tout de suite, les fils restent libres pour le reste. Ou sortir l’appel du chemin du client, par une file.',
      concept: 'Circuit breaker, cascade de pannes',
    },
    held: {
      says: '{title} : le reste de la cité a continué de tourner pendant que le banquier traînait.',
      tech: 'La dépendance lente n’a pas bloqué le serveur : ses appels ont été coupés ou différés, les autres requêtes ont été servies.',
      remedy: 'Un appel coupé reste un échec pour celui qui le faisait : un délai trop long et la cascade revient, trop court et l’on coupe une dépendance saine.',
      concept: 'Circuit breaker, cascade de pannes',
    },
  },
  'cache-stampede': {
    hurt: {
      says: '{title}. Pour chaque page perdue, dix scribes ont couru aux archives chercher la même : elles ont croulé et {failed} voyageurs sont repartis sans réponse.',
      tech: 'Quand beaucoup d’entrées expirent en même temps, chaque requête qui les manque recalcule la même valeur en base : la base fait le travail plusieurs fois et sature. C’est la ruée vers le cache (thundering herd).',
      remedy: 'Un verrou de recalcul (request coalescing) : une seule requête recalcule l’entrée, les autres attendent son résultat. Ou une base assez large pour encaisser la ruée (réplicas).',
      concept: 'Ruée vers le cache',
    },
    held: {
      says: '{title} : les archives ont tenu pendant que le carnet se remplissait.',
      tech: 'La base a encaissé les recalculs pendant que le cache se reconstruisait.',
      remedy: 'Étaler les expirations (un délai aléatoire) évite que tout expire au même instant.',
      concept: 'Ruée vers le cache',
    },
  },
  'duplicate-delivery': {
    hurt: {
      says: '{title} : {failed} commandes ont été traitées deux fois.',
      tech: 'Pendant l’incident, une part des messages est livrée deux fois ; un consommateur qui ne reconnaît pas un message déjà traité le traite à nouveau.',
      remedy: 'L’idempotence sur les consommateurs : chacun garde la clé des messages déjà traités et ignore les doublons.',
      concept: 'Idempotence',
    },
    held: {
      says: '{title} : les doublons ont été reconnus et écartés.',
      tech: 'Les consommateurs idempotents ont ignoré les messages déjà traités.',
      remedy: 'L’idempotence a un coût : chaque service garde la mémoire des clés vues, dans son propre stockage.',
      concept: 'Idempotence',
    },
  },
  'publish-loss': {
    hurt: {
      says: '{title} : {failed} commandes payées sont restées sans suite.',
      tech: 'Le serveur écrit la commande puis publie l’événement : s’il tombe entre les deux, l’événement est perdu (le problème de la double écriture).',
      remedy: 'Une outbox : l’événement est écrit dans la même transaction que la commande, puis relayé.',
      concept: 'Transactional outbox',
    },
    held: {
      says: '{title} : aucune commande perdue, tout était consigné au grand livre.',
      tech: 'L’outbox a gardé chaque événement avec sa commande ; le relais les a publiés.',
      remedy: 'L’outbox coûte une écriture de plus par commande.',
      concept: 'Transactional outbox',
    },
  },
};
