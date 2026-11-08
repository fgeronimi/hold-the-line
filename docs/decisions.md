# Décisions de design — phase 1

Tranchées le 8 novembre 2026, après le premier jet du moteur. Elles complètent ou
corrigent la spec MVP ; en cas de conflit, ce fichier l'emporte.

Statut : **à appliquer** = décidé mais pas encore dans le code.

## Moteur

| # | Décision | Pourquoi | Statut |
|---|---|---|---|
| M1 | Modèle de flux par ticks pour tout le MVP, pas de simulation à événements discrets. | Suffit pour l'équilibrage et le rejeu en phase 2 ; un moteur à événements serait plus lourd à calibrer et à tester. | Fait |
| M2 | Pas de graine : le moteur n'a aucun aléa. Elle reviendra avec le premier élément aléatoire. | Un paramètre inutilisé n'a rien à faire dans la signature. | Fait |
| M3 | Pas de cascade de pannes dans le MVP ; elle arrive en V2 avec le circuit breaker (concurrence limitée des serveurs). | Sans parade disponible, la cascade serait une punition, pas un choix. | Reporté V2 |
| M4 | Le SLA porte sur le taux d'échec global et sur la latence p95 des ticks, affichée « p95 (approx.) ». | Une moyenne cache les pics ; « p95 » colle au vocabulaire d'entretien, « approx. » évite de mentir sur ce qui est mesuré. | Fait |
| M5 | `requiresUpstream` devient une liste ; le scaling horizontal est permis derrière un load balancer **ou** une file. | Plusieurs workers consommant une même file est le pattern standard. | Fait |

## Économie et progression

| # | Décision | Pourquoi | Statut |
|---|---|---|---|
| E1 | Le coût est une facture par vague sous un plafond, sans réserve qui s'accumule. Retirer « or gagné entre les vagues » de la table des métaphores de la spec. | Colle au cloud réel : on paie ce qui tourne. Une épargne n'apprend rien en system design. | Fait (spec à corriger) |
| E2 | Retirer ou remplacer un composant coûte une fois sa valeur d'achat. Réduire les instances est gratuit ; retirer un réplica ou désactiver le rate limiting coûte. Réglé par évolution dans les données (`removalCost`). | Sans friction, défaire ne coûte rien et le réflexe « anticiper le coût d'une décision passée » disparaît. | Fait |
| E3 | Le coût de migration entre dans la facture de la vague, contre le même plafond ; le debrief l'affiche sur une ligne « migration ». | C'est la leçon : un choix de la vague 2 peut coûter la vague 3. | Fait (affichage debrief à faire) |
| E4 | Une vague perdue se rejoue sans limite, depuis l'architecture de fin de la vague précédente. Pas de défaite définitive en phase 1. | Refaire les vagues déjà gagnées n'apprend rien. | Fait (`engine/game.ts`) |
| E6 | On peut revenir au début de toute vague déjà atteinte, avec l'architecture validée à ce moment-là ; le retour compte comme un rejeu de la vague visée et efface les scores suivants. | Sans ça, un choix passé peut bloquer la partie : depuis le parcours CDN (vagues 3 et 4), aucune architecture ne gagne la vague 5, et le rejeu repartait toujours de la vague 4. | Fait |
| E5 | Score d'une vague = 100 × moyenne des marges (coût, complexité, échecs, latence), bornée à [0, 1], moins 20 % par rejeu. Score de partie = somme des vagues. Coefficients en données. | Récompense la marge, comme le dit la spec, et pénalise les essais à l'aveugle. | Fait |

## Compromis

| # | Décision | Pourquoi | Statut |
|---|---|---|---|
| C1 | Le rate limiting se règle par paliers définis en données (10, 20, 40, 80, 160 req/s par client) ; le niveau de l'évolution est l'index du palier. | Rend réel le compromis « peut rejeter du trafic légitime », et donne des valeurs discrètes à l'énumération et aux menus. | Fait |
| C2 | Une source « partenaires » légitime à fort débit (ordre de grandeur : 50 clients à 30 req/s) dès la vague 4, scraper recalibré pour qu'une fenêtre de limite gagnante existe sans être évidente. | Avec des clients légitimes tous identiques, toute limite au-dessus de leur débit est gratuite. | Fait : 50 partenaires à 30 req/s, scraper sur 5 adresses à 400 req/s ; seul le palier 40 gagne |
| C3 | Péremption du cache et retard de réplication hors MVP. | Le raccourcisseur a des données immuables : aucune vague ne peut les punir. | Reporté |
| C5 | Le rate limiting ne compte que le trafic synchrone ; l'async (un clic par redirection) suit le sort de sa requête sans entamer le quota. | Un événement de clic est un effet de bord côté serveur, pas une requête du client. Sans ça, la vague 5 coupait les partenaires. | Fait |
| C4 | Capacités, poids et coûts visibles en phase 1. Les cacher en phase 2 se décidera après les premiers tests de jeu. | Impossible de calibrer à l'aveugle. | Fait |

## Équilibrage

| # | Décision | Pourquoi | Statut |
|---|---|---|---|
| B1 | Critère de sortie assoupli : au moins deux stratégies gagnantes sur la majorité des vagues. Une vague à réponse unique le déclare dans ses données (vague 5 : file + worker). | Certaines contraintes ont une seule bonne réponse, et c'est pédagogiquement juste. Vagues à réponse unique : 1 (tutoriel) et 5 (la file). | Fait |
| B2 | Deux architectures gagnantes sont des stratégies distinctes si leur ensemble de composants et d'évolutions activées diffère, niveaux ignorés. Seules comptent les stratégies **non dominées** : un groupe est dominé si chacune de ses architectures gagnantes gagne encore privée d'un de ses éléments (avec ce qui en dépend). | Sinon « 4 instances » et « 5 instances » comptent comme deux stratégies, et « LB posé pour rien » compte comme une alternative. Un premier essai, « sur-ensemble d'un groupe gagnant », écartait à tort l'autoscaling, qui ajoute un élément utile à « scaling + cache ». | Fait |
| B3 | L'énumération porte sur une topologie canonique : présence de chaque composant, niveaux d'évolution, paliers de rate limiting. Les schémas exotiques se testent à la main. | Énumérer tous les graphes explose et produit surtout de l'absurde. | Fait : `npm run balance`, 2 928 architectures |
| B4 | Durée cible : 15 minutes pour 5 vagues, environ 3 minutes par vague. Au-delà de 20 minutes en test, on retire des vagues plutôt que de raccourcir le debrief. | Ferme le dernier critère de sortie « à fixer » de la spec. | Cible |

## Interface

| # | Décision | Pourquoi | Statut |
|---|---|---|---|
| I1 | Les liens ne portent plus de type de requête : le joueur relie des composants, le moteur déduit le chemin. Chaque composant déclare les types qu'il accepte ; un type va au voisin le plus spécialisé qui l'accepte (cache pour les lectures, file pour l'async), sinon au généraliste. Le schéma affiche ce qui circule réellement sur chaque lien. Les types restent dans le moteur. | Cocher read, write et async par lien n'offrait aucun vrai choix (personne n'envoie ses lectures en base à côté d'un cache) et alourdissait la construction. Sans les types dans le moteur, cache, réplicas, file et rate limiting perdraient leur sens. | Fait ; équilibrage inchangé |

| I2 | Pas de lien vers le calendrier dans le debrief. Le champ `conceptRef` des vagues reste : le contenu des fiches servira à écrire des explications dans le jeu. | Envoyer le joueur hors du jeu casse la boucle ; l'explication doit venir au moment où la vague casse. | Lien retiré ; explications à faire (lire `concepts.js`, repo voisin, `--add-dir` nécessaire) |

## Élargissement du MVP

Sans lui, le raccourcisseur n'avait qu'une vague à vrai choix sur cinq : pour des lectures
massives et immuables, le cache est la seule réponse sensée, et rien d'autre que le
scaling permanent ne soulage le serveur au pic. Un essai par des réplicas plus gros a
échoué : le budget nécessaire laissait gagner le sur-dimensionnement.

| # | Décision | Pourquoi | Statut |
|---|---|---|---|
| X1 | Le **CDN** entre dans le MVP : comportement `edge`, devant le load balancer, sert 80 % des lectures en bordure. Les tâches async d'une requête servie en bordure n'ont jamais lieu (échec `lost-at-edge`). | Alternative peu chère au scaling en vague 3, avec un piège à retardement : en vague 5, les clics des redirections en cache sont perdus. C'est le débat 301 contre 302, une vraie question d'entretien sur ce sujet. | Fait |
| X2 | L'**autoscaling** entre dans le MVP : évolution du serveur, plafond d'instances en niveau, démarrage en 2 ticks, cible de 70 % de charge, instances facturées au prorata de leurs ticks de service. Réduire est immédiat. | Moins cher que le scaling permanent sur un pic court, mais des échecs pendant la montée en charge et +2 de complexité : le compromis de la spec. Sans socle d'instances fixes, il arrive trop tard. | Fait |
| X3 | Une source peut être en **longue traîne** (`longTail`) : ses lectures ne tombent dans aucun cache, CDN compris. Le scraper l'est. | Un crawler visite tous les liens. Sans ça, le CDN absorbait le scraper et rendait le rate limiting inutile en vague 4. | Fait |
| X4 | La vague 3 monte en rampe sur 4 ticks (×2, ×3,5, puis ×5) au lieu d'un saut. | Une campagne monte en quelques secondes ; un saut instantané rendait l'autoscaling injouable. | Fait |

## Calibrage actuel du raccourcisseur

| Vague | Budget | Plafond complexité | Stratégies non dominées (énumération) |
|---|---|---|---|
| 1 | 100 | 4 | serveur + base (réponse unique assumée) |
| 2 | 115 | 7 | cache (85) · réplica (110) |
| 3 | 170 | 9 | CDN + cache (145) · CDN + réplica (170) · LB + scaling + cache (155) · LB + scaling + autoscaling + cache (136 avec 2 instances fixes) |
| 4 | 165 | 9 | LB + scaling + rate limiting + cache (160) · CDN + LB + rate limiting + cache (160) ; paliers gagnants : 40 et 80 |
| 5 | 225 | 12 | LB + scaling + rate limiting + cache + file (225 avec 5 instances, 205 avec 4) (réponse unique assumée) |

SLA constant : 1 % d'échecs, 60 ms de latence p95. Scraper : 2 adresses à 1 000 req/s,
en longue traîne. Critères de sortie : aucune architecture ne gagne les 5 vagues, et
3 vagues sur 5 ont au moins deux stratégies.

## Prochaines étapes

1. Jouer et calibrer dans l'interface jusqu'aux critères de sortie, durée de partie
   comprise (B4).
2. Faire jouer 2 ou 3 personnes de la cible : publier sur GitHub Pages (dépôt distant
   et workflow de déploiement à créer).
3. Explications en jeu tirées des fiches du calendrier (I2).
4. Corriger la spec : colonne MVP du CDN et de l'autoscaling, « or gagné » (E1).
