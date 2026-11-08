/**
 * Ce que le chambellan explique après une vague : par composant qui sature, et par cause
 * d'échec. `says` est dit dans la métaphore (`{name}` : le nom du bâtiment, placé pour que la
 * phrase reste correcte quel que soit son genre ou son nombre), `tech` donne
 * l'explication d'entretien, `remedy` les parades, `concept` la notion à réviser.
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
    says: 'Débordement à {name} : les voyageurs s’entassent devant les scribes.',
    tech: 'Le serveur d’application est le goulot : sa capacité est dépassée, les requêtes en trop échouent et la latence explose.',
    remedy: 'Ajouter des instances derrière un load balancer (scaling horizontal), ou de l’autoscaling si le pic est court ; un CDN si ce sont des lectures de contenu stable.',
    concept: 'Scalabilité horizontale',
  },
  database: {
    says: 'Engorgement à {name} : les demandes s’accumulent plus vite qu’on n’y répond.',
    tech: 'La base est le goulot classique. En lecture, on la soulage par un cache ou des réplicas ; en écriture, par une file et un traitement par lots.',
    remedy: 'Lectures : poser un cache consulté par le serveur, ou un réplica en lecture. Écritures massives : passer par une file de messages.',
    concept: 'Cache, réplication',
  },
  cache: {
    says: 'Débordement à {name} : trop de consultations à la fois.',
    tech: 'Le cache lui-même sature : c’est rare, signe d’un volume de lectures très élevé.',
    remedy: 'Un CDN en amont pour servir une partie des lectures avant même le serveur.',
    concept: 'Cache',
  },
  'load-balancer': {
    says: 'Bouchon à {name} : tout le monde passe par là.',
    tech: 'Le load balancer sature : tout le trafic passe par lui.',
    remedy: 'Écarter le trafic abusif avec du rate limiting, ou servir une partie des lectures en bordure (CDN).',
    concept: 'Load balancing',
  },
  'message-queue': {
    says: 'Débordement à {name} : les colis s’entassent plus vite qu’on ne les livre.',
    tech: 'La file grossit : le consommateur ne suit pas le producteur, l’arriéré monte jusqu’à perdre des messages.',
    remedy: 'Plus de workers derrière la file, ou des lots plus gros.',
    concept: 'Backpressure',
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
  slow: {
    says: 'Les voyageurs attendent trop longtemps leur réponse.',
    tech: 'La latence p95 dépasse le SLA : {name} tourne trop près de sa capacité (charge {load}).',
    remedy: 'Garder de la marge : au-delà de 80 % de charge, l’attente grimpe vite.',
    concept: 'Latence et charge',
  },
} satisfies Record<string, Lesson>;
