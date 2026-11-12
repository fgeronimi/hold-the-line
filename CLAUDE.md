# Hold the Line

Tower defense de system design : on construit une architecture, des vagues de trafic
la testent. Spec à jour : `docs/spec.md`. Phase 2 : le jeu en 3D sur un plateau hexagonal.

**`docs/decisions.md` garde le pourquoi de chaque choix.** Le lire avant de toucher au
moteur ou au calibrage. Toute nouvelle décision y est consignée, puis reportée dans
`docs/spec.md`.

## Commandes

- `npm test` : Vitest, tous les tests
- `npm run typecheck` : `tsc --noEmit` (TypeScript 7)
- `npm run balance` : simulation en masse des quatre scénarios, ~17 000 architectures
  canoniques pour le raccourcisseur, ~1 min (Node exécute le TypeScript nativement, sans
  build) ; `npm run balance -- market` n'en joue qu'un, par son id ; sort en code 1 s'il y a
  un KO
- `npm run balance:snapshot` : réécrit `docs/balance-snapshot.txt` (rapport sans durées,
  coûts arrondis à 2 décimales) ; `npm run balance:check` le compare au rapport courant et
  échoue sur un écart ou un KO (tous les scénarios, pas de filtre)
- `npm run dev` : interface de jeu et de calibrage ; `npm run build` : site statique
  dans `dist/`, chemins relatifs pour GitHub Pages

## Architecture

- `src/engine/` : moteur pur, sans DOM. `simulateWave(architecture, wave, catalog, previous?)`
  renvoie jauges, facture (dont migration depuis `previous`), journal d'événements et
  métriques par tick. `game.ts` enchaîne les vagues et les rejeux, `score.ts` note.
- Modèle de flux par ticks : à chaque tick, le trafic traverse le graphe en ordre
  topologique ; au-delà de sa capacité un nœud fait échouer l'excédent. Seule la file
  garde un arriéré d'un tick à l'autre. Pas d'aléa, donc pas de graine.
- `src/engine/simulate.ts` ne garde que la boucle des ticks. `World` (`world.ts`) porte ce
  qui vaut pour toute la vague : graphe, évolutions résolues une fois (`upgrades.ts`),
  arriérés, autoscaling. `Now` est reconstruit à chaque tick : compteurs (`ledger.ts`),
  incidents (`incidents.ts`), circuits ouverts (`circuits.ts`). Les traitements prennent
  `(node, def, incoming, w, now)` : pas de fermeture sur un état muté. Un fichier par
  comportement dans `src/engine/nodes/` ; le routage des flux dans `route.ts`, la latence et
  la règle du p95 dans `latency.ts`, les relances dans `retries.ts`, le verdict dans
  `verdict.ts`, ses phrases dans `messages.ts`.
- Le moteur publie ce que le rendu affiche, qui ne recalcule rien : `TickMetrics.countedSoFar`
  et `clientFailedSoFar` (taux d'échec cumulé du rejeu), `WaveResult.latencyBreachTick`,
  `WaveResult.losses` (raisons typées ; `lossReasons` en est la mise en phrases).
- `src/engine/types.ts` : seul le `Behavior` d'un composant est codé dans le moteur ;
  capacités, coûts, poids et contraintes viennent des données.
- `src/engine/routing.ts` : les liens ne sont pas typés. Chaque composant déclare
  `accepts` et `routingPriority` ; un type de requête va au voisin le plus spécialisé
  qui l'accepte. Un composant `lookaside` (le cache) est consulté, pas traversé : il sert
  sa part et le reste repart du nœud qui l'a consulté (cache-aside). `linkFlows` donne
  ce qui circule vraiment, pour l'affichage.
- `src/ui/` : interface de jeu plein écran, TypeScript natif sans framework. `main.ts`
  tient l'état, la phase de partie (`briefing` → `build` → `wave` → `debrief`) et les
  actions (`data-action` délégués) ; `views.ts` rend en chaînes HTML les calques posés sur
  le plateau (barre du haut, barre d'outils, fiche, fenêtres, tiroir de debug) à chaque
  changement ; `board.ts` (poser, déplacer, relier par A*), `debrief.ts` (analyse du
  chambellan), `tutorial.ts` (guide de la vague 1), `hints.ts` (le bouton « Un indice », déduit de
  `Wave.answers`, I14), `time.ts` (les durées en minutes), `editor.ts` et `calibration.ts` sont purs et testés.
- `src/ui/main.ts` ne fait que le câblage : écouteurs, scène 3D, effets, rendu. Chaque geste
  est une fonction pure de `actions.ts` qui renvoie `{ patch, effects }` ; la partie gardée
  passe par `session.ts` (`readStore` valide le magasin, `withGame` n'y copie le calibrage
  que s'il a eu lieu) ; annuler / rétablir est dans `history.ts`.
- La main de cartes (I15) : `src/ui/hand.ts` donne la géométrie de l'éventail, sans unité (la
  feuille de style la multiplie par un pas qui dépend de la largeur) ; `views/hand.ts` rend
  une carte par bâtiment constructible ; `CityScene.thumbnails` rend leurs illustrations une
  fois, hors écran, avec le renderer du plateau (`ViewState.thumbnails`). Le calque `#hand`
  porte la main ou la carte du bâtiment sélectionné, et n'est réécrit que si son HTML change.
- L'habillage (I16) est dans `src/ui/style.css` : matières (`--m-parchment`, `--m-stone`,
  `--m-brass`), filet (`--line`) et relief (`--raise`, `--raise-low`, `--pressed`) en variables,
  à réutiliser plutôt que de redéfinir une ombre. `src/ui/icons.ts` : les pictogrammes SVG
  de l'interface (`icon('coin')`) ; pas d'emoji dans un calque. Titrage : `--display`
  (Lilita One, `src/ui/fonts/`, OFL). Une infobulle se pose avec `data-tip` et un `aria-label`.
- `src/ui/draft.ts` : `draftInfo(arch, catalog)` donne validation, ordre, flux et facture d'un
  brouillon, mémorisés par identité de référence. Vues, guide, aide et plateau le lisent au
  lieu de rappeler `validateArchitecture` ou `linkFlows`.
- L'analyse du chambellan est calculée quand la tentative est enregistrée
  (`Attempt.analysis`) et ne se refait que si le calibrage a changé. Ses répliques qui ne
  viennent pas d'une leçon sont dans `Theme.debrief` ; le debrief reconnaît les évolutions
  par leur effet, jamais par leur identifiant.
- `src/ui/views.ts` ré-exporte les calques de `src/ui/views/` (`hud.ts`, `toolbar.ts`,
  `hand.ts`, `card.ts`, `dialog.ts`, `debug.ts`, et `common.ts` pour les types, `esc` et les formats).
- Mode debug : `?debug` dans l'URL ou la touche D. Essais hors partie, vue tableau et
  calibrage n'existent que là.
- Le plateau 3D (`CityScene`) est créé une fois dans `#board`, **hors** des zones
  réécrites : `main.ts` lui passe le brouillon par `setArchitecture` quand il change, et le
  rejeu (`startReplay`) l'anime sur place.
- `src/render/` : rejeu 3D isométrique (Three.js), chargé à la demande depuis le debrief.
  `hex.ts` (grille hexagonale), `layout.ts` et `traffic.ts` sont purs et testés ; `scene.ts` ne fait qu'afficher un tick
  déjà calculé. La métaphore vient d'un thème en données (`src/data/themes/fortified-city.ts`).
  `effects.ts` dessine les incidents (fumée, feu, lettres, bouclier) sans état ; les
  pastilles d'évolution (`upgradePips` dans `views.ts`) sont posées par `setPips` au pied du
  bâtiment sélectionné, et leurs clics passent par la délégation de `main.ts` ; une case vide
  cliquée, ou « Bâtir », ouvre la main de cartes (`renderHand`, I15) ; l'autoscaling a ses fondations sur une case voisine
  (`findAnnexes`, décorative, non réservée) ; `fleet.ts`
  range les personnages, une géométrie instanciée par pose de marche. `vitrine.html`
  (`npm run dev`, puis `/vitrine.html`) les montre un par un sur des îlots de démonstration
  (`showcase.ts`) : à garder à jour quand un effet change. Hors build. Ses îlots partagent un
  seul contexte WebGL (Chrome n'en garde que 16) : ne pas en créer un par îlot.
- `public/models/kaykit/` : modèles glTF du KayKit Medieval Hexagon Pack (CC0), chargés
  par le rejeu. N'y copier que les modèles utilisés (`.gltf` + `.bin`, à plat, avec la
  texture commune `hexagons_medieval.png`) et tenir `public/models/CREDITS.md` à jour.
- `public/models/kaykit-chars/` : personnages KayKit (CC0) allégés par
  `node scripts/strip-characters.mjs <originaux> public/models/kaykit-chars`. Ne pas
  copier un personnage original (~4 Mo) : le passer par ce script.
- `src/balance/` : outillage d'équilibrage (énumération canonique, rapport par vague) ;
  hors moteur, il ne fait qu'appeler `simulateWave`. Il ne connaît que des dimensions :
  chaque scénario décrit la sienne dans `src/data/balance-space.ts`.
- `src/data/catalog.ts` : composants et évolutions. Une file ou un pub/sub n'alimente qu'un
  `worker` ou un service en place, jamais un `app-server` (X8) ; `withWorkers` (`src/ui/session.ts`)
  convertit les anciennes sauvegardes au chargement. `src/data/scenarios/` : un fichier
  par scénario, plus ses architectures types (`*.archetypes.ts`) ; `index.ts` liste les
  scénarios de l'écran de choix. Une partie par scénario, sauvegardées ensemble.
- `tests/url-shortener.test.ts`, `tests/market.test.ts`, `tests/resilience.test.ts` et `tests/tournament.test.ts` verrouillent l'équilibrage : chaque vague gagnée avec la
  réponse attendue, perdue sans elle et perdue sur-dimensionnée.

## Pièges

- Après tout changement voulu de l'équilibrage, régénérer l'instantané (`npm run
  balance:snapshot`) et relire le diff ; une refactorisation du moteur doit le laisser
  identique (`npm run balance:check`).

- Recalibrer le catalogue casse souvent `url-shortener.test.ts` : c'est voulu, vérifier
  que le scénario reste jouable avant d'ajuster les tests.
- `tests/engine.test.ts` et `tests/engine-mechanics.test.ts` utilisent chacun leur propre
  catalogue : ne pas les brancher sur `src/data/catalog.ts`, sinon le calibrage casse les
  tests du moteur. Le second fige aussi des comportements à corriger (« À changer par… ») :
  une correction du moteur doit se voir dans son diff.
- `tests/conservation.test.ts` vérifie que le moteur ne crée ni ne perd de trafic, sur un
  échantillon des quatre espaces ; ses `it.fails` sont des bugs connus, à lever en les
  corrigeant.
- Les réponses attendues de chaque vague sont des données (`Wave.answers`, des choix de
  `src/data/balance-space.ts`) : les tests de verrouillage et l'aide les lisent. Un
  recalibrage qui déplace une réponse la met à jour là, nulle part ailleurs.
- La latence du SLA compte lectures, écritures et événements async ; l'async sort du chemin
  critique dès qu'il passe par une file (décision S10). Un service métier appelé en direct
  met sa latence (200 ms) sur le chemin du client, entière : un tick vaut la moyenne, ou
  l'événement direct s'il attend plus (`slaLatencyMs`, S17). C'est un p95 des latences par tick, pas un
  vrai p99 par requête : toujours l'afficher « p95 (approx.) ».
- Le rate limiting ne compte que le synchrone (décision C5) ; ses niveaux sont des index
  de palier, pas des quantités.
- Imports relatifs avec l'extension `.ts` obligatoire : c'est ce qui permet à Node
  de lancer `scripts/` sans build.
- Une réponse attendue doit rester atteignable depuis celles de la vague précédente
  (migration comprise, E2/E3) : `npm run balance` le vérifie par un contrôle d'enchaînement
  et sort en KO s'il y a blocage, c'est-à-dire qu'aucune ne mène à gagner (décision B7) ; une
  impasse isolée se sort par un retour en arrière (E6) et reste listée. Un même bâtiment
  porte le même id dans toutes les variantes d'un espace, sinon la migration est facturée à tort.
  Recalibrer le budget d'une vague, c'est le relancer.
- Un composant ou une évolution ajouté à un scénario doit entrer dans son espace de
  `src/data/balance-space.ts`, sinon `npm run balance` ne voit pas les réponses qui s'en
  servent. Une dimension avec `requires` vient après celle dont elle dépend.
- `tests/balance.test.ts` énumère un espace réduit qui doit contenir toutes les réponses
  attendues : si un recalibrage déplace une réponse hors de cet espace, l'agrandir.
- Le MVP de la spec a été élargi au CDN et à l'autoscaling (`docs/decisions.md`, X1–X4).
- La partie est gardée dans `localStorage` (clé `hold-the-line:v9`) : changer la version
  de la clé dès que la forme de la partie change. Catalogue et scénario n'y sont copiés que
  si le joueur a calibré en debug ; sinon ils viennent du code, et une modification des
  données atteint les parties en cours sans changer la clé.
- Une carte de la main est un `<button>` : dedans, que des `<span>`. Son survol est en CSS
  pur ; ne pas réécrire `#hand` sans changement (`renderHandLayer`), la distribution
  rejouerait et la carte survolée retomberait. Au doigt, pas de survol : `ActionArgs.touch`
  fait soulever la carte au premier contact (`liftedCard`), jouer au second.
- Le style de base des boutons exclut `.hcard` et `.pip` (`button:where(:not(...))`) : leur
  enfoncement écraserait la transformation qui place la carte dans l'éventail. `.gauge` existe
  deux fois (jauge du HUD, barre de charge d'une étiquette) : celle du HUD est sous `.hud-bar`.
- Tout texte venant de l'état passe par `esc()` (interface) ou `escapeHtml()` (rendu)
  avant d'entrer dans le HTML.
- Le rendu ne simule rien : s'il faut une donnée de plus pour animer, elle s'ajoute aux
  ticks du moteur, jamais recalculée dans `src/render/`.
- Le plateau est un hexagone (`src/data/board.ts`), les clients à sa pointe gauche (0, 0),
  traversé par une rivière. `src/render/terrain.ts` choisit les tuiles de route et de rivière
  et dit où un pont est possible ; `findPath` ne franchit la rivière que par lui.
- `ArchNode.cell` et `ArchLink.path` sont de la mise en scène : la simulation les ignore.
  Tout brouillon passe par `autoPlace` dans `update()`, pour qu'un bâtiment ajouté sans
  case (vue tableau, ancienne sauvegarde) en reçoive une.
- Un tick vaut une minute pour le joueur (M7) : tout texte de durée se calcule en minutes à
  partir des ticks (`from`/`until` des incidents, `src/ui/time.ts`) ; les débits restent par
  seconde, et les compteurs cumulés (arriéré d'une file) sont à l'échelle du jeu.
- Double narration (décision I6) : nom technique d'abord, métaphore entre parenthèses ;
  toute réplique du chambellan a sa ligne « En vrai ».
- Les incidents (X5) sont calés pour ne faire perdre aucune réponse attendue : en ajouter
  un, c'est relancer `npm run balance` et `url-shortener.test.ts`.
- Pas de cascade par saturation : un aval saturé ne ralentit pas l'amont (M3). La seule
  cascade est celle des fils d'exécution (S14) : un serveur qui appelle en direct une
  dépendance lente sature pour tout le monde, sauf derrière un circuit breaker ou une file.
- La file impose le rythme de l'aval (M8) : un flux sorti d'une file porte `Stream.queue` ;
  ce qu'un nœud ne peut pas en servir retourne dans la file (`deferred` / `requeued`, remis par
  `settleQueues` en fin de tick) au lieu d'échouer, après le trafic direct. Un nouveau nœud
  qui fait échouer par capacité doit passer par `serveShared` ou `deferExcess` (`nodes/common.ts`).
- Le travail d'un flux est divisé par sa taille de lot (`batch`), comme les fils qu'il
  occupe (M6), mais les échecs se comptent toujours en messages.
- Des clients qui relancent (`retries`, S19) changent deux règles : un échec relancé sort
  du taux d'échec (sa relance compte à sa place, `replayStats` fait pareil), et un nœud
  saturé sert capacité / charge de ce qu'il pourrait. Une saturation légère peut donc
  dégénérer en tempête : vérifier la marge quand un scénario a des clients qui relancent.
- Une source `consistent` (S21) ne tombe jamais en cache et sa latence compte à part dans
  le SLA : c'est la seule population, avec l'événement direct (S17), mesurée hors moyenne.
