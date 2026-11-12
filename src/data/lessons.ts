import type { IncidentEffect, UpgradeEffect } from '../engine/types.ts';

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
  /** Ce qui vous aurait prévenu : la métrique à surveiller et son seuil d'alerte (D1). */
  signal?: string;
}

/** Composant saturé, par type du catalogue. */
export const saturationLessons: Record<string, Lesson> = {
  'app-server': {
    says: 'Débordement à {name} : plus de voyageurs que de scribes pour les recevoir, les derniers arrivés sont repartis sans réponse.',
    tech: 'Le serveur d’application est le goulot : sa capacité est dépassée, les requêtes en trop échouent et la latence explose.',
    remedy: 'Ajouter des instances derrière un load balancer (scaling horizontal), ou de l’autoscaling si le pic est court ; un CDN si ce sont des lectures de contenu stable.',
    concept: 'Scalabilité horizontale',
    signal: 'Charge processeur des instances au-delà de 80 % pendant cinq minutes, et latence p95 du serveur.',
  },
  worker: {
    says: 'Débordement à {name} : les colis s’entassent plus vite que les commis ne les emportent.',
    tech: 'Le worker est le goulot : il ne consomme pas la file aussi vite qu’elle se remplit, l’arriéré monte.',
    remedy: 'Ajouter des workers derrière la file (ils se partagent les messages), dimensionnés sur l’arriéré à résorber ; si c’est ce qu’il écrit qui sature, soulager cette base.',
    concept: 'Backpressure',
    signal: 'Âge du plus vieux message de la file, et charge des workers.',
  },
  database: {
    says: 'Engorgement à {name} : chaque voyageur y venait chercher sa réponse, plus vite qu’on ne pouvait les servir.',
    tech: 'La base est le goulot classique. En lecture, on la soulage par un cache ou des réplicas ; en écriture, par une file et un traitement par lots.',
    remedy: 'Lectures : poser un cache consulté par le serveur, ou un réplica en lecture. Écritures massives : passer par une file de messages.',
    concept: 'Cache, réplication',
    signal: 'Charge du primaire au-delà de 80 %, et latence des requêtes en base.',
  },
  cache: {
    says: 'Débordement à {name} : même le carnet ne suffisait plus à tant de consultations.',
    tech: 'Le cache lui-même sature : c’est rare, signe d’un volume de lectures très élevé.',
    remedy: 'Un CDN en amont pour servir une partie des lectures avant même le serveur.',
    concept: 'Cache',
    signal: 'Taux de succès du cache, et charge du cache.',
  },
  'load-balancer': {
    says: 'Bouchon à {name} : tout le monde passe par là, et la porte n’est pas assez large.',
    tech: 'Le load balancer sature : tout le trafic passe par lui.',
    remedy: 'Écarter le trafic abusif avec du rate limiting, ou servir une partie des lectures en bordure (CDN).',
    concept: 'Load balancing',
    signal: 'Requêtes par seconde à la porte, au regard de sa capacité.',
  },
  'message-queue': {
    says: 'Débordement à {name} : les colis arrivent plus vite que les coursiers ne les livrent.',
    tech: 'La file grossit : le consommateur ne suit pas le producteur, l’arriéré monte jusqu’à perdre des messages.',
    remedy: 'Plus de workers derrière la file si ce sont eux qui ne suivent pas ; sinon soulager ce qu’ils écrivent (la base), car la file ne se vide qu’au rythme de l’aval. Plus de capacité de file pour tenir plus longtemps.',
    concept: 'Backpressure',
    signal: 'Âge du plus vieux message, plus que la longueur de la file.',
  },
  pubsub: {
    says: 'Débordement à {name} : il ne peut pas crier plus vite.',
    tech: 'Le pub/sub sature : il reçoit plus d’événements qu’il ne peut en diffuser.',
    remedy: 'Rare ; vérifier que seuls les événements passent par lui.',
    concept: 'Pub/sub',
    signal: 'Messages reçus par chaque abonné, comparés aux messages publiés.',
  },
  cdn: {
    says: 'Débordement à {name}.',
    tech: 'Le CDN sature : volume de lectures exceptionnel.',
    remedy: 'Rare ; vérifier que seul le contenu cachable passe par lui.',
    concept: 'CDN',
    signal: 'Taux de succès en bordure, et requêtes qui reviennent jusqu’au serveur.',
  },
};

/** Causes d'échec qui ne sont pas une simple saturation. */
export const reasonLessons = {
  noRoute: {
    says: 'Des voyageurs repartent de {name} sans savoir où aller.',
    tech: '{name} reçoit des requêtes de type « {kind} » mais n’a aucun voisin qui les accepte : elles échouent faute de route.',
    remedy: 'Relier {name} à un bâtiment qui accepte ce type ; les archives (la base) acceptent tout.',
    concept: 'Chemin d’une requête',
    signal: 'Erreurs par route : une route qui n’aboutit jamais saute aux yeux sur un tableau de bord.',
  },
  legitLimited: {
    says: 'La garde refoule aussi d’honnêtes marchands.',
    tech: 'Le rate limiting est trop strict : il rejette du trafic légitime, comptés comme des échecs.',
    remedy: 'Monter le palier au-dessus du débit du plus gros client légitime, tout en restant sous celui de l’abuseur. En vrai, on ne choisit pas une seule limite pour tous : chaque classe de client a la sienne, une clé d’API pour les partenaires, une limite plus basse pour les anonymes.',
    concept: 'Rate Limiting',
    signal: 'Réponses 429 par client : un partenaire légitime refusé est une alerte, pas du bruit.',
  },
  lostAtEdge: {
    says: 'Des passages ne sont jamais comptés : l’avant-poste répond seul aux voyageurs.',
    tech: 'Le CDN sert la redirection sans que le serveur la voie : l’événement de clic n’est jamais émis (le débat 301 contre 302).',
    remedy: 'Retirer le CDN du chemin des redirections comptées. En vrai, on garde souvent le CDN : on répond en 302 (redirection temporaire, non mise en cache) ou avec une durée de cache courte, ou on compte les clics dans les journaux du CDN.',
    concept: 'CDN',
    signal: 'Écart entre redirections servies et clics comptés.',
  },
  queueAge: {
    says: 'Rien ne s’est perdu au relais de poste, mais le plus vieux pli y a attendu {minutes} minutes.',
    tech: 'À {name}, le plus vieux message a attendu {minutes} minutes avant d’être traité. Une file ne perd rien, mais elle retarde : un billet reçu une demi-heure après l’achat, un paiement confirmé bien après la commande, c’est un incident pour le client, même sans perte.',
    remedy: 'En vrai, on surveille l’âge du plus vieux message et on alerte dessus, plus que sur la longueur de la file. Pour rattraper plus vite : plus de consommateurs, si c’est eux qui limitent ; sinon, le retard dure tant que l’aval (un quota, une base) ne suit pas.',
    concept: 'Observabilité d’une file, âge du plus vieux message',
    signal: 'Une alerte sur l’âge du plus vieux message, par exemple au-delà de cinq minutes.',
  },
  queueOverflow: {
    says: 'Débordement à {name} : des colis sont perdus.',
    tech: 'L’arriéré de la file dépasse sa capacité : les messages en trop sont perdus. Une file absorbe un pic, pas un excès qui dure : l’arriéré monte de (arrivées − départs) à chaque minute de jeu. Sa capacité se lit donc en minutes de trafic : arrivées par seconde × minutes d’attente, à l’échelle du jeu et non en volumes réels.',
    remedy: 'Si les consommateurs suivent en moyenne, une file plus grande (sa capacité) suffit à passer le pic. Sinon, plus de consommateurs derrière la file. En vrai, la limite d’une file gérée est souvent une durée plutôt qu’un nombre : sur Amazon SQS, un message est gardé 4 jours par défaut, 14 au plus ; Kafka borne un sujet en durée ou en octets, RabbitMQ une file en longueur. On la dimensionne sur la plus longue panne de l’aval qu’on accepte, et on surveille l’âge du plus vieux message.',
    concept: 'Backpressure, dimensionner une file',
    signal: 'Âge du plus vieux message et longueur de la file, avec une alerte bien avant la limite.',
  },
  retryStorm: {
    says: 'Chaque voyageur refoulé est revenu aussitôt, et ses voisins avec lui : la foule a quadruplé aux portes, bien après que les tours furent relevées.',
    tech: 'Une panne brève a fait échouer des requêtes ; des clients qui relancent tout de suite ont multiplié la charge ({retries} relances par seconde au pire). Le serveur saturé travaille pour des requêtes déjà abandonnées : la panne s’entretient seule une fois sa cause partie (panne métastable).',
    remedy: 'Côté serveur : délester à la porte, rejeter vite ce que les serveurs ne serviront pas, pour qu’ils ne travaillent plus pour des requêtes abandonnées. Côté client, si c’est votre application : backoff exponentiel et jitter, avec un budget de relances (au plus quelques tentatives, et des relances qui ne dépassent pas une petite part du trafic). Ou assez de marge pour qu’une panne n’amorce jamais la tempête.',
    concept: 'Tempête de relances, délestage, backoff exponentiel',
    signal: 'Relances par seconde au regard du trafic neuf, et un taux d’erreurs qui ne redescend pas après la panne.',
  },
  staleRead: {
    says: 'Les copistes, coupés du grand registre, ont promis des places déjà vendues : {failed} lectures fausses.',
    tech: 'Pendant la partition, les réplicas ne reçoivent plus les écritures du primaire : ils servent une donnée périmée. Pour une donnée qui doit être à jour (la place est-elle encore libre ?), c’est un échec : la même place est promise à deux spectateurs. En vrai, la garantie finale contre la double vente est une réservation atomique à l’écriture ; la lecture sur le primaire évite seulement de promettre ce qui n’est plus libre.',
    remedy: 'Envoyer les lectures critiques au primaire (lecture sur le leader), et garder les réplicas pour ce qui tolère un léger retard. Choisir, donnée par donnée, entre cohérence et disponibilité.',
    concept: 'Partition réseau, cohérence (CAP)',
    signal: 'Retard de réplication (replica lag), et réplicas déconnectés du primaire.',
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
    signal: 'Latence de la commande décomposée par appel, grâce au traçage distribué.',
  },
  slow: {
    says: 'Les voyageurs attendent trop longtemps leur réponse.',
    tech: 'La latence p95 dépasse le SLA : {name} tourne trop près de sa capacité (charge {load}).',
    remedy: 'Garder de la marge : au-delà de 80 % de charge, l’attente grimpe vite.',
    concept: 'Latence et charge',
    signal: 'Latence p95 et p99 par route et par bâtiment.',
  },
  duplicate: {
    says: 'Des clients ont été servis deux fois, et débités deux fois.',
    tech: 'Des messages livrés deux fois ont été traités deux fois par {name} : la livraison « au moins une fois » des files et des bus impose des consommateurs idempotents.',
    remedy: 'Rendre le consommateur idempotent : il garde la clé de chaque message traité et ignore ceux qu’il a déjà vus.',
    concept: 'Idempotence',
    signal: 'Messages traités deux fois : compter les clés déjà vues.',
  },
  lostEvent: {
    says: 'Des commandes payées n’ont jamais été annoncées : personne ne les préparera.',
    tech: '{name} est tombé entre l’écriture de la commande en base et la publication de l’événement : la commande existe, l’événement est perdu.',
    remedy: 'Une outbox : écrire l’événement dans la même transaction que la commande, puis le relayer vers le bus.',
    concept: 'Transactional outbox',
    signal: 'Écart entre commandes écrites et événements publiés.',
  },
  timedOut: {
    says: 'Les scribes n’ont plus attendu le {metaphor} au-delà de l’heure dite : {failed} paiements abandonnés, mais aucune tour n’est restée bloquée.',
    tech: 'Le délai d’attente du serveur a abandonné les appels à {name} qui ne répondaient pas à temps : chacun a gardé un fil le temps du délai, puis a échoué. La cascade est évitée, mais le client a attendu tout le délai, et son paiement a échoué.',
    remedy: 'Pour ne plus attendre du tout, un circuit breaker coupe la dépendance dès qu’elle dépasse son délai. Pour ne rien perdre, différer l’appel par une file (paiement différé). En vrai, tout appel réseau a un délai d’attente, plus court que celui de son propre client.',
    concept: 'Délai d’attente, cascade de pannes',
    signal: 'Appels abandonnés par le délai, par dépendance, et latence p99 de chaque dépendance.',
  },
  circuitOpen: {
    says: 'Le guet a fermé la route du {metaphor} : {failed} paiements ont été refusés sur-le-champ, mais le reste de la cité a tourné.',
    tech: 'Le circuit breaker a coupé {name} : ses appels ont échoué tout de suite au lieu de bloquer le serveur. La cascade est évitée, mais chaque appel coupé reste un échec pour son client.',
    remedy: 'Pour ne rien perdre, différer l’appel : la commande passe par une file, le paiement est fait quand la dépendance revient (paiement différé).',
    concept: 'Circuit breaker, réponse dégradée',
    signal: 'État du disjoncteur, ouvert ou fermé, et appels coupés par seconde.',
  },
  undelivered: {
    says: 'Certains corps de métier n’ont jamais entendu parler des commandes.',
    tech: 'Chaque événement devait atteindre {fanOut} services, mais en moyenne seuls {reached} l’ont reçu. Une file partage les messages entre ses consommateurs : chacun n’en voit qu’une part.',
    remedy: 'Un pub/sub copie chaque événement à chacun de ses abonnés ; chaque service a son abonnement.',
    concept: 'Pub/sub',
    signal: 'Messages reçus par chaque abonné, comparés aux messages publiés.',
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
      signal: 'Instances en bonne santé derrière la porte (vérifications de santé du load balancer).',
    },
    held: {
      says: '{title} : les autres tours ont pris le relais, personne n’a rien vu.',
      tech: 'Les instances restantes ont absorbé la charge : la redondance a fait son travail.',
      remedy: 'Garder assez de marge pour perdre une instance au pic (N+1).',
      concept: 'Redondance, SPOF',
      signal: 'Instances en bonne santé derrière la porte (vérifications de santé du load balancer).',
    },
  },
  'cold-cache': {
    hurt: {
      says: '{title}. Le carnet perdu, tout le monde a couru aux archives en même temps : elles ont débordé quelques minutes et {failed} voyageurs sont repartis sans réponse.',
      tech: 'Un cache vidé renvoie d’un coup toutes les lectures sur la base, qui sature le temps qu’il se remplisse : c’est le cache stampede.',
      remedy: 'Une base qui tient seule le pic de lectures (réplica en lecture), un cache préchauffé, ou de la marge sur la base.',
      concept: 'Cache stampede',
      signal: 'Taux de succès du cache et charge de la base juste après un redémarrage.',
    },
    held: {
      says: '{title} : les archives ont tenu seules le temps que le carnet se remplisse.',
      tech: 'La base a encaissé les lectures que le cache ne servait plus pendant qu’il se réchauffait.',
      remedy: 'Un cache est une optimisation : la base doit survivre à son absence, au moins un moment.',
      concept: 'Cache stampede',
      signal: 'Taux de succès du cache et charge de la base juste après un redémarrage.',
    },
  },
  'dependency-down': {
    hurt: {
      says: '{title} : {failed} paiements sont restés sans réponse tant que le comptoir était fermé.',
      tech: 'Une dépendance externe en panne fait échouer chaque appel direct. Ce n’est pas un serveur à doubler : le prestataire n’est pas à vous.',
      remedy: 'Ne pas appeler la dépendance sur le chemin du client : une file garde les paiements pendant la panne et les livre à son retour (paiement différé, store and forward).',
      concept: 'Découplage par file, paiement différé',
      signal: 'Taux d’erreur et latence par dépendance externe, et page de statut du prestataire.',
    },
    held: {
      says: '{title} : les paiements ont attendu au relais de poste et sont partis à la réouverture.',
      tech: 'La file a gardé les appels pendant la panne ; son arriéré s’est vidé au retour de la dépendance.',
      remedy: 'Une file a une capacité : une panne trop longue la fait déborder. Dimensionner l’arriéré sur la plus longue panne qu’on accepte.',
      concept: 'Découplage par file, paiement différé',
      signal: 'Taux d’erreur et latence par dépendance externe, et page de statut du prestataire.',
    },
  },
  'slow-dependency': {
    hurt: {
      says: '{title}. Les scribes attendaient tous le banquier, plus personne ne servait au comptoir : {failed} voyageurs sont repartis sans réponse, même ceux qui ne voulaient rien payer.',
      tech: 'Un appel synchrone garde un fil d’exécution occupé jusqu’à la réponse. Une dépendance lente épuise tous les fils du serveur, qui ne sert plus rien : la panne se propage en cascade à des requêtes qui n’avaient rien à voir.',
      remedy: 'Un circuit breaker sur le serveur : au-delà d’un délai, il coupe la dépendance et ses appels échouent tout de suite, les fils restent libres pour le reste. Ou sortir l’appel du chemin du client, par une file.',
      concept: 'Circuit breaker, cascade de pannes',
      signal: 'Latence p99 par dépendance, et fils occupés du serveur.',
    },
    held: {
      says: '{title} : le reste de la cité a continué de tourner pendant que le banquier traînait.',
      tech: 'La dépendance lente n’a pas bloqué le serveur : ses appels ont été coupés ou différés, les autres requêtes ont été servies.',
      remedy: 'Un appel coupé reste un échec pour celui qui le faisait : un délai trop long et la cascade revient, trop court et l’on coupe une dépendance saine.',
      concept: 'Circuit breaker, cascade de pannes',
      signal: 'Latence p99 par dépendance, et fils occupés du serveur.',
    },
  },
  'cache-stampede': {
    hurt: {
      says: '{title}. Pour chaque page perdue, dix scribes ont couru aux archives chercher la même : elles ont croulé et {failed} voyageurs sont repartis sans réponse.',
      tech: 'Quand beaucoup d’entrées expirent en même temps, chaque requête qui les manque recalcule la même valeur en base : la base fait le travail plusieurs fois et sature. C’est la ruée vers le cache (thundering herd).',
      remedy: 'Un verrou de recalcul (request coalescing) : une seule requête recalcule l’entrée, les autres attendent son résultat. Ou une base assez large pour encaisser la ruée (réplicas).',
      concept: 'Ruée vers le cache',
      signal: 'Absences de cache par seconde, et charge de la base à l’heure des expirations.',
    },
    held: {
      says: '{title} : les archives ont tenu pendant que le carnet se remplissait.',
      tech: 'La base a encaissé les recalculs pendant que le cache se reconstruisait.',
      remedy: 'Étaler les expirations (un délai aléatoire) évite que tout expire au même instant.',
      concept: 'Ruée vers le cache',
      signal: 'Absences de cache par seconde, et charge de la base à l’heure des expirations.',
    },
  },
  'duplicate-delivery': {
    hurt: {
      says: '{title} : {failed} commandes ont été traitées deux fois.',
      tech: 'Pendant l’incident, une part des messages est livrée deux fois ; un consommateur qui ne reconnaît pas un message déjà traité le traite à nouveau.',
      remedy: 'L’idempotence sur les consommateurs : chacun garde la clé des messages déjà traités et ignore les doublons.',
      concept: 'Idempotence',
      signal: 'Messages relivrés par le bus, et clés déjà vues côté consommateur.',
    },
    held: {
      says: '{title} : les doublons ont été reconnus et écartés.',
      tech: 'Les consommateurs idempotents ont ignoré les messages déjà traités.',
      remedy: 'L’idempotence a un coût : chaque service garde la mémoire des clés vues, dans son propre stockage.',
      concept: 'Idempotence',
      signal: 'Messages relivrés par le bus, et clés déjà vues côté consommateur.',
    },
  },
  partition: {
    hurt: {
      says: '{title} : les copistes n’entendaient plus le grand registre, {failed} réponses fausses sont parties.',
      tech: 'Une partition coupe les réplicas du primaire : ils restent disponibles, mais leurs données vieillissent. On ne peut pas avoir à la fois la cohérence et la disponibilité pendant une partition (CAP).',
      remedy: 'Les lectures qui doivent être à jour vont au primaire ; les autres peuvent rester sur les réplicas.',
      concept: 'Partition réseau, cohérence (CAP)',
      signal: 'Retard de réplication, et réplicas déconnectés du primaire.',
    },
    held: {
      says: '{title} : les copistes ont servi le catalogue, le grand registre a gardé les places.',
      tech: 'Les lectures critiques ne passaient pas par les réplicas : la partition n’a rendu périmé que ce qui pouvait l’être.',
      remedy: 'Lire sur le primaire a un prix : il doit tenir ces lectures en plus des écritures.',
      concept: 'Partition réseau, cohérence (CAP)',
      signal: 'Retard de réplication, et réplicas déconnectés du primaire.',
    },
  },
  'poison-message': {
    hurt: {
      says: '{title} : chaque fois qu’on la remettait au maître de métier, il s’effondrait dessus, et le relais de poste n’a plus rien livré d’autre. {failed} plis sont restés en souffrance derrière elle.',
      tech: 'Un message empoisonné (mal formé, ou qui fait planter le consommateur) n’est jamais acquitté : la file le relivre sans fin, le consommateur plante à chaque essai, et une file qui sert dans l’ordre ne livre plus rien de ce qui attend derrière. L’arriéré et l’âge du plus vieux message montent jusqu’à la fin.',
      remedy: 'Une file des lettres mortes : après quelques essais ratés (trois, ici), le message est mis de côté dans une file à part. La file repart ; le message, lui, attend qu’on l’examine.',
      concept: 'Message empoisonné, file des lettres mortes',
      signal: 'Âge du plus vieux message, et nombre d’essais par message : un message relivré plus de trois fois est suspect.',
    },
    held: {
      says: '{title} : après trois essais, la commande a été mise de côté, et le relais de poste a repris sa tournée. {dead} plis attendent qu’on les examine.',
      tech: 'La file des lettres mortes a écarté les messages empoisonnés après trois essais ratés : la file ne s’est bloquée que le temps de ces essais. Les messages mis de côté ne sont pas traités : ils comptent en échec, et quelqu’un doit les examiner, corriger, puis les rejouer.',
      remedy: 'Alerter dès qu’un message tombe dans la file des lettres mortes : c’est un travail en attente, pas une poubelle. Les rejouer (redrive) une fois la cause corrigée.',
      concept: 'Message empoisonné, file des lettres mortes',
      signal: 'Taille de la file des lettres mortes : une alerte dès le premier message.',
    },
  },
  'publish-loss': {
    hurt: {
      says: '{title} : {failed} commandes payées sont restées sans suite.',
      tech: 'Le serveur écrit la commande puis publie l’événement : s’il tombe entre les deux, l’événement est perdu (le problème de la double écriture).',
      remedy: 'Une outbox : l’événement est écrit dans la même transaction que la commande, puis relayé.',
      concept: 'Transactional outbox',
      signal: 'Écart entre commandes écrites et événements publiés.',
    },
    held: {
      says: '{title} : aucune commande perdue, tout était consigné au grand livre.',
      tech: 'L’outbox a gardé chaque événement avec sa commande ; le relais les a publiés.',
      remedy: 'L’outbox coûte une écriture de plus par commande.',
      concept: 'Transactional outbox',
      signal: 'Écart entre commandes écrites et événements publiés.',
    },
  },
};

/**
 * Ce qu'une parade coûte au métier, même quand elle tient (D1) : une parade a un prix et une
 * complexité dans le jeu, mais aussi une conséquence pour l'utilisateur. Par effet
 * d'évolution, et `queue` pour le travail différé par une file.
 */
export const paradeCosts: Partial<Record<UpgradeEffect['type'] | 'queue', string>> = {
  queue: 'La file : le travail est différé. Le client a sa réponse avant que le travail soit fait ; pour un paiement, il ne sait pas encore s’il a payé, et il faut savoir annuler la commande si le paiement échoue plus tard.',
  circuitBreaker: 'Le disjoncteur : les appels coupés échouent ; le client reçoit une réponse dégradée, à refaire plus tard.',
  callTimeout: 'Le délai d’attente : le client attend tout le délai avant d’apprendre l’échec.',
  loadShedding: 'Le délestage : des clients sont refusés exprès, pour que les autres soient servis.',
  backoff: 'Le backoff : un client qui a échoué attend plus longtemps avant d’avoir sa réponse.',
  leaderReads: 'La lecture sur le primaire : le primaire porte ces lectures en plus des écritures, et c’est lui qui sature le premier.',
  idempotence: 'L’idempotence : chaque service garde les clés déjà vues, une mémoire à dimensionner et à purger.',
  outbox: 'L’outbox : une écriture de plus par commande, et un relais de plus à faire tourner et à surveiller.',
  autoscaling: 'L’autoscaling : des instances payées plus cher à l’heure, et quelques minutes de démarrage pendant lesquelles le pic n’est pas absorbé.',
  coalescing: 'Le verrou de recalcul : les requêtes qui attendent une entrée en cours de calcul attendent un peu plus.',
  rateLimit: 'La limite par client : un client légitime trop gourmand serait refusé lui aussi.',
  deadLetter: 'La file des lettres mortes : les messages mis de côté ne sont pas traités. La commande a été confirmée au client, mais rien n’est fait tant que quelqu’un ne les a pas examinés et rejoués.',
};
