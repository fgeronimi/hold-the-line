# Revue technique et plan d'action

Rédigée le 11 novembre 2026, sur `main` à `4f78d67`. Analyse seule : aucun code modifié.

État constaté : `npm run typecheck` propre, `npm test` 219 tests verts sur 18 fichiers
(15 s), `npm run balance` sans KO sur les quatre scénarios (~70 s, dont 64 pour le
raccourcisseur et ses 17 376 architectures).

Les affirmations sur le comportement du moteur ont été vérifiées en lançant
`simulateWave` sur les archétypes du repo ; les chiffres cités sont ceux obtenus.

Les décisions de `docs/decisions.md` sont tenues pour acquises. Quand un point touche une
décision déjà prise, l'argument nouveau est donné ; sinon je ne la rouvre pas.

## Sommaire

1. [Ce qui est bien, à garder](#1-ce-qui-est-bien-à-garder)
2. [Ce qui ne va pas, par gravité](#2-ce-qui-ne-va-pas-par-gravité)
3. [Le modèle de simulation, vu comme un modèle](#3-le-modèle-de-simulation-vu-comme-un-modèle)
4. [Plan d'action priorisé](#4-plan-daction-priorisé)
5. [Cohérence avec la vraie vie : décisions](#5-cohérence-avec-la-vraie-vie--décisions)
6. [Système d'aide](#6-système-daide)
7. [Références : chiffres, incidents, pratique](#7-références--chiffres-incidents-pratique)
8. [Journal des trois rondes de questions](#8-journal-des-trois-rondes-de-questions)

---

## 1. Ce qui est bien, à garder

**Le moteur pur et déterministe.** `simulateWave(arch, wave, catalog, previous?)` n'a ni
DOM, ni aléa, ni état caché (`src/engine/simulate.ts:166`). C'est ce qui rend possibles
l'énumération en masse, le debrief qui rejoue la vague sans un bâtiment
(`src/ui/debrief.ts:334`) et le rejeu 3D qui relit des ticks. Ne jamais y laisser entrer un
`Math.random` sans graine explicite.

**L'énumération en masse comme garde-fou de design.** `npm run balance` a trouvé de vrais
trous (S17, S21) que ni les tests ni le jeu à la main n'auraient vus. La dominance (B2) est
la bonne définition de « stratégie ». C'est l'actif le plus précieux du repo après le
moteur.

**Les données séparées du comportement.** Un composant est un `Behavior` plus des chiffres
(`src/engine/types.ts:12-65`) ; le quatrième scénario n'a ajouté qu'un fichier de données
et trois effets. La promesse « une suite ne touche pas au moteur » tient à peu près, et
elle doit continuer de guider les ajouts.

**Le routage déduit** (`src/engine/routing.ts:19`). 77 lignes, testées, et elles suppriment
une classe entière d'erreurs de câblage sans intérêt pédagogique (I1). Le cache-aside
modélisé comme une consultation et non une traversée (I3) est juste.

**« Le rendu ne simule rien ».** Chaque besoin d'affichage a été satisfait en ajoutant un
champ aux ticks (`NodeTick.shed`, `waitingOn`, `starting`…), pas en recalculant. La règle
est tenue partout sauf en deux endroits, listés en 2.3.

**Les modules purs de l'interface.** `board.ts`, `debrief.ts`, `tutorial.ts`, `editor.ts`,
`calibration.ts`, `hex.ts`, `layout.ts`, `traffic.ts`, `hud.ts`, `charts.ts` sont testés
sans DOM. Le tutoriel déduit du brouillon plutôt que d'un compteur d'étapes (I7) est le bon
choix.

**`docs/decisions.md`.** Chaque règle étrange du moteur a son pourquoi et son numéro. C'est
ce qui a permis de faire cette revue en une passe. À continuer tel quel.

**Les tests de verrouillage par vague** : « gagnée avec la réponse attendue, perdue sans
elle, perdue sur-dimensionnée ». La forme est bonne. Leur défaut est ailleurs (2.2).

**L'honnêteté des libellés** : « p95 (approx.) », « unités de travail ». Le jeu ne prétend
pas mesurer ce qu'il ne mesure pas. La section 3 propose d'étendre cette honnêteté à deux
ou trois endroits où elle manque.

---

## 2. Ce qui ne va pas, par gravité

### 2.1 Bugs et incohérences vérifiés

**B1. Les instances d'autoscaling survivent à « tous les serveurs s'arrêtent ».**
`processService` calcule `base = instancesOf(node, catalog, down)` puis ajoute
`auto.active` sans lui appliquer la panne (`src/engine/simulate.ts:651-653`). Sur la
vague 1 du tournoi (`bad-deploy`, `count: 10`, `src/data/scenarios/tournament.ts:50`), une
architecture « 1 instance + autoscaling 3 » passe de 2 à 1 instance pendant la panne, pas à
0, et l'autoscaler en relance une aussitôt parce que `wanted` se calcule contre une base
tombée à zéro (`simulate.ts:729`). Relevé : `20:i1 21:i1 22:i2 23:i3`. La stratégie
« autoscaling » de la tempête de relances gagne donc en partie parce qu'elle ne subit pas
l'incident annoncé. Le briefing dit « un déploiement raté arrêtera tous les serveurs » :
un mauvais déploiement touche aussi les instances neuves. Gravité haute : c'est une
stratégie gagnante documentée (S19, calibrage du tournoi) qui repose sur un artefact.

**B2. Une écriture relancée ne réémet pas son événement.** Les relances réinjectent
lectures et écritures, jamais l'async : `share` vaut 0 pour lui (`simulate.ts:284-285`).
L'événement perdu avec la première tentative est compté en échec définitif
(`simulate.ts:430` le retire des échecs relançables). Mesuré sur la vague 1 du tournoi avec
la réponse attendue (backoff + 1 instance) : `delivery 2583,8 / 2733,8`, soit exactement
3 ticks × 50 billets jamais envoyés alors que les achats relancés ont réussi. Contredit C5
(« l'async suit le sort de sa requête »). Effet chiffré faible (0,2 % d'échecs), effet sur
le sens réel : l'achat passe, le billet n'arrive jamais, et rien ne le raconte.

**B3. Les échecs sont répartis entre les sources qui relancent au prorata de leur débit,
quelle que soit la source qui a échoué** (`simulate.ts:430-436`). `syncFailed` agrège tous
les échecs synchrones, y compris ceux d'une source qui ne relance pas. Inoffensif
aujourd'hui (toutes les sources synchrones du tournoi relancent), faux dès qu'un scénario
mêlera des partenaires sans relance et des clients avec. À corriger avant le prochain
scénario à relances, ou à verrouiller par une erreur de validation.

**B4. Avec un CDN, tous les paliers de rate limiting gagnent la vague 4 du
raccourcisseur**, y compris 10 req/s par client alors que les partenaires en envoient 30.
Le CDN sert 80 % de leurs lectures avant la porte : 300 req/s restantes pour 500 autorisées.
Relevé : paliers 1 à 5 tous gagnants derrière un CDN, seuls 3 et 4 sans lui. Ce n'est pas
un bug du moteur (un CDN devant un limiteur fait bien ça), c'est la leçon de la vague
(« trop bas, il coupe des clients légitimes », C1/C2) qui disparaît sur une des deux
stratégies gagnantes. Et `docs/decisions.md:115` affirme « paliers gagnants : 40 et 80 »,
ce qui n'est vrai que pour l'autre.

**B5. La latence d'un nœud en panne est un artefact.** `OUTAGE_UTILIZATION = 10`
(`simulate.ts:31`) plafonné à 0,95 donne 20 × la latence de base : le banquier fermé
« répond » en 628 ms (vague 4 du banquier, appel direct), un serveur arrêté en 206 ms. Ces
valeurs s'affichent dans la barre et les courbes. Elles ne veulent rien dire : une
dépendance morte répond soit tout de suite (connexion refusée), soit jamais (délai
d'attente). Voir 3.6.

**B6. `npm run balance` sort toujours en code 0**, KO ou pas (`scripts/balance.ts:49` se
contente d'afficher), et la CI ne le lance pas (`.github/workflows/deploy.yml:28-30`). Le
garde-fou principal de l'équilibrage n'est donc branché nulle part.

**B7. Dérive de la documentation.** `docs/spec.md:79-80` annonce trois scénarios à l'écran
de choix (il y en a quatre) ; `CLAUDE.md:14` parle de « trois scénarios » ;
`docs/decisions.md:48` (B3) donne 2 928 architectures (17 376 aujourd'hui) ;
`decisions.md:37` (C2) dit « scraper sur 5 adresses à 400 req/s ; seul le palier 40
gagne » alors que le code a 2 adresses à 1 000 (`url-shortener.ts:16`) et que la ligne 120
du même fichier le dit aussi ; `README.md:69` annonce ~30 s pour le balance. Le rapport
affiche aussi « Deux stratégies sur la majorité des vagues : non » pour le marché sans le
compter en KO : assumé (quatre vagues à réponse unique), mais le critère B1 n'est alors
plus vérifié par personne pour ce scénario.

### 2.2 Tests qui manquent ou qui verrouillent mal

**T1. Les mécanismes S14 à S21 ne sont testés qu'à travers le catalogue calibré.**
`tests/engine.test.ts` a son propre catalogue (bien), mais s'arrête à la file et à
l'autoscaling : aucun test sur les fils d'exécution, le disjoncteur, les relances,
l'effondrement, la partition, le quota, le pub/sub, l'idempotence, l'outbox. Ces mécanismes
ne sont couverts que par `tests/market.test.ts`, `resilience.test.ts`,
`tournament.test.ts`, qui importent `src/data/catalog.ts`. Conséquence : un recalibrage
casse des tests de mécanique, et un bug de mécanique compensé par le calibrage passe.
B1 et B2 en sont l'illustration : aucun test ne dit ce que l'autoscaling doit faire sous
`instance-down`, ni ce que devient l'événement d'une écriture relancée.

**T2. Aucun invariant de conservation.** Rien ne vérifie que, pour toute architecture
valide, `offert = servi + échoué + écarté + en file` par type de requête et par tick. Avec
dix raisons d'échec, des doublons, des copies de pub/sub, des relances déduites et un
`undelivered` calculé par différence (`simulate.ts:415-423`), c'est le test qui
attraperait le plus de régressions pour le moins d'effort. L'énumération fournit déjà
17 000 architectures sur lesquelles le faire tourner.

**T3. `main.ts`, `scene.ts` et `replay.ts` n'ont aucun test**, soit 2 000 lignes. Pour
`scene.ts` c'est normal (WebGL). Pour `main.ts` ça ne l'est pas : la sauvegarde, l'annulation,
le retour à une vague, l'enchaînement des phases sont de la logique pure enfermée dans un
module à effets de bord (2.4).

**T4. Pas de test de la sauvegarde.** `load<T>()` fait un `JSON.parse` casté sans
validation (`src/ui/storage.ts:8-15`). La clé versionnée protège d'un changement de forme
annoncé, pas d'un oubli de changer la clé. Un test « une sauvegarde de la version courante
se recharge, une forme inconnue est ignorée » coûte dix lignes.

**T5. Les incidents courts sont calés sous le seuil du p95 sans qu'un test le dise.**
Voir 3.1 : c'est une propriété du modèle dont dépend l'équilibrage, et elle n'est écrite
nulle part ailleurs que dans le commentaire de `percentile` (`simulate.ts:1135`).

### 2.3 Cohérence moteur, rendu, interface

**C1. La règle du taux d'échec est écrite deux fois.** `replayStats` refait le calcul du
verdict, relances et trafic écarté déduits (`src/render/hud.ts:15-26`), en miroir de
`simulate.ts:465-467`. Un test les compare en fin de vague
(`tests/tournament.test.ts:68`), mais c'est exactement ce que la règle « le rendu ne
simule rien » interdit. Le moteur devrait publier par tick les deux nombres déjà déduits
(compté, échoué-vu-du-client) et le rendu les sommer.

**C2. Même chose pour le p95.** `latencyBreachTick` (`hud.ts:54-62`) réimplémente la règle
du rang le plus proche de `percentile`. Le moteur devrait renvoyer le tick de rupture, ou
au moins exporter la fonction.

**C3. Le debrief connaît le catalogue par ses identifiants et le thème par ses mots.**
`debrief.ts:279` lit `n.upgrades['read-replica']`, `:302` et `:308` lisent `idempotence`
et `outbox` par leur id alors que le moteur les trouve par type d'effet. Les répliques
contiennent en dur « tours de scribes », « archives », « relais de poste », « Sire »
(`debrief.ts:237-318`), alors que `theme.narratives` et `src/data/lessons.ts` existent pour
ça. Un second thème, ou un renommage d'évolution, casse le debrief en silence.

**C4. `analyzeWave` est recalculée à chaque rendu du debrief**, et elle relance une
simulation par bâtiment retirable (`debrief.ts:329-338`), appelée depuis `views.ts:316` et
encore `views.ts:661` quand le tiroir de debug est ouvert. Chaque clic dans le debrief
(onglet, menu) refait N+1 simulations. Invisible aujourd'hui (une vague se simule en moins
d'une milliseconde), mais c'est un calcul dans une fonction de rendu : à mémoriser sur la
tentative au moment où elle est enregistrée (`main.ts:323`).

**C5. `validateArchitecture` et `linkFlows` sont rappelées en ordre dispersé** pour le même
brouillon dans le même rendu : `views.ts:217`, `:502`, `:507`, `tutorial.ts:72` et `:106`,
`board.ts:88` et `:112-114`, `charts.ts:81`. Aucun coût sensible, mais c'est le symptôme
qu'il manque un objet « brouillon analysé » calculé une fois par changement.

### 2.4 Structure et fichiers trop gros

**S1. `src/engine/simulate.ts` (1 192 lignes) : le problème n'est pas la taille, c'est la
fermeture.** `simulateWave` fait 330 lignes (`:166-493`) et définit une douzaine de
fermetures (`down`, `hitFactor`, `herdAt`, `latencyOf`, `isDown`, `breakerOf`,
`hitRateAt`, `incidentShare`…) qui lisent des variables mutées par la boucle (`active`,
`currentTick`). `hitRateAt` lit `currentTick` déclaré deux lignes plus bas
(`simulate.ts:219-221`). Les incidents sont résolus par des `reduce` éparpillés, et les
évolutions par une dizaine de recherches linéaires dans `catalog.upgrades` qui se ressemblent
(`:195`, `:209`, `:212`, `:253`, `:604`, `:707`, `:800`, `:820`, `:899`, `:984`).
Deux objets `ProcessEnv` et `RouteEnv` de dix champs servent à repasser ces fermetures aux
fonctions de traitement.

Découpe qui suit les coutures existantes, sans changer un résultat :

| Module | Contenu | Lignes actuelles |
|---|---|---|
| `flow.ts` | `Stream`, `Flow`, `addStream`, `scaleFlow`, `work`, `filterFlow` | 39-91, 866-870 |
| `incidents.ts` | état des incidents du tick : `down`, `hitFactor`, `herd`, `latencyOf`, `partitioned`, `share` | 182-224 |
| `upgrades.ts` | `levelOf(node, effect)`, `effectOf(node, type)` résolus une fois par nœud | les dix recherches |
| `nodes/*.ts` | un fichier par comportement : service + autoscaling, base, file, bordure, équilibreur | 602-935 |
| `route.ts` | `route`, `messagingRoles`, `linkTraffic` | 937-1088 |
| `latency.ts` | `computePathLatencies`, `percentile`, règle S17/S21 | 389-409, 1090-1140 |
| `retries.ts` | planification des relances et effondrement | 247-256, 425-444, 565-572 |
| `simulate.ts` | la boucle et le verdict | ~200 lignes |

**S2. `src/render/scene.ts` (1 196 lignes) : une classe qui fait cinq métiers.** Caméra et
entrées (`:397-512`), terrain et décor (`:514-633`, `:929-952`), construction des bâtiments
et de leurs annexes (`:660-927`), état par tick des bâtiments (`:967-1109`), voyageurs
(`:1111-1190`). Les quatre derniers ne partagent que `buildings`, `roads` et `effects`.
Découpe : `camera-rig.ts` (contrôles, cadrage, pointeur vers case), `scenery.ts`,
`building-factory.ts`, `tick-view.ts` (ce qui dépend du tick), `travellers.ts`. `CityScene`
reste la façade que `main.ts` et `replay.ts` connaissent.

**S3. `src/ui/main.ts` (556 lignes) : tout est à effet de bord dès l'import.** L'état, le
magasin de sauvegardes, l'historique d'annulation et les écouteurs vivent au niveau du
module (`:58`, `:130-145`, `:275-291`, `:530-556`). Rien n'est testable. Trois extractions
pures, sans toucher au comportement : `session.ts` (charger, choisir, sauvegarder une
partie : `:29-111`, la moitié de `update`), `history.ts` (annuler, rétablir : `:142-150`,
`:241-248`), `actions.ts` (le dictionnaire `:362-518` devient
`(state, el) => Partial<ViewState>`, les effets restant dans `main.ts`). `update()` mêle
aujourd'hui placement automatique, historique, sauvegarde et rendu (`:152-170`).

**S4. `src/ui/views.ts` (739 lignes) : un fichier par calque suffirait.** Le problème
réel est moins la taille que les douze lignes de plus de 200 caractères, des gabarits HTML
à ternaires imbriqués illisibles en revue (`views.ts:314-318` par exemple). Découpe par
région : `hud.ts`, `toolbar.ts`, `card.ts` (fiche, pastilles, menu de construction),
`dialog.ts` (briefing, debrief, choix), `debug.ts` (tableau, calibrage, tentatives).

**S5. `src/render/showcase.ts` (1 078 lignes)** est hors build et sert de banc d'essai :
laissé tel quel, sauf à en profiter quand `scene.ts` sera découpé (les îlots pourront
appeler `tick-view.ts` au lieu de dupliquer des états).

**S6. Duplication mineure.** `fmt` et `pct` existent en trois variantes
(`simulate.ts:1191-1192`, `views.ts:87-88`, `charts.ts:38-39`, `debrief.ts:50`) qui
n'arrondissent pas pareil ; `esc` (`views.ts:84`) et `escapeHtml` (`render/html.ts`) font
la même chose. Le moteur fabrique des phrases en français (`lossReasonsFor`,
`simulate.ts:1142-1162`) : il devrait renvoyer des raisons typées et laisser l'interface
les écrire.

### 2.5 Performance du rendu

Rien de bloquant mesuré ; trois points à connaître, du plus au moins utile.

**P1. La boucle d'animation rend en continu, même à l'arrêt.** `frame` se replanifie sans
condition et rend scène et étiquettes à chaque image (`scene.ts:397-405`), ombres douces
activées (`:219`). En construction, plateau immobile, le GPU travaille à 60 images par
seconde pour rien : c'est la batterie d'un portable sur un jeu qu'on laisse ouvert en
réfléchissant. Un drapeau « à redessiner » levé par les contrôles, le survol et les
changements d'état suffit hors rejeu.

**P2. Le rejeu alloue et réécrit du HTML à chaque image.** Par image : filtrage de tous les
trajets et de tous les résultats (`replay.ts:191-192`), `replayStats` qui reparcourt tous
les ticks écoulés et refiltre trois fois les résultats (`hud.ts:15-34`), puis
`hud.innerHTML` réécrit (`replay.ts:165`). Les trajets sont triés par départ : deux index
qui avancent remplacent les filtres, et le tableau de bord ne change qu'au changement de
tick ou de compteur.

**P3. Chaque modification du brouillon reconstruit tout le plateau dynamique** : bâtiments,
routes, panneaux, arbres (`scene.ts:266-277`), y compris pour une pastille d'évolution
cliquée. Acceptable à cette échelle ; à reprendre seulement si une saccade se voit en
glissant un bâtiment.

**P4. L'interface réécrit ses cinq calques à chaque `update`** (`main.ts:172-181`), donc à
chaque clic, et sauvegarde tout le magasin dans `localStorage` au même moment
(`main.ts:161-168`). Effet de bord connu de cette approche : un champ de calibrage perd le
focus dès qu'il déclenche un rendu. Tolérable tant que c'est le tiroir de debug.

---

## 3. Le modèle de simulation, vu comme un modèle

Classement par risque d'enseigner quelque chose de faux, pas par écart à la réalité : un
modèle faux mais inoffensif vaut mieux qu'un modèle presque juste qui installe un mauvais
réflexe.

### Enseigne quelque chose de faux

**3.1 Le p95 par tick rend invisible toute dégradation de trois secondes ou moins.**
Sur 60 ticks, le rang le plus proche écarte les 3 pires (`simulate.ts:1136-1140`). Or les
incidents courts durent 2 ou 3 ticks : cache froid 30→33 (`url-shortener.ts:50`), instance
tombée 45→48 (`:72`), worker 30→32 (`:106`), ruée 30→32 (`resilience.ts:70`), déploiement
raté 20→23 (`tournament.ts:50`) et 12→15 (`:99`). Mesuré sur la vague 1 du tournoi avec la
réponse attendue : trois ticks à 206 ms, p95 final 43,9 ms. Le joueur apprend qu'une panne
totale de trois secondes ne touche pas la latence. Un vrai p95 par requête la verrait dès
que plus de 5 % des requêtes de la vague y passent, ce qui est à la limite ici (3 ticks
sur 60 à plein trafic, relances en plus : de l'ordre de 5 %, non mesuré). Ce n'est pas un détail de définition : la durée des
incidents semble calée sur cette tolérance, et c'est elle qui fait tenir plusieurs réponses
attendues. Argument nouveau par rapport à M4 : le problème n'est pas que la mesure soit
approximative, c'est qu'elle a un angle mort exactement de la taille des incidents.

**3.2 Un consommateur de file qui déborde perd les messages.** `drainCapacity` ne regarde
que la capacité du consommateur immédiat (`simulate.ts:920-935`) : 7,5 millions de
messages par seconde pour un worker, qui vide donc tout l'arriéré en un tick sur la base,
laquelle fait échouer l'excédent (`serveWithin`, `:575-581`). Mesuré sur la vague 5 du
raccourcisseur en allongeant la panne du worker : 2 ticks, 260 clics perdus ; 4 ticks,
6 455 et vague perdue ; 10 ticks, 31 671. C'est la question ouverte de la spec, mais elle
est mal nommée : ce n'est pas un « débit de rattrapage » qui manque, c'est l'acquittement.
Un worker qui n'arrive pas à écrire ne retire pas le message de la file ; il le reprend
plus tard. La file impose d'elle-même le rythme de l'aval. Tel quel, le jeu enseigne
qu'une file protège d'une panne courte du consommateur mais perd les messages d'une panne
longue, soit l'inverse de la raison pour laquelle on en met une. C'est l'écart le plus
grave, parce qu'il touche la leçon centrale de deux scénarios, et qu'il a déjà contraint le
design (incident limité à 2 ticks, X5).

**3.3 L'autoscaling comme parade à un mauvais déploiement** (bug B1). Dans la réalité,
l'autoscaling lance des instances de la même version cassée. Sa vraie vertu pendant une
tempête de relances est d'ajouter de la capacité après la panne pour absorber le surplus,
ce que le modèle sait déjà faire : il suffit que la panne touche aussi ses instances.

**3.4 L'autoscaling en deux secondes, la réduction instantanée et gratuite.**
`startupTicks: 2` (`src/data/catalog.ts:213`), réduction immédiate (`simulate.ts:734-737`).
Un tick vaut une seconde partout ailleurs (req/s, « trois secondes », « une demi-minute »).
En vrai, une instance met de l'ordre de la minute à servir, un conteneur quelques dizaines
de secondes, et la réduction attend un délai de stabilisation (300 s par défaut sur EC2
Auto Scaling). Le compromis qualitatif est juste (échecs pendant la montée) ; l'ordre de
grandeur enseigné est faux d'un facteur 30 à 100. Décision prise (5.1) : un tick vaut une minute.

**3.5 La relance agrégée fait porter la tempête au seul client.** Trois relances
immédiates sans attente, toutes au tick suivant (`simulate.ts:425-444`), et une seule
parade côté joueur qui modifie… les clients (`client-backoff`, `catalog.ts:270-281`). Le
mécanisme et son état métastable sont bien rendus (mesuré : 4 950 relances par seconde
entretenues jusqu'à la retombée du trafic, charge à 2,3). Ce qui est faux, c'est la leçon
de conception : en production on ne contrôle pas les clients. Les parades qu'un opérateur
possède sont le délestage à l'entrée (rejeter vite au-delà de la capacité), la limite de
débit, le budget de relances, le disjoncteur. Le jeu a déjà un rate limiting et un
effondrement qui dit précisément « il traite des requêtes déjà abandonnées »
(`simulate.ts:565-572`) : la parade naturelle, le délestage, manque. Le backoff reste
juste comme leçon pour qui écrit un client.

**3.6 Une dépendance en panne ne bloque rien.** `syncWait` ignore une dépendance tombée
(`simulate.ts:313`) : sans disjoncteur, l'appel au banquier fermé échoue tout de suite,
les fils restent libres (mesuré : `thr 0,1` pendant la panne, aucun
`threads-exhausted`). Avec ou sans disjoncteur, même nombre d'échecs (750) ; le
disjoncteur ne change que la latence artefact de B5. Or le cas réel le plus destructeur
est la dépendance qui ne répond plus du tout : chaque appel attend son délai d'attente, et
c'est là que les fils s'épuisent. Le jeu enseigne « lent, c'est grave ; en panne, c'est
bénin ». Il faudrait qu'une panne se comporte comme une lenteur au délai d'attente du
client (ce que `slow-dependency` fait déjà), sauf disjoncteur.

### Approximations à signaler au joueur

**3.7 Le disjoncteur s'ouvre par omniscience.** Il lit la latence de l'incident
(`simulate.ts:306`) et coupe au tick même, sans seuil d'erreurs, sans fenêtre, sans état
semi-ouvert ni sonde au retour. Acceptable pour le jeu ; à dire dans la fiche (« en vrai,
il lui faut quelques secondes d'échecs pour s'ouvrir et il teste la reprise »).

**3.8 La cascade est très douce.** Fils saturés à 1,3 : le serveur sert encore 77 % du
trafic (`serveWithin` proportionnel). Mesuré sur la vague 2 du banquier, appel direct :
1,47 % d'échecs sur la vague. Un vrai épuisement de fils est plus proche du tout ou rien
pour les requêtes arrivées pendant l'attente. La vague est tout de même perdue (latence
4 219 ms), donc la leçon passe ; mais avec quatre instances il n'y a plus aucun échec,
seulement la latence, et « ajouter des serveurs » ressemble à une demi-solution au lieu
d'une fuite en avant.

**3.9 La latence en `base / (1 − charge)`** (`simulate.ts:89-91`) est la formule d'une
file à un seul serveur. À 70 % de charge elle multiplie par 3,3, à 90 % par 10. Pour un
service à plusieurs fils ou plusieurs instances, la courbe réelle reste plate bien plus
longtemps puis décroche plus sec. Effet de bord pédagogique plutôt bon (on apprend à
garder de la marge), mais il pénalise le scaling horizontal, qui devrait aplatir la courbe
et pas seulement baisser la charge.

**3.10 Une requête en échec garde une latence moyenne.** La latence d'un tick moyenne sur
ce qui est offert, pas sur ce qui est servi, et un nœud saturé plafonne à 20 × sa base
(`simulate.ts:28`). Ni délai d'attente, ni exclusion des erreurs : les deux conventions
réelles (latence des succès seulement, ou échec compté à la valeur du délai) donnent des
chiffres différents. Sans conséquence tant que le taux d'échec fait perdre avant.

**3.11 Populations mesurées à part (S17, S21).** Ce sont deux rustines sur le même trou :
une moyenne par tick ne voit pas une minorité lente. Elles fonctionnent, mais la règle est
devenue difficile à énoncer (« la moyenne, sauf l'événement direct, sauf les lectures à
jour si elles dépassent 5 % ») et le seuil de 5 % crée un effet de falaise
(`simulate.ts:404-409`). Chaque nouveau scénario à population minoritaire demandera sa
rustine. La distribution par classe de requête (3.1, action M4) les remplace toutes.

**3.12 La file ne mesure pas le retard.** Un message qui attend 25 secondes derrière un
prestataire fermé compte comme livré à l'heure. L'âge du plus vieux message, qui est la
métrique qu'on surveille vraiment sur une file, n'existe pas ; la file n'a donc que deux
états, « tient » ou « déborde ». Le compromis réel d'un paiement différé (le client ne
sait pas s'il a payé) n'apparaît nulle part.

**3.13 Pas de contre-pression** (M3, assumé). Je ne le rouvre pas : la cascade par les
fils couvre le cas qui compte. À noter seulement que 3.2 est une contre-pression locale,
celle de la file, et qu'elle ne contredit pas M3.

**3.14 Le cache a un taux de succès constant de 95 %** quel que soit le trafic, et le
cache froid remonte linéairement en 3 ticks. Pas de péremption (C3, assumé pour des
données immuables). Devient faux dès le marché et le tournoi, où des commandes et des
places changent : le jeu contourne par `consistent` (S21), ce qui est propre.

**3.15 Lot de 100 messages qui divise par 100 le travail de la base**
(`catalog.ts:164`, `simulate.ts:81-87`). Une insertion groupée coûte moins qu'insertions
séparées, mais pas cent fois moins. Sans conséquence sur la leçon ; à garder en tête si la
contre-pression de 3.2 est ajoutée, car c'est ce facteur qui fixera le débit de vidage.

**3.16 Coûts sans unité ni durée.** Une facture par vague de 60 secondes, un CDN à 60
contre un serveur à 20 et une base à 50 (`catalog.ts:27`, `:55`, `:143`). Le CDN est en
vrai le composant le moins cher par requête servie. Le prix actuel est un levier
d'équilibrage (X1), pas une information.

---

## 4. Plan d'action priorisé

Consolidé le 11 novembre 2026 après trois rondes de questions (section 8) : les 24
recommandations ont été retenues, et François a ajouté un système d'aide (section 6).

Effort : S = moins d'une demi-journée, M = un à deux jours, L = plus. Risque = risque de
casser l'équilibrage ou le jeu.

### Ordre d'ensemble

1. **Étape 0, filets** : rien d'autre ne commence avant.
2. **Étape 1, ce que le joueur voit tout de suite** : le système d'aide et les textes du
   temps compressé. Aucun effet sur l'équilibrage. À finir avant de faire jouer les 2 ou 3
   personnes de la cible (première des « prochaines étapes » de `decisions.md`).
3. **Étape 2, refactorisations** à rapport d'équilibrage identique.
4. **Étape 3, corrections du modèle**, en quatre passes de recalibrage, une par scénario
   puis une pour tous.
5. **Étape 4, debrief et fiches** : coût métier, observabilité, lignes « en vrai ».

### Étape 0 — filets

| # | Action | Effort | Risque | Débloque |
|---|---|---|---|---|
| A1 | Test d'invariant de conservation sur l'espace réduit de `tests/balance.test.ts` : par tick et par type, offert = servi + échoué + écarté + variation d'arriéré | S | nul | Toute l'étape 3 ; trouvera peut-être d'autres B2 |
| A2 | Tests de mécanique S14 à S21 dans `tests/engine.test.ts`, sur son catalogue propre : fils, disjoncteur, relances, effondrement, quota, partition, pub/sub, doublons, outbox | M | nul | Recalibrer sans casser la mécanique, et l'inverse |
| A3 | `scripts/balance.ts` sort en code 1 s'il y a un KO ; tâche CI séparée, non bloquante au début (70 s) | S | nul | Le garde-fou devient réel |
| A4 | Instantané versionné des stratégies non dominées par vague | S | nul | Chaque refactorisation se prouve « rapport identique » |
| A5 | Corriger la dérive des docs (B7) | S | nul | — |
| A6 | **Les réponses attendues de chaque vague passent en données** (`Wave.answers` : des choix dans l'espace d'équilibrage du scénario). Les quatre tests de verrouillage les lisent au lieu de les réécrire | S | nul | Le système d'aide (H1) ; une seule source pour les tests, l'aide et la doc |

**État au 11 novembre 2026 : étape 0 faite** (branche `filets-equilibrage`). 299 tests
verts et 2 échecs attendus, typecheck propre, `npm run balance:check` identique à
l'instantané. Ce qu'elle a trouvé en plus de la revue, figé dans les tests et ajouté aux
passes de l'étape 3 :

| # | Écart | Où | Figé par | Passe |
|---|---|---|---|---|
| B8 | Le rate limiting fait disparaître l'async des requêtes qu'il rejette : ni servi, ni échoué, alors que le CDN compte en échec l'async qu'il perd | `simulate.ts:620-648` | `tests/conservation.test.ts`, E1 (`it.fails`) | A |
| B9 | Le taux d'échec peut dépasser 100 % : les « non livrés » se comptent par abonné, le dénominateur en requêtes (119 % sur le marché sans livraison) | `simulate.ts:415-423`, `:465-467` | `conservation.test.ts`, E2 (`it.fails`) ; `engine-mechanics.test.ts` | D |
| B10 | Un doublon traité deux fois est relancé comme un échec synchrone quand les clients relancent ; `undelivered` sans doute aussi | `simulate.ts:1033`, `:430`, `:421` | `engine-mechanics.test.ts` | B, avec M3 |
| B11 | Le CDN sert les lectures d'une source `consistent`, que le cache écarte : contredit S21 | `simulate.ts:793-795` | `engine-mechanics.test.ts` | B |
| B12 | L'effondrement capacité / charge s'applique à tout nœud saturé dès qu'une seule source relance, même s'il ne la voit jamais | `simulate.ts:334` | non figé | B, avec M3 |

Écarts de calibrage relevés en passant les réponses en données, sans conséquence sur les
tests : l'idempotence est superflue en vague 4 du marché (205 et 230 gagnent sans elle,
`decisions.md` annonce 235 et 260) ; en vague 4 du tournoi, 3 instances + backoff gagnent
à 210 alors que la doc et le test verrouillent 4 instances à 230. À reprendre dans les
passes B et D, qui recalibrent ces vagues.

**Étape 1, système d'aide : fait** (H1, H2, H3), non commité. 363 tests verts et 4 échecs
attendus, typecheck et build propres, instantané d'équilibrage identique. Reste à écrire
I14 dans `decisions.md` et `spec.md`, à vérifier l'aide à l'œil dans le navigateur, et les
textes du temps compressé (D3a).

Le test « suivre les indices mène à la victoire » a trouvé un défaut bloquant du jeu :

| # | Écart | Preuve | Figé par | Correction |
|---|---|---|---|---|
| B13 | **La vague 4 du tournoi est ingagnable après une vague 3 gagnée.** La vague 3 exige 2 réplicas ; en vague 4, les garder ou en retirer un (40 de migration) mène au mieux à 245 pour un budget de 235. Aucun retour en arrière n'y change rien : toute vague 3 gagnante a 2 réplicas | Énumération des 2 100 architectures de l'espace, jouées depuis chacune des deux réponses de la vague 3 : 0 gagnante ; 67 tiennent le SLA et la complexité, la moins chère à 245 | `tests/hints.test.ts`, `DATA_DEFECTS` (2 `it.fails`) | Recalibrer la vague 4 (`src/data/scenarios/tournament.ts`) : budget à 250 et seuil d'économie à 245, à vérifier par l'énumération. À faire avant tout test de jeu, sans attendre la passe B |

L'énumération ne voyait pas ce défaut parce qu'elle joue chaque vague sans architecture
précédente. **Corrigé** : `npm run balance` contrôle maintenant l'enchaînement (décision
B7). Une vague qu'aucune réponse de la précédente ne permet de gagner est un blocage, et
un KO ; un départ sans gagnante alors qu'un autre passe est une impasse, listée sans KO,
dont on sort par le retour en arrière (E6). La vague 4 du tournoi passe à 250 de budget et
245 de seuil d'économie ; aucune architecture sans la parade attendue ne s'est mise à
gagner.

Impasses restantes, à reprendre dans la passe de leur scénario : raccourcisseur, vague 4
depuis « CDN + réplica » et vague 5 depuis la réponse CDN (celle-ci est assumée, X1) ;
marché, vague 5 depuis les variantes à réplica de la vague 4 ; tournoi, vague 2 depuis
« backoff + autoscaling » (151,33 pour 150).

### Étape 1 — aide et temps compressé

| # | Action | Effort | Risque | Débloque |
|---|---|---|---|---|
| H1 | `src/ui/hints.ts`, pur et testé : le prochain élément manquant, déduit du brouillon et des réponses attendues (section 6) | M | faible | H2 |
| H2 | Bouton « Un indice » dans la fenêtre « que faire » et dans le debrief d'une vague perdue, un indice par essai perdu ; l'élément désigné clignote, comme au tutoriel | S | faible | Personne ne reste bloqué en test de jeu |
| H3 | Indices obtenus gardés dans la partie (un par essai perdu, remis à zéro à chaque vague), en champ optionnel pour ne pas invalider les sauvegardes en cours ; décision I14 dans `decisions.md` (amende I9) | S | faible : la sauvegarde | — |
| D3a | Textes : « un tick vaut une minute » au premier briefing ; durées des briefings et des incidents réexprimées en minutes ; les clients du tournoi sont « votre application » | S | nul | Des durées crédibles sans recalibrer |

### Étape 2 — refactorisations sans changement de comportement

**État au 11 novembre 2026 : R2, R1 et R3 faits.** `simulate.ts` passe de 1 192 à 265
lignes, en vingt modules ; instantané d'équilibrage identique, et empreinte SHA-256 de
tous les résultats de simulation identique au bit près avant et après. Écart assumé sur
R2 : le moteur publie des cumuls (`countedSoFar`, `clientFailedSoFar`) et non des nombres
par tick, parce qu'une relance réussie donnerait un échec négatif sur son tick.
D3a (temps compressé) et I14 sont faits aussi.

**R5, R6, R4, R7 et R9 faits.** `main.ts` passe de 563 à 296 lignes, `views.ts` devient
un point d'entrée de 12 lignes sur cinq calques ; le HTML produit est identique octet pour
octet sur 5 990 sorties comparées avant et après. 417 tests verts. Seul changement de
comportement : une sauvegarde abîmée est ignorée au lieu de faire planter plus tard. R8
(découpe de `scene.ts`) reste à faire seulement s'il faut retoucher la scène.

À reprendre plus tard, relevé en passant : `tutorial.ts` et `views/dialog.ts` gardent des
mots de la métaphore en dur ; ⌘Z hors construction consomme un pas d'annulation sans
l'appliquer (comportement d'origine, maintenant testé).

Toutes doivent laisser l'instantané A4 identique.

| # | Action | Effort | Risque | Débloque |
|---|---|---|---|---|
| R2 | Le moteur publie par tick `counted` et `clientFailed`, et dans le résultat le tick de rupture de la latence ; `hud.ts` ne recalcule plus (C1, C2) | S | faible | Une seule définition du SLA, indispensable avant M4 |
| R1 | Découper `simulate.ts` selon le tableau de S1, en commençant par `flow.ts`, `upgrades.ts`, `incidents.ts` | M | faible avec A4 | Une étape 3 lisible |
| R5 | Mémoriser l'analyse du debrief sur la tentative (C4) ; un « brouillon analysé » calculé une fois par changement (C5) | S | faible | H1 s'y branche |
| R6 | Sortir du debrief les ids d'évolutions et les mots du thème (C3) | S | nul | D1 ; un second thème |
| R3 | Raisons de défaite typées côté moteur, phrases côté interface (S6) | S | faible | — |
| R4 | Extraire `session.ts`, `history.ts`, `actions.ts` de `main.ts`, avec leurs tests (S3, T3, T4) | M | moyen : la sauvegarde | Tester la progression de bout en bout |
| R7 | Découper `views.ts` par calque (S4) | S | nul | Lisibilité des revues |
| R9 | Rendu à la demande hors rejeu (P1), index glissants et tableau de bord par tick dans le rejeu (P2) | S | faible | Batterie, fluidité |
| R8 | Découper `scene.ts` (S2) | M | moyen : pas de tests | À ne faire que s'il faut retoucher la scène |

### Étape 3 — corrections du modèle, par passes de recalibrage

Chaque passe : appliquer, relancer `npm run balance`, ajuster budgets et seuils, mettre à
jour `Wave.answers`, consigner les décisions. Regrouper par scénario évite de recalibrer
trois fois le même.

**Passe A — raccourcisseur (et effets sur les autres files)**

| # | Action | Effort | Risque |
|---|---|---|---|
| M1 | **La file impose le rythme de l'aval** (3.2) : ce que le consommateur ou sa base ne peut pas servir retourne dans la file au lieu d'échouer | M | fort : raccourcisseur 5, banquier 4, tournoi 2 et 4 |
| SC2 | Panne du worker de la vague 5 allongée de 2 à une dizaine de ticks : l'arriéré monte puis se vide au rythme de la base | S | avec M1 |
| SC1 | Vague 4 : les partenaires appellent une API, non cachable par le CDN ; le bon palier redevient nécessaire sur les deux stratégies (B4) | S | moyen : vagues 4 et 5 |
| M9a | Prix du CDN revu à la baisse **si** l'énumération garde deux stratégies en vague 3 ; sinon ligne « en vrai » | S | moyen |

**État au 11 novembre 2026 : passe A faite** (branche `passe-raccourcisseur`), décisions
M8, X6, C6, X7, X8, X9. La file rend à son arriéré ce que l'aval ne peut pas servir ; la
panne du worker dure dix minutes sans perte ; l'async rejeté par le rate limiting est
compté ; les partenaires ne passent plus par le cache du CDN, qui écarte aussi les
lectures `consistent` (B11) ; le bâtiment Worker remplace le serveur derrière une file
(ticket #1, parties en cours converties) ; le CDN coûte 40. Seul le raccourcisseur a
bougé : vague 2 avec une troisième réponse (CDN, 110), vague 3 à 125 de seuil, vague 4 à
180 de budget et 10 de complexité avec trois stratégies. 430 tests verts.

Choix laissés tels quels, faute d'argument pour payer leur prix : l'impasse « vague 4
depuis CDN + réplica » reste (en sortir demandait 220 de budget, où le scaling seul gagne
tout) ; derrière un CDN, le palier 160 gagne encore la vague 4 (trop bas coupe partout,
trop haut ne perd que sans CDN). À ajouter au rendu (R10, nouveau) : les messages rendus
à leur file (`deferred`) s'affichent comme servis sur le lien file → worker → base.

**Passe B — tournoi**

| # | Action | Effort | Risque |
|---|---|---|---|
| M2 | **La panne touche aussi les instances d'autoscaling** (B1) | S | moyen : vagues 1 et 4 |
| M9b | Surcoût unitaire de l'instance à la demande | S | avec M2 |
| M3 | **L'événement suit la relance de son écriture** (B2) ; échecs relancés par source (B3) | S | faible |
| M7 | **Délestage**, évolution du load balancer : au-delà de la capacité de l'aval, rejeter vite, ce qui annule l'effondrement. Réponses visées en vague 1 : backoff ou délestage ; l'autoscaling reste s'il gagne honnêtement | M | moyen |
| SC4 | « Rétention » renommée « Capacité de la file » | S | nul |
| SC3 | Vague 3 : la source `consistent` devient la vérification de disponibilité au moment d'acheter ; mécanique inchangée | S | nul |

**État au 12 novembre 2026 : passe B faite** (branche `passe-tournoi`), décisions M9,
M10, M11, X10, S22, S23. Une panne éteint aussi les instances à la demande, qui coûtent 25 %
de plus que les fixes ; chaque source ne relance que ses échecs, et une requête relancée
réémet son événement ; le délestage à la porte arrête la tempête (troisième réponse de la
vague 1, 150) ; « Capacité de la file » remplace « Rétention » ; la vague 3 parle de la
vérification avant achat. Recalibrage : raccourcisseur vague 4 (l'autoscaling n'y est plus
une réponse), tournoi vague 2 à 155 (deux stratégies) et vague 4 à 255. Plus aucune impasse
dans le tournoi. B2, B3, B10, B11, B12 corrigés.

**Passe C — banquier**

| # | Action | Effort | Risque |
|---|---|---|---|
| M5 | **Une dépendance en panne retient les fils jusqu'au délai du client**, sauf délai d'attente ou disjoncteur (3.6) ; la latence artefact de B5 disparaît | S | moyen : vagues 4 et 5 |
| M8 | **Délai d'attente**, évolution du serveur (5, +1), tout-ou-rien. Gradation visée : délai seul, la cascade s'arrête mais la latence des commandes casse ; + disjoncteur, la latence tient et les paiements coupés échouent ; file, tout tient. Vague 2 : délai + disjoncteur, ou file. Vague 4 : file seule | M | moyen : vagues 2 à 5 |
| M6 | **Retard de la file** : âge du plus vieux message par tick, affiché partout (plateau, courbes) | M | faible |
| D2 | **Objectif de fraîcheur** sur banquier 4 et tournoi 2 | S | moyen : ces deux vagues |

**État au 12 novembre 2026 : passe C faite** (branche `passe-banquier`), décisions M12
et M13. Une dépendance muette retient les fils jusqu'au délai du client ; le délai d'attente
(nouvelle évolution) borne l'attente ; la latence d'un nœud sans instance n'est plus
l'artefact de 20 × sa base (B5) ; l'âge du plus vieux message de chaque file est mesuré,
affiché et raconté. L'objectif de fraîcheur (D2) est écarté : sans parade dans le jeu, il
punirait sans rien apprendre (M13). Aucune stratégie gagnante n'a bougé.

**Passe D — tous les scénarios**

| # | Action | Effort | Risque |
|---|---|---|---|
| M4 | **Latence par classe de requête** : p95 sur une distribution pondérée (chemin × débit × tick). Remplace S17 et S21 par une règle unique ; ferme l'angle mort de 3.1 | L | fort : tout se recalibre |
| SC7 | Incidents courts allongés à cinq ticks au moins ; la parade attendue doit tenir la latence pendant l'incident | M | avec M4 |
| SC6 | Prestataire de paiement à 300 ms, avec un objectif propre aux commandes (500 ms) à côté des 60 ms des lectures | S | avec M4 |
| SC8 | Revoir le SLA de 1 % d'échecs à la lumière du nouveau calibrage ; par défaut il reste | S | — |

### Étape 4 — debrief et fiches

| # | Action | Effort | Risque |
|---|---|---|---|
| D1 | Debrief : coût métier de chaque parade ; ligne « ce qui vous aurait prévenu » (métrique, seuil d'alerte) par incident ; calcul de dimensionnement posé avec les chiffres de la vague | M | nul |
| D3b | Lignes « en vrai » sourcées dans chaque fiche (section 7), produits réels cités là seulement ; budget de relances dans celle du backoff ; doublons permanents dans celle de l'idempotence, incident renommé « pic de relivraisons » ; vrai coût de l'outbox ; limite par classe de client et 302 derrière un CDN au debrief du raccourcisseur | M | nul |

### Bâtiments ajoutés

Retenus par François le 11 novembre 2026, pour rapprocher le jeu de la pratique. Un ticket
GitHub par bâtiment.

| Ticket | Bâtiment | Leçon | Quand |
|---|---|---|---|
| [#1](https://github.com/fgeronimi/hold-the-line/issues/1) | **Worker**, à part du serveur d'application | Un worker se dimensionne sur l'arriéré, pas sur le trafic entrant | Avec la passe A : il rend lisible la correction de la file (M1) |
| [#3](https://github.com/fgeronimi/hold-the-line/issues/3) | **File des lettres mortes** | Un message empoisonné bloque une file ; on le met de côté après quelques essais | Après les quatre passes ; dépend de M1 et M6 |
| [#2](https://github.com/fgeronimi/hold-the-line/issues/2) | **Passerelle d'API** | Des limites de débit par classe de client | Après les quatre passes ; à articuler avec SC1 |

Écartés : le stockage objet (il lui faut un scénario), une tour de supervision (du décor
sans mécanique), le sharding (trop gros pour le public visé). La bascule de la base,
proposée comme évolution, n'a pas été retenue pour l'instant.

---

## 5. Cohérence avec la vraie vie : décisions

**5.1 Public et parti pris.** Le jeu s'adresse d'abord à des développeurs qui n'ont jamais
opéré de système. Mécanismes justes et ordres de grandeur honnêtes passent avant
l'exhaustivité ; une parade de trop pour un incident est un défaut.

**5.2 Temps.** Un tick vaut une minute, annoncé au premier briefing. Les débits restent
par seconde. Une vague dure une heure, une instance démarre en deux minutes, le banquier
ferme 25 minutes. Aucun recalibrage : seuls les textes changent (D3a).

**5.3 Chiffres.** Des ordres de grandeur cohérents entre eux, pas des valeurs réelles à
l'unité. Chaque fiche a une ligne « en vrai » qui donne le chiffre réel et sa source
(tableau 7.1). Les produits réels (SQS, Stripe, SES…) n'apparaissent que là, jamais dans la
métaphore ni dans les noms de composants.

**5.4 Quand le jeu contredit la pratique.** On corrige quand c'est le moteur qui triche :
la file qui perd (M1), l'autoscaling immunisé (M2), l'événement oublié (M3), la panne
bénigne (M5). On le dit au debrief quand c'est une simplification de scénario : limite de
débit unique pour tous les clients, CDN en impasse en vague 5.

**5.5 Latence.** Le p95 par tick et ses exceptions S17 et S21 seront remplacés par une
distribution par classe de requête (M4), en dernier, parce qu'elle recalibre tout. Elle
permet des objectifs par classe : 60 ms pour les lectures, 500 ms pour une commande payée
chez un prestataire à 300 ms (SC6).

**5.6 Parades ajoutées.** Le délai d'attente (M8) et le délestage (M7). Le backoff reste
jouable, cadré : les clients sont votre application. Le budget de relances reste une
mention.

**5.7 Coût métier.** En texte au debrief pour toutes les parades. Une seule mécanique :
le retard de la file (M6), avec un objectif de fraîcheur sur deux vagues (D2).

**5.8 Observabilité.** Rien n'est caché (C4 tient). Chaque incident du debrief nomme la
métrique et le seuil qui l'auraient signalé ; le debrief pose le calcul de dimensionnement
avec les chiffres de la vague. Pas de quiz (P1).

**5.9 Prix.** L'instance à la demande coûte plus cher à l'unité que la fixe (M9b). Le
prix du CDN ne baisse que si l'équilibrage de la vague 3 y survit (M9a).

**5.10 Scénarios.** Partenaires non cachables en vague 4 du raccourcisseur (SC1) ; panne
du worker allongée (SC2) ; doublons : l'incident reste, renommé, et le texte dit qu'ils
sont permanents ; l'outbox garde son coût en charge ; « Capacité de la file » remplace
« Rétention » (SC4) ; la lecture à jour du tournoi devient la vérification avant achat
(SC3) ; SLA à 1 % conservé jusqu'à M4 ; incidents d'au moins cinq ticks après M4 (SC7).

Toutes ces décisions sont à reporter dans `docs/decisions.md` au moment où elles sont
appliquées, avec leur numéro, comme le veut le `CLAUDE.md` du repo.

---

## 6. Système d'aide

Demandé par François le 11 novembre 2026 : un bouton qui donne une partie de la solution,
ou le prochain élément.

**Ce que ça change à l'existant.** I9 dit que la fenêtre « que faire » « ne souffle
jamais la parade ». Elle continue de ne rien souffler d'elle-même ; l'aide ne parle que si
on la demande. À consigner comme I14, qui amende I9.

**Principe.** L'aide ne contient aucun texte écrit à la main par vague. Elle compare le
brouillon aux réponses attendues de la vague, qui deviennent des données (A6), et nomme ce
qui manque. Un recalibrage qui change une réponse change donc l'aide sans y toucher, et le
test qui verrouille la réponse verrouille l'aide.

**Un bouton, « Un indice »**, dans la fenêtre « que faire » pendant la construction et
dans le debrief d'une vague perdue (le moment où on en a besoin). Il donne le prochain
élément manquant, un seul.

**Comment le prochain élément est choisi** (`src/ui/hints.ts`, pur) :

1. Réduire le brouillon à ses éléments, sans tenir compte des identifiants ni des cases :
   types de composants présents, niveaux d'évolution, liens par paire de types. C'est le
   même vocabulaire que les dimensions de `src/data/balance-space.ts`.
2. Parmi les réponses attendues de la vague, garder celles que la partie peut encore
   atteindre : simulées avec l'architecture validée comme point de départ, elles ne
   doivent pas perdre sur le budget à cause de la migration (E2, E3).
3. Prendre la plus proche du brouillon (le moins d'éléments manquants). Le joueur parti
   vers le CDN est guidé vers la réponse CDN, pas vers le scaling.
4. Donner le premier élément manquant, dans l'ordre des dépendances (`requires` des
   dimensions : le load balancer avant le scaling), puis les liens, puis les niveaux.
5. Si rien ne manque et que la vague perdrait quand même : désigner ce qui est en trop
   (budget, complexité), avec le même calcul que le « superflu » du debrief.
6. Si aucune réponse n'est atteignable depuis l'architecture validée (le CDN de la
   vague 3 face à la vague 5) : l'indice propose de revenir à la vague où le choix a été
   fait (E6), en la nommant.

**Forme d'un indice.** Double narration comme partout (I6) : la réplique du chambellan,
et la ligne « En vrai » qui nomme l'élément et dit pourquoi, en reprenant la leçon déjà
écrite pour ce composant ou cet incident dans `src/data/lessons.ts`. Le bouton ou le
bâtiment concerné clignote, par le `highlight` qui sert déjà au tutoriel
(`src/ui/tutorial.ts`).

**Quand l'aide est disponible.** Tranché par François le 11 novembre 2026 : **une aide
par essai perdu.** Chaque vague perdue donne droit à un indice de plus sur cette vague ;
avant le premier échec, le bouton est grisé et dit pourquoi. Les indices déjà obtenus
restent affichés. L'aide ne coûte donc rien de plus que l'essai perdu qui l'a ouverte
(E5 le pénalise déjà) : aucun barème nouveau. Conséquence : le bouton « Toute la
solution » disparaît ; la solution complète s'obtient indice après indice, au rythme des
échecs. Le droit suit le compteur d'essais perdus qui existe déjà (`GameState.replays`) : il
repart de zéro à chaque vague gagnée, et un retour en arrière, qui compte comme un rejeu
(E6), ouvre un indice.

**Tests.**
- Pour chaque vague de chaque scénario, partir de la réponse de la vague précédente et
  suivre les indices un par un : on arrive à une architecture qui gagne, en un nombre fini
  de pas.
- Depuis un brouillon vide, même chose.
- Depuis le parcours CDN en vague 5 du raccourcisseur : l'indice est le retour en arrière.
- Un brouillon déjà gagnant ne reçoit aucun indice de pose.
- Sans essai perdu, aucun indice ; après n essais perdus, n indices au plus.

**Limites assumées.** L'aide ne connaît que les réponses attendues : une architecture
exotique mais gagnante sera ramenée vers la réponse de référence la plus proche. Et elle
désigne un élément, pas une case : le placement reste au joueur.

---

## 7. Références : chiffres, incidents, pratique

Matière des lignes « en vrai » (D3b) et du debrief (D1).

### 7.1 Chiffres : ce que le jeu affiche, ce qu'on voit en vrai

Les ordres de grandeur de capacité viennent de mon expérience, pas d'une documentation :
ils dépendent trop du matériel et de la requête pour qu'un chiffre de fournisseur fasse
foi. Ceux qui ont une source la donnent. Les colonnes « réel » sont à relire sur la page
citée au moment de les afficher : ces quotas changent.

| Élément | Dans le jeu | Ordre de grandeur réel | Commentaire |
|---|---|---|---|
| Serveur d'application | 1 500 req/s, 10 ms, 100 fils | quelques centaines à quelques milliers de req/s par instance selon le travail | crédible |
| Base, lectures simples | 600/s ; une écriture vaut 3 | plusieurs milliers à dizaines de milliers de lectures par clé sur une instance correcte | bas d'un facteur 10 ; le rapport lecture/écriture est plausible |
| Cache | 10 000/s, 1 ms, 95 % de succès | un Redis sur un nœud : de l'ordre de 100 000 opérations/s, moins d'une milliseconde | bas, sans conséquence |
| CDN | 80 % de succès, coût 60 | taux de succès très variable ; coût à la requête très inférieur à celui d'un serveur | prix inversé (M9a) |
| Prestataire de paiement | 30 ms | plusieurs centaines de millisecondes à quelques secondes pour une autorisation | passe à 300 ms avec M4 (SC6) |
| Quota du prestataire de paiement | aucun | Stripe : 100 requêtes/s par compte en production, 25 par point d'entrée par défaut ([docs.stripe.com/rate-limits](https://docs.stripe.com/rate-limits)) | piste de vague future |
| Prestataire d'e-mail | 10 000 messages/s | Amazon SES : 1 message/s et 200 par jour en bac à sable ; en production le débit dépend du compte et se négocie ([quotas SES](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html)) | haut de plusieurs ordres de grandeur ; on garde le rapport quota / trafic, la ligne « en vrai » dit l'écart |
| File : capacité | 200 000 messages, +100 000 par niveau | SQS : nombre de messages non borné ; la limite est la durée, 4 jours par défaut, 14 au plus, et environ 120 000 messages en cours de traitement ([quotas SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html), [points d'entrée et quotas](https://docs.aws.amazon.com/general/latest/gr/sqs-service.html)) | renommée « Capacité de la file » (SC4). Kafka borne en durée ou en octets, RabbitMQ en longueur : de mémoire, à sourcer |
| Autoscaling | prêt en 2 ticks, réduction immédiate | délai de stabilisation par défaut de 300 s sur EC2 Auto Scaling ; AWS suggère 300 s de mise en chauffe faute de mieux ([cooldowns](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-scaling-cooldowns.html), [warmup](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-default-instance-warmup.html)) | crédible avec un tick d'une minute |
| Relances des clients | 3 relances immédiates | SDK AWS, mode standard : 3 tentatives au total, soit 2 relances, avec attente exponentielle et aléa ([comportement de relance](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)) | le jeu montre le client naïf : à dire |
| Budget de relances | absent, mention seule | Google SRE : au plus 3 tentatives par requête et un budget de l'ordre de 10 % du trafic par client ; délester en amont quand la charge dépasse la capacité ([Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/), [bonnes pratiques](https://sre.google/sre-book/service-best-practices/)). Les chiffres 3 et 10 % viennent du chapitre « Handling Overload », lu à travers des résumés : à vérifier avant affichage | — |
| SLA | 1 % d'échecs, p95 à 60 ms | un engagement courant est 99,9 % | conservé, dit au premier briefing |
| Limite par client | 10 à 160 req/s | plausible | — |

### 7.2 Incidents tels qu'ils arrivent

| Incident du jeu | Comment il arrive vraiment | Ce que le jeu en dira |
|---|---|---|
| Cache qui redémarre à froid | Redémarrage, bascule, purge ; réchauffage en minutes | Préchauffage et montée progressive du trafic, en ligne « en vrai » |
| Une instance tombe | Banal ; le load balancer met quelques secondes à la sortir (vérifications de santé) | Ligne « en vrai » |
| Scraper | Il change d'adresses ; la limite par adresse ne suffit pas longtemps | Ligne « en vrai » |
| Tout le cache expire d'un coup | Durées de vie identiques posées au même instant | Première parade réelle : étaler les durées de vie par un aléa. Référence : les baux de memcache chez Facebook (Nishtala et al., NSDI 2013), de mémoire |
| Dépendance lente | Le cas le plus fréquent et le plus destructeur | Délai d'attente d'abord (M8) |
| Dépendance en panne | Souvent un trou noir, pas un refus | Corrigé par M5 |
| Message livré deux fois | Permanent sur toute file « au moins une fois » | Incident renommé « pic de relivraisons », texte sur le bas bruit permanent |
| Événement perdu entre base et bus | Double écriture | Vrai coût de l'outbox : un relais à opérer, un retard de publication |
| Déploiement raté | Cause la plus courante des pannes | Parade réelle : déploiement progressif et retour arrière ; l'autoscaling n'en est pas une (M2) |
| Tempête de relances | État métastable (Bronson et al., « Metastable Failures in Distributed Systems », HotOS 2021, de mémoire) | Délestage (M7), backoff pour qui écrit le client |
| Partition des réplicas | Surtout du retard de réplication, permanent et variable | Ligne « en vrai » |
| File qui déborde | Sur un service géré, c'est l'âge des messages qui pose problème | Retard de la file (M6) |

### 7.3 Ce qu'un ingénieur ferait, là où le jeu s'en écarte

**Raccourcisseur.**
- Vague 4 : une limite par adresse et une par clé d'API, avec des quotas différents par
  classe de client. Le jeu garde une limite unique et le dit au debrief.
- Vague 5 : derrière un CDN, on ne renonce pas au CDN ; on répond en 302 ou avec une durée
  de cache courte, ou on compte les clics dans les journaux du CDN. Dit au debrief.

**Grand marché.**
- Idempotence dès le premier consommateur, pas à la vague 3.
- Une ligne d'outbox dans la même transaction coûte bien moins qu'une commande ; le jeu
  la garde chère parce qu'elle crée le choix de la vague 4.

**Banquier.**
- Vague 1 : appel direct borné par un délai d'attente, parce que le client veut savoir
  s'il a payé, pas parce que c'est rapide.
- Vagues 2 et 4 : différer un paiement est un choix de produit lourd (commandes à
  annuler, clients à relancer), pas une équivalence technique. Porté par l'objectif de
  fraîcheur (D2) et le texte du debrief (D1).

**Tournoi.**
- Vague 1 : retour arrière du déploiement, délestage, budget de relances.
- Vague 2 : surveiller l'âge des messages ; un billet qui arrive 30 minutes après l'achat
  est un incident même si rien n'est perdu.
- Vague 3 : la garantie qui compte est à l'écriture (réservation atomique). Le récit
  change (SC3), la ligne « en vrai » le dit.

### 7.4 Ce qui reste hors du jeu, en connaissance de cause

- Le coût d'exploitation de la complexité (astreintes, incidents) : un plafond par vague
  suffit, tout autre rendu ramènerait de l'aléa (M2 des décisions).
- Les limites par classe de client, le quota d'un prestataire de paiement : pistes de
  vagues futures, pas de corrections.
- La contre-pression générale (M3 des décisions) : seule la file l'obtient, par M1.

---

## 8. Journal des trois rondes de questions

Toutes les recommandations ont été retenues par François le 11 novembre 2026.

**Ronde 1** : public = développeurs qui n'ont jamais opéré ; un tick vaut une minute ;
latence par classe de requête, en dernier ; ordres de grandeur avec ligne « en vrai »
sourcée ; corriger quand le moteur triche, dire quand le scénario simplifie ; citer les
produits réels dans les lignes « en vrai » seulement.

**Ronde 2** : délai d'attente en évolution du serveur, tout-ou-rien ; délestage en
évolution du load balancer ; backoff conservé et cadré ; budget de relances en mention ;
coût métier en texte, plus le retard de la file avec un objectif sur deux vagues ;
observabilité par une ligne « ce qui vous aurait prévenu » et le calcul posé ; surcoût de
l'autoscaling, prix du CDN sous condition.

**Ronde 3** : partenaires non cachables ; panne du worker allongée ; doublons en incident
renommé ; outbox inchangée ; paiement à 300 ms après M4 ; gradation délai, disjoncteur,
file ; autoscaling non forcé en vague 1 du tournoi ; lecture à jour = vérification avant
achat ; « Capacité de la file » ; SLA à 1 % conservé ; incidents d'au moins cinq ticks
après M4.

**Ajout hors ronde** : le système d'aide (section 6).

**Tranché ensuite** : une aide est disponible par essai perdu (section 6).
