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

Les deux scénarios partagent une métaphore, **la cité fortifiée** (R2, S1) :

| Technique | Métaphore |
| --- | --- |
| Source de trafic | Hameaux hors les murs |
| Load balancer (rate limiting) | Porte de la cité (caserne de la garde) |
| Serveur d'application | Tour des scribes, une tour par instance |
| Cache | Carnet du scribe |
| Base de données (réplicas) | Archives royales (tours annexes) |
| File de messages | Relais de poste |
| Pub/sub | Crieur public, au clocher |
| CDN | Avant-poste |
| Service métier | Maître de métier (magasinier, trésorier, messager) |
| Lecture, écriture, async | Messager, porteur, mage messager |
| Trafic abusif | Pillards squelettes |

Règle fixe (I6) : le nom technique vient toujours d'abord, la métaphore entre parenthèses.
Le chambellan, qui narre, parle dans la métaphore ; chacune de ses répliques a sa ligne
« En vrai » avec les mots du métier.

## Boucle de jeu

Une partie est une suite de vagues. Chacune passe par quatre phases (I5) :

1. **Briefing** : le chambellan annonce l'information nouvelle et l'incident attendu, s'il
   y en a un. Les chiffres (trafic, budget, SLA) restent affichés sous le récit.
2. **Construction** : le jeu est en pause. Le joueur pose, déplace, relie et retire des
   bâtiments sur le plateau, et achète des évolutions dans la fiche du bâtiment.
3. **Vague** : le trafic est simulé, puis rejoué sur le même plateau. Les jauges et les
   incidents se lisent en direct.
4. **Debrief** : ce qui a marché, ce qui a failli casser, ce qu'on pourrait alléger, avec
   la notion à retenir ; et les courbes tick par tick.

Une vague perdue se rejoue sans limite (E4). On peut revenir au début de toute vague déjà
atteinte, avec l'architecture validée à ce moment-là (E6) : un choix passé se paie, mais ne
bloque jamais la partie.

Un écran de choix ouvre chaque session (S2) : *Les portes de la cité* (débutant) et
*Le grand marché* (suite), sans verrou. Une partie par scénario, sauvegardées ensemble dans
le navigateur.

## Composants, évolutions, incidents

Trois couches : les composants qu'on pose, les évolutions qu'on achète dessus, les
incidents que le scénario envoie. Chaque incident a au moins une parade, et chaque
évolution un compromis, sinon elle devient la réponse à tout.

### Composants

| Composant | Rôle | Dans le jeu |
| --- | --- | --- |
| Source de trafic | Émet les lectures, écritures et événements async de la vague | Oui, déjà posée |
| Load balancer | Répartit le trafic entre les instances ; porte le rate limiting | Oui |
| Serveur d'application | Traite les requêtes, capacité par instance | Oui |
| Cache | Sert une part des lectures en cache-aside : le serveur le consulte, puis lit la base en cas d'absence (I3) | Oui |
| Base de données | Stocke ; goulot classique en écriture | Oui |
| File de messages | Sort un traitement lent du chemin critique ; les consommateurs se partagent ses messages, par lots | Oui |
| Pub/sub | Copie chaque événement vers chacun de ses abonnés (S4) | Oui |
| CDN | Sert les lectures en bordure, devant le load balancer (X1) | Oui |
| Service métier | Service d'une autre équipe, déjà en place : il termine l'événement lui-même, sans base partagée (S10) | Oui, hors palette |
| Stockage objet | Fichiers volumineux hors base | Non |

Tous les composants sont proposés dans tous les scénarios (S7) : savoir écarter ce qui ne
sert à rien fait partie du jeu, et le debrief signale le superflu.

### Évolutions

| Évolution | S'applique à | Résout | Compromis | Dans le jeu |
| --- | --- | --- | --- | --- |
| Scaling horizontal | Serveur | Manque de capacité | Coût par instance ; exige un load balancer ou une file en amont (M5) | Oui |
| Autoscaling | Serveur | Pics de trafic | Démarrage en 2 ticks pendant lesquels des requêtes échouent, +2 de complexité (X2) | Oui |
| Réplica en lecture | Base | Lectures saturées | Coût | Oui |
| Rate limiting | Load balancer | Client abusif | Paliers par client (C1) : trop bas, il coupe des clients légitimes | Oui |
| Idempotence | Service métier | Message livré deux fois | Coût et complexité, les clés vivent dans le service (S5) | Oui |
| Transactional outbox | Base | Événement perdu entre base et bus | Une écriture de plus par commande (S6) | Oui |
| Sharding, consistent hashing, circuit breaker, backpressure | — | — | — | Non |

Retirer ou remplacer un composant coûte sa valeur d'achat ; réduire les instances est
gratuit (E2). La migration entre dans la facture de la vague (E3).

### Incidents

Les incidents sont annoncés au briefing et déterministes (X5) : pas de tirage au sort.

| Incident | Parade | Où |
| --- | --- | --- |
| Hausse des lectures | Cache, réplica, CDN | Raccourcisseur, vague 2 |
| Pic de trafic | Scaling horizontal, autoscaling, CDN | Raccourcisseur, vague 3 |
| Le cache redémarre à froid | Une base qui tient le temps de le réchauffer | Raccourcisseur, vague 2 |
| Une instance du serveur tombe | Redondance : plusieurs instances | Raccourcisseur, vague 3 |
| Client qui spamme | Rate limiting | Raccourcisseur, vague 4 |
| Traitement lent sur le chemin critique | File de messages | Raccourcisseur vague 5, marché vague 1 |
| Message livré deux fois | Idempotence | Marché, vagues 3 et 5 |
| Événement perdu entre base et bus | Transactional outbox | Marché, vagues 4 et 5 |
| Dépendance en panne, expiration massive du cache, partition réseau | Circuit breaker, verrou de recalcul, choix CAP | Pas encore |

## Jauges, victoire et score

Le joueur est coincé entre « pas assez » et « trop » :

| Jauge | Mesure | Punit |
| --- | --- | --- |
| Coût | Facture de la vague : instances, évolutions, migration | Le surdimensionnement |
| Complexité | Points par composant et évolution | L'over-engineering |
| Fiabilité | Taux d'échec de la vague et latence p95 des ticks face au SLA | Le sous-dimensionnement, le composant manquant |

Une vague est gagnée si le SLA est tenu sans dépasser le budget ni le plafond de
complexité. La latence est un p95 des latences par tick, affiché « p95 (approx.) » (M4) ;
elle compte lectures, écritures et événements async, sauf l'async qui passe par une file
(S10).

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
| 2. Les lectures explosent | 900 lectures/s ; le cache redémarre à froid | Cache ou réplica |
| 3. Campagne marketing | Pic à 5 fois le trafic, en rampe ; une instance tombe | CDN + cache, CDN + réplica, scaling + cache, scaling + autoscaling + cache |
| 4. Un client trop gourmand | Un scraper et des partenaires légitimes | Rate limiting au bon palier, avec scaling ou CDN |
| 5. Compter les clics | Chaque redirection émet un événement de clic | File de messages (réponse unique) ; le CDN y perd les clics servis en bordure |

### Le grand marché : la prise de commande d'une boutique

Trois services d'autres équipes (stock, facturation, e-mail) sont déjà sur le plateau, de
l'autre côté de la rivière (S8). Il faut leur faire parvenir chaque commande.

| Vague | Information | Réponse attendue |
| --- | --- | --- |
| 1. Ouverture du marché | Chaque commande émet un événement ; envoyer un mail prend 200 ms | Une file devant le service e-mail ; appelé en direct, il casse la latence |
| 2. Trois services à prévenir | Chacun veut chaque événement | Pub/sub + une file par service ; une file partagée n'en livre qu'un tiers à chacun |
| 3. Livrés deux fois | Le bus relivre une part des messages | Idempotence sur les services |
| 4. Commandes perdues | Le serveur tombe entre l'écriture et la publication | Outbox, et de quoi soulager la base qu'elle charge (cache ou réplica) |
| 5. Les soldes | 1 500 lectures/s, les deux incidents reviennent | Tout, plus une instance derrière un load balancer |

Les budgets, plafonds et seuils de chaque vague sont dans `docs/decisions.md` et verrouillés
par les tests.

## Modèle de simulation

Un graphe de composants traversé par des flux de requêtes, calculé par une fonction pure
et déterministe, séparée de l'affichage.

- **Ticks** (M1) : à chaque tick, le trafic traverse le graphe en ordre topologique. Au-delà
  de sa capacité, un nœud fait échouer l'excédent. Seule la file garde un arriéré d'un tick
  à l'autre.
- **Requêtes typées** : lecture, écriture, événement async. Les liens ne sont pas typés
  (I1) : chaque composant déclare ce qu'il accepte, et un type va au voisin le plus
  spécialisé qui l'accepte.
- **Latence** : chaque nœud a la sienne, qui monte avec sa charge ; elle s'additionne le
  long du chemin critique.
- **Trafic** : il monte au départ et retombe à la fin de chaque vague (S11), avec un profil
  propre à la vague (rampe de la campagne, X4).
- **Pas d'aléa, donc pas de graine** (M2) : la même vague donne toujours le même résultat.
- **Pas de cascade de pannes** (M3) : un aval saturé ne ralentit pas l'amont. Elle viendra
  avec le circuit breaker, sa parade.
- **Sorties** : jauges, facture, journal d'événements, et par tick le débit de chaque lien
  et l'état de chaque nœud (charge, échecs, arriéré, instances en panne, trafic repoussé,
  doublons, événements perdus). Le rendu ne fait que relire ces ticks.

## Rendu et interface

- **Plateau** (R5, R11, R12) : un grand hexagone de cases KayKit, les clients à sa pointe
  gauche, une rivière qu'on ne franchit que par un pont. Vue isométrique en Three.js, on se
  déplace et on zoome, on ne tourne pas.
- **Construction** (I4, I10) : palette de bâtiments, outils Sélection, Relier, Retirer.
  On pose en cliquant ou en glissant depuis la palette ; on déplace un bâtiment en le
  glissant ; on relie en cliquant A puis B, et le plus court chemin de cases se trace seul.
  Annuler et rétablir (⌘Z, ⇧⌘Z). Les chemins sont de la mise en scène : la simulation les
  ignore, et il n'y a pas de géographie (P2).
- **Vague** (R7, R8, R10, R14, R15) : chaque requête est un personnage qui marche des
  hameaux au bâtiment qui la sert, puis revient avec la réponse ; un disque au sol dit son
  type. Pastilles +1, ✕ −1, 🛡. Les problèmes se voient sur place : bâtiment qui tremble et
  fume, porte qui clignote et requête qui rebondit, coursiers en rang devant une file,
  sablier sur le bâtiment le plus lent, mage qui se dédouble, messager qui s'évapore,
  tour en feu, dôme de la garde, et l'alarme quand le SLA est rompu. Tableau de bord,
  alertes à la première saturation, ralenti, courbes en direct.
- **Debrief** (R9, I8) : l'analyse du chambellan en trois temps, et les courbes tick par
  tick (R13).
- **Aide** : tutoriel de la vague 1 (I7), puis une fenêtre « que faire » à chaque vague,
  qui dit ce qui bloque sans souffler la parade (I9, S9).
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
- Équilibrage outillé : `npm run balance` énumère les architectures canoniques du
  raccourcisseur ; les tests verrouillent chaque vague des deux scénarios (gagnée avec la
  réponse attendue, perdue sans elle, perdue sur-dimensionnée).

## Suites

Par ordre d'apport pédagogique :

| Ajout | Intérêt |
| --- | --- |
| Faire jouer 2 ou 3 personnes de la cible, mesurer la durée d'une partie (cible 15 min, B4) | Valider avant d'ajouter |
| Reproduire les fiches du calendrier dans le jeu (P3) | Le jeu se suffit à lui-même |
| Questions de clarification : deux par vague, chacune révèle un paramètre caché | Apprendre à cadrer avant de construire |
| Circuit breaker et cascade de pannes ; incidents avancés (ruée vers le cache, partition réseau) | Thèmes Résilience et Distribué du calendrier |
| Faire compter la longueur des chemins en coût et en latence | Placement stratégique ; impose de tout recalibrer |
| Besoins métier flous à traduire en contraintes | Rapproche le jeu d'un énoncé réel |
| Mode migration (Strangler Fig, Canary, Expand and Contract) | Thème Migration |
| Partage d'une architecture par lien | Dimension sociale |

Les thèmes Équipe et Sécurité du calendrier restent hors du jeu.

## Questions ouvertes

- Cacher les capacités chiffrées une fois le jeu calibré (C4), ou les garder : le calcul
  de capacité est une compétence à apprendre.
- Les arriérés de file n'apparaissent dans aucune vague actuelle : la file envoie par lots
  de 100, ce qui divise le travail en aval. Faut-il une vague où une file déborde ?
- Une alarme de SLA sur la latence, comme celle sur le taux d'échec ?
