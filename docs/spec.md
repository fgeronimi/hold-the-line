# Hold the Line — spécification

Réécrite le 10 novembre 2026 à partir de la spécification MVP du 8 novembre et de toutes
les décisions prises depuis (`docs/decisions.md`). Ce document décrit le jeu tel qu'il est
et tel qu'il doit devenir ; `decisions.md` garde l'historique, avec le pourquoi de chaque
choix. En cas de conflit, la décision la plus récente l'emporte, et ce document se corrige.

## Vision

Un jeu web pédagogique de system design. Le joueur construit une architecture distribuée
bâtiment par bâtiment sur un plateau, puis la fait évoluer vague après vague face à de
nouvelles contraintes : plus de trafic, un client abusif, un message livré deux fois, une
instance qui tombe. Chaque vague apporte une information nouvelle ; il faut adapter
l'architecture sans tout casser.

Le jeu fait **comprendre** le system design ; il n'entraîne pas à l'entretien (P1). Il vise
trois réflexes :

- justifier chaque composant par un besoin précis ;
- arbitrer entre coût, complexité et fiabilité ;
- anticiper ce qu'une décision passée coûtera aux vagues suivantes.

Il prolonge le calendrier [Advent of System Design](https://github.com/fgeronimi/advent-of-system-design).
Les fiches du calendrier seront reproduites dans le jeu (P3), pas seulement citées : le
jeu doit se suffire à lui-même.

### Nom, genre et métaphore

**Hold the Line** est un tower defense où la ligne à tenir est le SLA. Le nom reste
générique ; chaque scénario porte son sous-titre (*Hold the Line : les portes de la cité*).

| Tower defense | Hold the Line |
| --- | --- |
| Vagues d'ennemis | Vagues de trafic et incidents |
| Chemin des ennemis | Chemin des requêtes dans l'architecture |
| Tours posées sur le chemin | Composants posés sur le chemin des requêtes |
| Amélioration d'une tour | Évolution d'un composant |
| Ennemi qui passe, vies perdues | Requête en échec, SLA entamé |
| Budget de la vague | Facture de la vague sous un plafond, sans épargne (E1) |

Les quatre scénarios partagent une métaphore, **la cité fortifiée** (R2, S1) :

| Technique | Métaphore |
| --- | --- |
| Source de trafic | Hameaux hors les murs |
| Load balancer (rate limiting) | Porte de la cité (caserne de la garde) |
| Passerelle d'API (limites par classe) | Bureau des laissez-passer |
| Serveur d'application | Tour des scribes, une tour par instance |
| Worker | Tour des commis, une tour par worker (modèle de la tour des scribes, autre teinte) |
| Cache | Carnet du scribe |
| Base de données (réplicas) | Archives royales (tours annexes) |
| File de messages | Relais de poste |
| Pub/sub | Crieur public, au clocher |
| CDN | Avant-poste |
| Service métier | Maître de métier (magasinier, trésorier, messager) |
| Prestataire de paiement externe | Banquier lombard |
| Lecture, écriture, async | Messager, porteur, mage messager |
| Trafic abusif | Pillards squelettes |

Règle fixe (I6) : le nom technique vient toujours d'abord, la métaphore entre parenthèses.
Le chambellan, qui narre, parle dans la métaphore ; chacune de ses répliques a sa ligne
« En vrai » avec les mots du métier.

## Boucle de jeu

Une partie est une suite de vagues. Chacune passe par quatre phases (I5) :

1. **Briefing** : le chambellan annonce l'information nouvelle et l'incident attendu, s'il
   y en a un. Les chiffres (trafic, budget, SLA) restent affichés sous le récit. Le premier
   briefing de chaque scénario annonce la règle du temps (M7) : une vague montre une heure,
   chaque minute passe en un tick, les débits restent par seconde.
2. **Construction** : le jeu est en pause. Le joueur pose, déplace, relie et retire des
   bâtiments sur le plateau, et achète des évolutions par les pastilles au pied du bâtiment sélectionné (I12), ou dans sa fiche ; cliquer une case vide ouvre les fiches des bâtiments à y construire.
3. **Vague** : le trafic est simulé, puis rejoué sur le même plateau. Les jauges et les
   incidents se lisent en direct.
4. **Debrief** : ce qui a marché, ce qui a failli casser, ce qu'on pourrait alléger, avec
   la notion à retenir ; et les courbes minute par minute.

Une vague perdue se rejoue sans limite (E4). On peut revenir au début de toute vague déjà
atteinte, avec l'architecture validée à ce moment-là (E6) : un choix passé se paie, mais ne
bloque jamais la partie.

Un écran de choix ouvre chaque session (S2) : *Les portes de la cité* (débutant),
*Le grand marché* (suite), *Le banquier lombard* (résilience) et *Le grand tournoi*
(distribué), sans verrou. Une partie par scénario, sauvegardées ensemble dans
le navigateur.

## Composants, évolutions, incidents

Trois couches : les composants qu'on pose, les évolutions qu'on achète dessus, les
incidents que le scénario envoie. Chaque incident a au moins une parade, et chaque
évolution un compromis, sinon elle devient la réponse à tout.

### Composants

| Composant | Rôle | Dans le jeu |
| --- | --- | --- |
| Source de trafic | Émet les lectures, écritures et événements async de la vague | Oui, déjà posée |
| Load balancer | Répartit le trafic entre les instances ; porte le rate limiting, une limite unique pour tous (C1) | Oui |
| Passerelle d'API | Posée à l'entrée, derrière le CDN et devant le load balancer : reconnaît la classe de chaque client (clé d'API ou anonyme) et lui applique la limite de sa classe ; ne répartit pas. Plus chère, plus complexe, et 5 ms de plus pour chaque requête (C7) | Oui |
| Serveur d'application | Traite les requêtes, capacité par instance | Oui |
| Worker | Consomme une file ou un pub/sub, seul autorisé derrière eux avec les services en place ; se dimensionne sur l'arriéré (X8) | Oui |
| Cache | Sert une part des lectures en cache-aside : le serveur le consulte, puis lit la base en cas d'absence (I3) | Oui |
| Base de données | Stocke ; goulot classique en écriture | Oui |
| File de messages | Sort un traitement lent du chemin critique ; les consommateurs se partagent ses messages, par lots | Oui |
| Pub/sub | Copie chaque événement vers chacun de ses abonnés (S4) | Oui |
| CDN | Sert les lectures en bordure, devant le load balancer (X1) | Oui |
| Service métier | Service d'une autre équipe, déjà en place : il termine l'événement lui-même, sans base partagée (S10) | Oui, hors palette |
| Prestataire de paiement | Dépendance externe, déjà en place, qui répond en 300 ms : on l'appelle, on ne la dimensionne pas ; elle peut ralentir ou tomber (S13, S24) | Oui, hors palette |
| Prestataire d'e-mail | Dépendance externe, déjà en place, avec un quota de messages par seconde, regroupés ou non (S20) | Oui, hors palette |
| Stockage objet | Fichiers volumineux hors base | Non |

Tous les composants sont proposés dans tous les scénarios (S7) : savoir écarter ce qui ne
sert à rien fait partie du jeu, et le debrief signale le superflu.

### Évolutions

| Évolution | S'applique à | Résout | Compromis | Dans le jeu |
| --- | --- | --- | --- | --- |
| Scaling horizontal | Serveur, worker | Manque de capacité | Coût par instance ; le serveur exige un load balancer en amont, le worker une file ou un pub/sub (« Worker supplémentaire », M5, X8) | Oui |
| Autoscaling | Serveur | Pics de trafic, surplus après une panne | Démarrage en 2 ticks (2 minutes) pendant lesquels des requêtes échouent, +2 de complexité (X2) ; l'instance à la demande coûte 25 % de plus qu'une fixe (X10) ; une panne la touche comme les autres (M9) | Oui |
| Réplica en lecture | Base | Lectures saturées | Coût | Oui |
| Rate limiting | Load balancer | Client abusif | Paliers par client (C1) : trop bas, il coupe des clients légitimes, et les événements de leurs requêtes rejetées avec eux (C6) | Oui |
| Quota par clé d'API, limite par adresse | Passerelle d'API | Partenaires plus gourmands que l'abusif : aucune limite unique ne les sépare | Mêmes paliers que le rate limiting, chacun pour sa classe (`TrafficSource.class`) ; la passerelle coûte 25 et +2, chaque limite 5 et +1, et ajoute un saut de latence (C7) | Oui |
| Idempotence | Service métier | Message livré deux fois | Coût et complexité, les clés vivent dans le service (S5) | Oui |
| Transactional outbox | Base | Événement perdu entre base et bus | Une écriture de plus par commande (S6) | Oui |
| Circuit breaker | Serveur | Dépendance lente ou en panne qui bloque le serveur | Les appels coupés échouent : réponse dégradée (S15) | Oui |
| Request coalescing | Cache | Ruée vers le cache | Coût et complexité ; ne sert qu'à l'expiration (S15) | Oui |
| Backoff exponentiel et jitter | Clients (la source) | Tempête de relances | Coût et complexité ; ne sert qu'après une panne ; suppose d'écrire le client ; étale les relances sur 15 minutes (S19, X11) | Oui |
| Délai d'attente | Serveur | Dépendance lente ou muette qui retient les fils | Le client attend tout le délai (1 s), puis l'appel échoue (M12, S24) | Oui |
| Délestage | Load balancer | Tempête de relances, surcharge | Les refus restent des échecs, relancés ; la porte garde 25 % de marge (M11) | Oui |
| Capacité de la file | File | Débordement pendant une longue panne de l'aval | Coût par niveau ; n'aide pas si les consommateurs ne suivent pas en moyenne (S20) | Oui |
| Lecture sur le primaire | Base | Lectures périmées pendant une partition | Le primaire porte ces lectures en plus des écritures (S21) | Oui |
| File des lettres mortes | File | Message empoisonné qui bloque la file | Les messages mis de côté après trois essais ne sont pas traités : ils comptent en échec, et il faut les examiner puis les rejouer (S25) | Oui |
| Sharding, consistent hashing | — | — | — | Non |

Retirer ou remplacer un composant coûte sa valeur d'achat ; réduire les instances est
gratuit (E2). La migration entre dans la facture de la vague (E3).

### Incidents

Les incidents sont annoncés au briefing et déterministes (X5) : pas de tirage au sort. Aucun
ne dure moins de cinq minutes (X11) : le p95 voit tout ce qui pèse plus de 5 % des réponses.

| Incident | Parade | Où |
| --- | --- | --- |
| Hausse des lectures | Cache, réplica, CDN | Raccourcisseur, vague 2 |
| Pic de trafic | Scaling horizontal, autoscaling, CDN | Raccourcisseur, vague 3 |
| Le cache redémarre à froid | Une base qui tient le temps de le réchauffer | Raccourcisseur, vague 2 |
| Une instance du serveur tombe | Redondance : plusieurs instances | Raccourcisseur, vague 3 |
| Client qui spamme | Rate limiting | Raccourcisseur, vague 4 |
| Partenaires plus gourmands que le scraper, une clé qui boucle | Limites par classe sur une passerelle d'API | Raccourcisseur, vague 5 |
| Traitement lent sur le chemin critique | File de messages | Raccourcisseur vague 6, marché vague 1 |
| Message livré deux fois | Idempotence | Marché, vagues 3 et 5 |
| Événement perdu entre base et bus | Transactional outbox | Marché, vagues 4 et 5 |
| Dépendance lente : la cascade de pannes | Circuit breaker, ou file (paiement différé) | Banquier, vagues 2 et 5 |
| Tout le cache expire d'un coup | Verrou de recalcul, ou réplica | Banquier, vagues 3 et 5 |
| Dépendance externe en panne | File : paiement différé, livré au retour | Banquier, vague 4 |
| Panne brève, clients qui relancent aussitôt : tempête de relances | Délestage à la porte, ou backoff exponentiel et jitter | Tournoi, vagues 1 et 4 |
| Dépendance externe en panne plus longtemps que la file ne tient | Capacité de la file | Tournoi, vague 2 |
| Partition réseau entre le primaire et ses réplicas | Lectures critiques sur le primaire (choix CAP) | Tournoi, vagues 3 et 4 |
| Message empoisonné : le consommateur plante à chaque essai, la file reste bloquée derrière lui | File des lettres mortes | Marché, vagues 5 et 6 |
| Le worker tombe dix minutes | La file garde les messages, puis se vide au rythme de la base (M8, X6) | Raccourcisseur, vague 6 |

## Jauges, victoire et score

Le joueur est coincé entre « pas assez » et « trop » :

| Jauge | Mesure | Punit |
| --- | --- | --- |
| Coût | Facture de la vague : instances, évolutions, migration | Le surdimensionnement |
| Complexité | Points par composant et évolution | L'over-engineering |
| Fiabilité | Taux d'échec de la vague et latence p95 de ses réponses face au SLA | Le sous-dimensionnement, le composant manquant |

Une vague est gagnée si le SLA est tenu sans dépasser le budget ni le plafond de
complexité. Le SLA demande au plus 1 % d'échecs dans tous les scénarios (B8). La latence est le p95 des réponses de la vague (M15) : à chaque minute, chaque
chemin servi (une lecture servie par le cache, une autre qui l'a raté et attend la base, un
événement traité en direct ou déposé dans une file) pèse son débit, et le p95 se prend sur
toutes ces réponses. Une minorité lente se voit dès qu'elle pèse plus de 5 % des réponses.
L'async qui passe par une file n'attend que la file (S10). Un refus est immédiat et n'est que
dans le taux d'échec ; un appel abandonné par un délai d'attente, ou fait à une dépendance qui
se tait, compte pour son attente. Une vague peut donner son propre objectif à un type de
requête : le marché, le banquier et le tournoi jugent la commande à part (60 ms), parce
qu'elle pèse moins de 5 % des requêtes et que le client l'attend.
Un événement que k services attendus sur n n'ont pas reçu compte pour k / n d'échec : le
taux reste un taux, une commande jamais livrée compte pour une (M14). Une requête échouée
que le client relance n'est pas un échec : sa relance compte à sa place (S19). Chaque source ne relance que ses propres échecs, du même type, et une requête
relancée réémet son événement ; un doublon, une copie non livrée ou une lecture périmée ne
se relancent pas (M10).

**Trois étoiles par vague** (E7) : tenir la vague, la tenir du premier coup, rester
économe (facture sous le seuil de la stratégie gagnante la moins chère).

**Score** (E5) : 100 × la moyenne des marges sur les jauges, moins 20 % par rejeu, sans
jamais descendre sous zéro ; l'écran le dit (« la vague ne rapporte plus de points »)
plutôt que d'afficher une pénalité au-delà de 100 %.

Plusieurs bonnes réponses doivent exister par vague, avec des profils différents (B1, B2) :
une vague à réponse unique le déclare dans ses données.

## Scénarios

### Les portes de la cité : un raccourcisseur d'URL

| Vague | Information | Réponses gagnantes |
| --- | --- | --- |
| 1. Lancement | 100 req/s, 90 % de lectures | Serveur + base (tutoriel, réponse unique) |
| 2. Les lectures explosent | 900 lectures/s ; le cache redémarre à froid | Cache, réplica, ou CDN (X9) |
| 3. Campagne marketing | Pic à 5 fois le trafic, en rampe ; une instance tombe | CDN + cache, scaling + cache, scaling + autoscaling + cache (sur 3 instances fixes) |
| 4. Un client trop gourmand | Un scraper, et des partenaires légitimes qui appellent une API non cachable en bordure (X7) | Rate limiting au palier 40, avec scaling ou CDN (une instance de plus derrière lui) ; sur ce trafic qui ne retombe pas, l'autoscaling coûte trop (X10) |
| 5. À chacun sa limite | 12 partenaires à 125 req/s par clé, une clé qui boucle à 2 000 req/s, un scraper sur 20 adresses à 60 req/s : aucune limite unique ne les sépare (C7) | Une passerelle d'API : 160 par clé, 10 par adresse ; derrière un CDN avec deux instances de plus, ou sans CDN avec quatre instances de plus et un réplica (le saut de latence coûte une instance) |
| 6. Compter les clics | Chaque redirection émet un événement de clic ; le worker tombe dix minutes | File de messages et worker, avec la passerelle (réponse unique) ; la file garde les clics et se vide au rythme de la base ; le CDN y perd les clics servis en bordure |

### Le grand marché : la prise de commande d'une boutique

Trois services d'autres équipes (stock, facturation, e-mail) sont déjà sur le plateau, de
l'autre côté de la rivière (S8). Il faut leur faire parvenir chaque commande.

| Vague | Information | Réponse attendue |
| --- | --- | --- |
| 1. Ouverture du marché | Chaque commande émet un événement ; envoyer un mail prend 200 ms | Une file devant le service e-mail ; appelé en direct, il casse la latence |
| 2. Trois services à prévenir | Chacun veut chaque événement | Pub/sub + une file par service ; une file partagée n'en livre qu'un tiers à chacun |
| 3. Livrés deux fois | Le bus relivre une part des messages | Idempotence sur les services |
| 4. Commandes perdues | Le serveur tombe entre l'écriture et la publication | Outbox, et de quoi soulager la base qu'elle charge (cache ou réplica) |
| 5. Une commande empoisonnée | Pendant cinq minutes, 5 % des commandes font planter chaque service qui les lit | Une file des lettres mortes sur chaque file ; sans elle, la file reste bloquée jusqu'à la fin |
| 6. Les soldes | 1 500 lectures/s, les trois incidents reviennent | Tout, plus une instance derrière un load balancer, et cache et réplica pour la base que l'outbox charge |

### Le banquier lombard : un paiement chez un prestataire externe

Le prestataire de paiement est déjà sur le plateau, hors de la cité (S12). Chaque commande
y est payée.

| Vague | Information | Réponse attendue |
| --- | --- | --- |
| 1. Le paiement en ligne | Le prestataire répond en 300 ms ; la commande payée a 500 ms, le reste 60 ms (SC6) | L'appeler en direct suffit (réponse unique) |
| 2. Le banquier traîne | Pendant 5 minutes, 4 s par paiement | Circuit breaker, ou une file ; sans eux, la cascade fait tomber tout le serveur |
| 3. Minuit, tout expire | 750 lectures/s, tout le cache expire d'un coup | Cache + verrou de recalcul, ou un réplica |
| 4. Le banquier ferme | Le prestataire tombe 25 minutes (25 ticks) | Une file : les paiements attendent et partent à la réouverture |
| 5. La grande foire | 2 200 lectures/s, les deux incidents reviennent | Scaling, réplicas, verrou, et disjoncteur ou file |

### Le grand tournoi : une billetterie prise d'assaut

Le prestataire d'e-mail (le colombier) est déjà sur le plateau, avec son quota (S18). Les
clients relancent tout de suite ce qui échoue, jusqu'à cinq fois (S19, X11) : ces clients sont
votre application, vous en écrivez le code, c'est pourquoi vous pouvez y régler les relances.

| Vague | Information | Réponse attendue |
| --- | --- | --- |
| 1. L'ouverture des ventes | Un déploiement raté arrête tous les serveurs 5 minutes, instances à la demande comprises (M9, X11) | Délestage à la porte, ou backoff sur les clients ; sinon la tempête dure jusqu'à la fin |
| 2. Les pigeons restent au colombier | Le prestataire d'e-mail tombe une demi-heure (30 minutes), 8 000 alertes/s | Une file avec de la capacité en plus |
| 3. Le registre coupé en deux | Lectures non cachables et vérification de la place avant achat, partition des réplicas (un quart d'heure, S23) | Réplicas, et lectures critiques sur le primaire |
| 4. La joute finale | Les trois incidents | Backoff, et scaling ou autoscaling ; réplica et lecture sur le primaire |

Les budgets, plafonds et seuils de chaque vague sont dans `docs/decisions.md` et verrouillés
par les tests.

## Modèle de simulation

Un graphe de composants traversé par des flux de requêtes, calculé par une fonction pure
et déterministe, séparée de l'affichage.

- **Ticks** (M1) : à chaque tick, le trafic traverse le graphe en ordre topologique. Au-delà
  de sa capacité, un nœud fait échouer l'excédent. Seule la file garde un arriéré d'un tick
  à l'autre. **La file impose le rythme de l'aval** (M8) : un message qu'un nœud en aval
  ne peut pas traiter n'est pas acquitté et retourne dans sa file ; il passe après le trafic
  direct, et compte dans l'arriéré maximal. **Message empoisonné** (S25) : son consommateur
  plante à chaque essai ; la file sert dans l'ordre et ne relâche plus que lui, tant qu'elle le
  garde. Sans file des lettres mortes, elle est bloquée pour de bon et ce qui attend derrière
  compte en non livré ; avec, il est mis de côté après trois essais, compté en échec à part.
- **Le temps** (M7) : un tick vaut une minute, une vague de 60 ticks montre une heure. Les
  débits restent en requêtes par seconde. Le joueur lit des minutes (« de la 31ᵉ à la 33ᵉ
  minute »), le code et le mode debug des ticks. Aucun chiffre n'a été recalibré ; limite
  assumée : les compteurs cumulés (arriéré d'une file, requêtes en échec) additionnent un
  débit par seconde une fois par tick, donc à l'échelle du jeu, pas en volumes réels. La
  capacité d'une file se lit en minutes de trafic (arrivées par seconde × minutes d'attente).
- **Classes de clients** (C7) : une source déclare sa classe (clé d'API d'un partenaire, ou
  anonyme). Une limite de classe ne voit que les siens ; la limite unique voit tout le monde.
- **Requêtes typées** : lecture, écriture, événement async. Les liens ne sont pas typés
  (I1) : chaque composant déclare ce qu'il accepte, et un type va au voisin le plus
  spécialisé qui l'accepte.
- **Latence** : chaque nœud a la sienne, qui monte avec sa charge ; elle s'additionne le
  long du chemin critique. Le p95 se prend sur les chemins servis, pondérés par leur débit
  minute par minute (M15).
- **Trafic** : il monte au départ et retombe à la fin de chaque vague (S11), avec un profil
  propre à la vague (rampe de la campagne, X4).
- **Pas d'aléa, donc pas de graine** (M2) : la même vague donne toujours le même résultat.
- **Clients qui relancent** (S19, M10) : un nœud saturé travaille pour des requêtes déjà
  abandonnées, mais seulement pour la part de son trafic venue de ces clients.
- **Dépendance muette** (M12) : une dépendance fermée se tait, et chaque appel direct garde
  un fil jusqu'au délai du client (5 s) ; des instances arrêtées, elles, refusent tout de
  suite. Le délai d'attente borne cette attente, le disjoncteur la supprime.
- **Âge des files** (M13) : chaque file dit depuis combien de minutes attend son plus vieux
  message ; le debrief l'alerte au-delà de dix minutes.
- **Pannes d'instances** (X5, M9) : une panne retire d'abord des instances fixes, puis des
  instances à la demande, y compris celles qui démarrent pendant la panne.
- **Cascade par les fils d'exécution** (S14) : un serveur a des fils par instance, et un
  appel direct en garde un le temps de la réponse de l'aval (loi de Little). Une
  dépendance lente les épuise et le serveur sature pour tout le monde. Il n'y a pas
  d'autre cascade : un aval simplement saturé ne ralentit pas l'amont (M3).
- **Sorties** : jauges, facture, journal d'événements, et par tick le débit de chaque lien
  et l'état de chaque nœud (charge, fils occupés, circuits coupés, échecs, arriéré,
  instances en panne, trafic repoussé, doublons, événements perdus, messages empoisonnés,
  lettres mortes). Le rendu ne fait que relire ces ticks.

## Rendu et interface

- **Plateau** (R5, R11, R12) : un grand hexagone de cases KayKit, les clients à sa pointe
  gauche, une rivière qu'on ne franchit que par un pont. Vue isométrique en Three.js, on se
  déplace et on zoome, on ne tourne pas.
- **Construction** (I4, I10) : palette de bâtiments, outils Sélection, Relier, Retirer.
  On pose en cliquant ou en glissant depuis la palette ; posé sur un chemin, un bâtiment
  s'insère dans le lien quand c'est sensé (I11) ; on déplace un bâtiment en le
  glissant ; on relie en cliquant A puis B, et le plus court chemin de cases se trace seul.
  Annuler et rétablir (⌘Z, ⇧⌘Z). Cliquer une case vide ouvre les fiches des bâtiments à y
  construire ; au pied du bâtiment sélectionné, des pastilles pour le déplacer, le retirer et
  acheter ses évolutions (I12). Les évolutions se voient : fondations et chantier de
  l'autoscaling sur une case voisine, guérite du disjoncteur, icônes sous le nom. Des
  panneaux au bord des chemins donnent le sens des liens (I13). Les chemins sont de la mise
  en scène : la simulation les ignore, et il n'y a pas de géographie (P2).
- **Vague** (R7, R8, R10, R14, R15) : chaque requête est un personnage qui marche des
  hameaux au bâtiment qui la sert, puis revient avec la réponse ; un disque au sol dit son
  type. Pastilles +1, ✕ −1, 🛡. Les problèmes se voient sur place : bâtiment qui tremble et
  fume, porte qui clignote et requête qui rebondit, coursiers en rang devant une file,
  sablier sur le bâtiment le plus lent, mage qui se dédouble, messager qui s'évapore,
  tour en feu, dôme de la garde, vapeur verte d'un consommateur qui plante sur un message
  empoisonné et pile des lettres mortes au pied de la file, mages figés devant une dépendance lente, barrière du
  circuit coupé, et l'alarme quand le SLA est rompu, sur les échecs ou sur
  la latence. Capacités, coûts et débits restent chiffrés partout (C4). Tableau de bord,
  alertes à la première saturation, ralenti, courbes en direct.
- **Debrief** (R9, I8, I15) : l'analyse du chambellan en trois temps, et les courbes minute par
  minute (R13). Chaque constat dit ce qui l'aurait annoncé ; une ligne dit ce qu'ont coûté les
  parades en place ; le serveur le plus chargé reçoit son calcul de capacité.
- **Fiches** (I15) : chiffres du jeu, puis une ligne « en vrai » avec l'ordre de grandeur réel
  et sa source quand un chiffre vient d'un fournisseur.
- **Aide** : tutoriel de la vague 1 (I7), puis une fenêtre « que faire » à chaque vague,
  qui dit ce qui bloque sans souffler la parade (I9, S9). Un bouton « Un indice », dans cette
  fenêtre et dans le debrief d'une vague perdue, donne le prochain élément manquant (I14) :
  **un indice par essai perdu**, cumulés sur la vague, vidés à la victoire et au retour en
  arrière, et pas de bouton « toute la solution ». L'indice est déduit des réponses
  attendues de la vague (`Wave.answers`), sans texte écrit par vague : il vise la réponse
  atteignable la plus proche du brouillon, et propose le retour en arrière (E6) quand aucune
  ne l'est. Il désigne un élément, pas une case.
- **Mode debug** (`?debug` ou D) : essais hors partie, vue tableau, calibrage, détail des
  tentatives. `vitrine.html` montre chaque effet d'incident seul.

## Architecture du code

- Site statique sans backend, TypeScript et Vite, publié sur GitHub Pages.
- Moteur pur dans `src/engine/` : `simulateWave(architecture, vague, catalogue, précédente?)`.
- Composants, évolutions, scénarios et thème en données (`src/data/`) : une suite ne
  touche pas au moteur.
- Rendu dans `src/render/`, chargé à la demande ; interface sans framework dans `src/ui/`.
- Progression dans le navigateur ; la sauvegarde ne copie le catalogue et le scénario que
  s'ils ont été calibrés à la main.
- Équilibrage outillé : `npm run balance` énumère les architectures canoniques de chaque
  scénario (B5) ; les tests verrouillent chaque vague (gagnée avec la réponse attendue,
  perdue sans elle, perdue sur-dimensionnée).

## Suites

Par ordre d'apport pédagogique :

| Ajout | Intérêt |
| --- | --- |
| Faire jouer 2 ou 3 personnes de la cible, mesurer la durée d'une partie (cible 15 min, B4) | Valider avant d'ajouter |
| Reproduire les fiches du calendrier dans le jeu (P3) | Le jeu se suffit à lui-même |
| Questions de clarification : deux par vague, chacune révèle un paramètre caché | Apprendre à cadrer avant de construire |
| Faire compter la longueur des chemins en coût et en latence | Placement stratégique ; impose de tout recalibrer |
| Besoins métier flous à traduire en contraintes | Rapproche le jeu d'un énoncé réel |
| Mode migration (Strangler Fig, Canary, Expand and Contract) | Thème Migration |
| Partage d'une architecture par lien | Dimension sociale |

Les thèmes Équipe et Sécurité du calendrier restent hors du jeu.
