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
| E7 | **Trois étoiles par vague**, une par objectif : tenir la vague, la tenir du premier coup, et rester économe (facture ≤ `thriftyCost`, calé sur la stratégie gagnante la moins chère). Le score reste à côté. | Des objectifs lisibles avant de jouer, là où le score est une moyenne de marges opaque. L'étoile d'économie récompense la réponse la plus fine sans punir les autres stratégies, qui gagnent quand même. | Fait |
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

| I3 | Le cache est en **cache-aside** : le serveur le consulte, et en cas d'absence lit lui-même la base. On relie serveur → cache et serveur → base ; un cache ne peut alimenter aucun composant. Le CDN reste en ligne, devant le serveur. | Le modèle précédent était un cache read-through (serveur → cache → base) : faux pour le pattern attendu en entretien, et contre-intuitif à câbler. Retour de jeu de François. | Fait ; équilibrage inchangé |
| I4 | **Construction sur le plateau hexagonal**, devenu l'écran principal : palette de bâtiments, outils Sélection / Relier / Retirer, fiche du bâtiment (évolutions, chemins, déplacer, retirer), facture et lancement dans un panneau latéral ; la vague se rejoue sur le même plateau. On relie en cliquant A puis B : le plus court chemin de cases (A*) qui contourne les bâtiments est tracé seul ; un bâtiment posé ou déplacé fait retracer les chemins concernés. Les cases et chemins sont gardés sur l'architecture (`ArchNode.cell`, `ArchLink.path`) mais **ignorés par la simulation**. Les tableaux HTML restent en « vue tableau » repliée. | Le joueur construit lui-même, comme dans un vrai jeu de construction. Chemins décoratifs d'abord pour valider l'ergonomie sans toucher au moteur ni à l'équilibrage. Piste ouverte : faire compter la longueur des chemins (coût, latence), ce qui rendrait le placement stratégique mais imposerait de recalibrer. | Fait |
| I5 | **Mode jeu plein écran.** Le plateau occupe toute la fenêtre ; l'interface flotte par-dessus en panneaux HTML habillés (parchemin, bois) : barre du haut (vague, coût, complexité, SLA, score, menu), barre d'outils du bas (outils, bâtiments avec icône et coût, « Lancer la vague »), fiche du bâtiment à droite. Déroulé en phases : briefing du chambellan → construction → vague jouée **en direct** sur le plateau (barre de vague, « Passer ») → debrief en fenêtre (« Vague suivante », « Réessayer », « Revoir la vague »). Le **mode debug** (`?debug` ou touche D) ouvre un tiroir : essais hors partie, vue tableau, calibrage, détail chiffré et comparaison des tentatives. | « Tout en 3D, en mode jeu » demandé par François : l'interface en listes devenait l'outil de calibrage, pas le jeu. HTML plutôt que rendu dans la scène : texte net, accessible, rapide à faire évoluer. | Fait |
| I6 | **Double narration, termes techniques d'abord.** Le chambellan parle dans la métaphore ; sous chaque réplique, une ligne en italique « En vrai » dit la même chose avec les mots d'entretien. Partout ailleurs (barre d'outils, étiquettes, fiche, alertes, légende), le nom technique vient en premier et la métaphore entre parenthèses. | La métaphore seule ne s'apprend pas : le joueur doit sortir en sachant ce qu'est un load balancer, pas une porte de la cité. |  Fait |
| I7 | **Tutoriel de la vague 1**, déduit du brouillon (`tutorialStep`) : poser le serveur, relier les clients, poser la base, relier, lancer. Le bouton à utiliser clignote. | Sans compteur d'étapes, le guide suit un joueur qui construit dans le désordre, défait ou passe par la vue tableau. | Fait |
| I8 | **Le debrief raconte la vague en trois temps** : ce qui a marché (la part de chaque bâtiment, chiffrée), ce qui a failli casser dans l'ordre où c'est arrivé, puis ce qu'on pourrait alléger. Rouge seulement si la vague est perdue ; un incident encaissé est une alerte orange. Une saturation pendant un incident est racontée par l'incident, pas comme un goulot. Un bâtiment est jugé superflu si la vague, rejouée sans lui, respecte encore le SLA. Chaque bâtiment a une phrase « à quoi ça sert », dans la métaphore et en vrai. | Le premier debrief empilait des constats en rouge sur une vague gagnée et conseillait de retirer le cache parce qu'il était peu chargé, alors qu'il servait 95 % des lectures. | Fait |
| I2 | Pas de lien vers le calendrier dans le debrief. Le champ `conceptRef` des vagues reste : le contenu des fiches servira à écrire des explications dans le jeu. | Envoyer le joueur hors du jeu casse la boucle ; l'explication doit venir au moment où la vague casse. | Lien retiré ; explications à faire (lire `concepts.js`, repo voisin, `--add-dir` nécessaire) |

## Phase 2 : rendu

| # | Décision | Pourquoi | Statut |
|---|---|---|---|
| R1 | Rendu en **Three.js**, caméra orthographique en vue isométrique, low-poly. Chargé à la demande au premier rejeu (138 Ko gzip), l'interface de construction reste légère. | Ambiance 3D voulue par François ; le moteur TS reste tel quel. Godot aurait imposé de porter le moteur ; le template claude-code-game-studios n'apporte rien au web. | Fait (spike) |
| R2 | Métaphore du raccourcisseur : **la cité fortifiée** (*Les portes de la cité*), qui remplace la ville à l'heure de pointe, jugée trop proche d'un plan de serveurs. Hameaux hors les murs = source, porte de la cité = load balancer (herse baissée = rate limiting), tours des scribes = serveurs (une tour par instance), carnet du scribe = cache, archives royales = base (annexes = réplicas), relais de poste = file, avant-poste = CDN. Messager = lecture, charrette = écriture, pigeon voyageur = async ; requête en échec = demi-tour rouge ; trafic abusif = pillards repoussés à la porte ; saturation = bâtiment qui rougit et file de messagers ralentis. Le nom technique reste affiché sous le nom de la métaphore. | Fait de Hold the Line un vrai tower defense (tenir la porte, repousser les pillards) et le démarque nettement de Server Survival. Le thème est une donnée (`src/data/themes/fortified-city.ts`). | Fait |
| R4 | Bâtiments, remparts, arbres et sol en modèles **KayKit Medieval Hexagon Pack** (Kay Lousberg, CC0), dans `public/models/kaykit/` : seuls les modèles utilisés, crédits dans `public/models/CREDITS.md`. Hameaux = maisons et puits, porte = mur percé entre deux tours, rate limiting = caserne de la garde accolée à la porte, scribes = tours (une par instance), carnet = marché, archives = château (réplicas = tours annexes), relais de poste = taverne et enclos ; sol en tuiles d'herbe hexagonales instanciées. Éclairage neutre. Les requêtes restent des formes simples. | Un premier essai en Kenney (Castle Kit + Retro Fantasy Kit) mélangeait aplats et pixel art, avec une pierre saumon : rejeté par François. KayKit a un style unique et homogène et des pièces qui collent mieux à la métaphore (château, caserne, taverne). | Fait |
| R5 | Le plateau est une **grille hexagonale** (coordonnées axiales, pointe en haut, alignée sur les tuiles KayKit) : chaque bâtiment occupe une case, chaque lien est un chemin de cases adjacentes pavées de terre, que les véhicules suivent de centre en centre. Les tuiles sont légèrement espacées pour que la grille se lise. Logique dans `src/render/hex.ts` (pure, testée). | François veut voir les hexagones, et à terme le joueur posera lui-même ses bâtiments et tracera ses chemins sur cette grille : le rendu adopte dès maintenant la forme que prendra la construction. Le style KayKit (amusant, simple, peu détaillé) est confirmé, arbres compris. | Fait ; placement encore automatique |
| R6 | Plus de remparts autour de la cité. | Un rectangle de murs coupait la grille hexagonale en biais et encombrait le plateau ; la porte et ses deux tours suffisent à porter l'idée de cité à défendre. Demandé par François. | Fait |
| R7 | Les requêtes sont des **personnages KayKit** (Adventurers et Skeletons, CC0) : Rogue = messager (lecture), Barbarian = porteur (écriture), Mage = mage messager (async), Skeleton Warrior = pillards (scraper), le messager teinté de rouge = requête en échec qui fait demi-tour. Chaque personnage est figé dans une pose de sa marche au chargement et fusionné en une géométrie instanciée, avec un sautillement ; il se retourne sur le chemin du retour. Fichiers allégés par `scripts/strip-characters.mjs` (une animation, accessoires choisis) : 1,3 Mo au lieu de 20. | Mêmes auteur et style que les bâtiments ; des centaines de personnages squelettés animés seraient trop lourds, la pose figée s'instancie comme une boîte. Aucun pack du style n'a de charrette ni de pigeon : les noms de la métaphore suivent les personnages. | Fait |
| R8 | Les requêtes font des **trajets complets** : des hameaux jusqu'au bâtiment qui les sert, puis retour par le même chemin avec la réponse (l'aller tient un côté du chemin, le retour l'autre). À chaque bâtiment, le lien de sortie est tiré au prorata des débits réels du tick (succès du cache vers le carnet, absences vers les archives), et le refus dans la proportion des échecs du bâtiment : la requête refusée revient en rouge. L'async fait un aller simple ; les pillards sont refoulés à la porte. Une **pastille** monte : +1 👍 au-dessus des hameaux quand la réponse revient (une requête n'a réussi qu'une fois la réponse reçue), −1 👎 au-dessus du bâtiment qui refuse, 🛡 à la porte pour un pillard repoussé ; un async, sans retour, compte au bout de son aller. Tirages déterministes, logique dans `src/render/traffic.ts`. | Demandé par François : voir une requête aller en base et revenir aux hameaux, et lire d'un coup d'œil ce qui réussit et ce qui échoue, où. | Fait |
| R9 | **Le chambellan, recruteur dans la métaphore.** Il ouvre chaque vague par un récit (`theme.narratives`), les chiffres techniques restant affichés dessous. Après la vague, il l'analyse (`src/ui/debrief.ts`, pur et testé) : lien manquant, goulot avec sa leçon, garde trop stricte, clics perdus derrière le CDN, trésor ou rouages dépassés, latence trop haute ; en cas de victoire, le goulot le plus proche, les pillards repoussés et les bâtiments à alléger. Chaque constat donne ce qu'il dit, l'explication d'entretien, la parade et la notion à réviser (`src/data/lessons.ts`). | Le cœur pédagogique de la spec manquait : savoir *pourquoi* une vague casse et quoi faire, avec le vocabulaire d'entretien. | Fait |
| R10 | **Tableau de bord du rejeu** : échecs cumulés face au SLA, latence du tick face à sa limite, coût face au budget, compteurs +1 / −1 / pillards (`src/render/hud.ts`, pur et testé). À la première saturation de chaque bâtiment : bandeau d'alerte, caméra recentrée et zoomée sur lui, ralenti de 3 secondes ; bouton « Recentrer ». | On comprenait ce qui s'était passé en lisant le debrief sous le plateau ; le rejeu doit le montrer pendant qu'il se produit. | Fait |
| R11 | **Le plateau est un grand hexagone** (rayon 9) ; les clients sont à sa pointe gauche, la case (0, 0). Plus de fond sous les tuiles. Reliefs et grands bois sur les deux rangées du bord, arbres et rochers épars à l'intérieur, rien autour des clients. Les étiquettes ne montrent plus les identifiants. | Un terrain de jeu lisible comme tel, avec une entrée du trafic claire. Une sauvegarde dont un bâtiment sort du nouveau plateau est replacée par `autoPlace`. | Fait |
| R12 | **Routes et rivière en tuiles KayKit.** Chaque case de chemin reçoit la tuile de route qui relie exactement les côtés empruntés (13 tuiles couvrent les 63 combinaisons, à la rotation près ; côtés relevés sur les modèles). Une rivière fixe traverse le plateau du haut en bas en tronçons droits : on ne bâtit pas dessus, et un chemin ne la franchit que tout droit, sur un tronçon droit, par un pont (tuile de gué et modèle de pont). Aucun effet sur la simulation. | Des chemins lisibles comme des routes, et un obstacle qui donne du relief au plateau sans toucher à l'équilibrage (les chemins restent décoratifs, I4). La traversée droite est la seule que les tuiles KayKit savent dessiner. | Fait |
| R3 | Additions au moteur pour la phase 2, en sortie seulement : `TickMetrics.links` (débit par lien et par type à chaque tick) et `NodeTick.shed` (trafic abusif écarté par nœud). | Le rejeu doit savoir ce qui roule sur chaque route et qui est repoussé à la porte ; la simulation elle-même ne change pas. | Fait |

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
| X5 | **Incidents annoncés** au briefing, déterministes : `instance-down` (des instances d'un type tombent, à zéro le composant ne sert plus rien) et `cold-cache` (taux de succès à 0 puis remontée linéaire). Vague 2 : le cache redémarre à froid (ticks 31 à 33). Vague 3 : une instance du serveur tombe après le pic (ticks 46 à 48). Rien en vagues 4 et 5. | Ils enseignent la redondance (SPOF) et le cache stampede sans tirage aléatoire. Calés pour ne faire perdre aucune réponse attendue : en vague 4 ou 5, toute panne fait perdre toutes les réponses, il faudrait recalibrer. Le debrief dit ce que la panne a coûté et ce qui l'aurait encaissée. | Fait |

## Calibrage actuel du raccourcisseur

| Vague | Budget | Plafond complexité | Stratégies non dominées (énumération) |
|---|---|---|---|
| 1 | 100 | 4 | serveur + base (réponse unique assumée) |
| 2 | 115 | 7 | cache (85) · réplica (110) |
| 3 | 170 | 9 | CDN + cache (145) · CDN + réplica (170) · LB + scaling + cache (155) · LB + scaling + autoscaling + cache (136 avec 2 instances fixes) |
| 4 | 165 | 9 | LB + scaling + rate limiting + cache (160) · CDN + LB + rate limiting + cache (160) ; paliers gagnants : 40 et 80 |
| 5 | 225 | 12 | LB + scaling + rate limiting + cache + file (225 avec 5 instances, 205 avec 4) (réponse unique assumée) |

Seuils de l'étoile d'économie : 70, 85, 145, 160, 205.

SLA constant : 1 % d'échecs, 60 ms de latence p95. Scraper : 2 adresses à 1 000 req/s,
en longue traîne. Critères de sortie : aucune architecture ne gagne les 5 vagues, et
3 vagues sur 5 ont au moins deux stratégies.

## Prochaines étapes

0. Phase 2 : glisser-déposer et annulation ; marche animée ; incidents en vagues 4 et 5
   (demande un recalibrage). Pas de géographie (P2).

1. Jouer et calibrer dans l'interface jusqu'aux critères de sortie, durée de partie
   comprise (B4).
2. Faire jouer 2 ou 3 personnes de la cible : publier sur GitHub Pages (dépôt distant
   et workflow de déploiement à créer).
3. Reproduire les fiches du calendrier dans le jeu (I2, P3), plus tard.
4. Corriger la spec : colonne MVP du CDN et de l'autoscaling, « or gagné » (E1).

## Positionnement

| # | Décision | Pourquoi | Statut |
|---|---|---|---|
| P1 | Le jeu est **pédagogique** : il fait comprendre le system design, il n'entraîne pas à l'entretien. Les textes parlent de systèmes, pas de recruteurs ; pas de question d'entretien après les vagues. Remplace le cadrage « relance d'entretien » de la spec et de R9. | Choix de François. | Fait |
| P2 | **Pas de géographie** (distance = latence, hameaux éloignés) : le plateau reste de la mise en scène. | Choix de François. | Fait |
| P3 | Les fiches du calendrier Advent of System Design seront **reproduites dans le jeu**, pas seulement citées ni liées. Chantier ultérieur. | Choix de François : le jeu doit se suffire à lui-même. | À faire |

