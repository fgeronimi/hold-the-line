# Hold the Line

Tower defense de system design : on construit une architecture, des vagues de trafic
la testent. Spec : `Hold the Line — Spécification MVP` (hors repo). Phase 1 en cours :
moteur et équilibrage, aucune interface soignée.

**`docs/decisions.md` prime sur la spec.** Le lire avant de toucher au moteur ou au
calibrage ; les décisions marquées « à appliquer » ne sont pas encore dans le code.
Toute nouvelle décision de design y est consignée, avec son pourquoi.

## Commandes

- `npm test` : Vitest, tous les tests
- `npm run typecheck` : `tsc --noEmit` (TypeScript 7)
- `npm run balance` : simulation en masse, ~17 000 architectures canoniques sur chaque
  vague, ~30 s (Node exécute le TypeScript nativement, sans build)
- `npm run dev` : interface de jeu et de calibrage ; `npm run build` : site statique
  dans `dist/`, chemins relatifs pour GitHub Pages

## Architecture

- `src/engine/` : moteur pur, sans DOM. `simulateWave(architecture, wave, catalog, previous?)`
  renvoie jauges, facture (dont migration depuis `previous`), journal d'événements et
  métriques par tick. `game.ts` enchaîne les vagues et les rejeux, `score.ts` note.
- Modèle de flux par ticks : à chaque tick, le trafic traverse le graphe en ordre
  topologique ; au-delà de sa capacité un nœud fait échouer l'excédent. Seule la file
  garde un arriéré d'un tick à l'autre. Pas d'aléa, donc pas de graine.
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
  chambellan), `tutorial.ts` (guide de la vague 1), `editor.ts` et `calibration.ts` sont purs et testés.
- Mode debug : `?debug` dans l'URL ou la touche D. Essais hors partie, vue tableau et
  calibrage n'existent que là.
- Le plateau 3D (`CityScene`) est créé une fois dans `#board`, **hors** des zones
  réécrites : `main.ts` lui passe le brouillon par `setArchitecture` quand il change, et le
  rejeu (`startReplay`) l'anime sur place.
- `src/render/` : rejeu 3D isométrique (Three.js), chargé à la demande depuis le debrief.
  `hex.ts` (grille hexagonale), `layout.ts` et `traffic.ts` sont purs et testés ; `scene.ts` ne fait qu'afficher un tick
  déjà calculé. La métaphore vient d'un thème en données (`src/data/themes/fortified-city.ts`).
- `public/models/kaykit/` : modèles glTF du KayKit Medieval Hexagon Pack (CC0), chargés
  par le rejeu. N'y copier que les modèles utilisés (`.gltf` + `.bin`, à plat, avec la
  texture commune `hexagons_medieval.png`) et tenir `public/models/CREDITS.md` à jour.
- `public/models/kaykit-chars/` : personnages KayKit (CC0) allégés par
  `node scripts/strip-characters.mjs <originaux> public/models/kaykit-chars`. Ne pas
  copier un personnage original (~4 Mo) : le passer par ce script.
- `src/balance/` : outillage d'équilibrage (énumération canonique, rapport par vague) ;
  hors moteur, il ne fait qu'appeler `simulateWave`.
- `src/data/catalog.ts` : composants et évolutions. `src/data/scenarios/` : un fichier
  par scénario, plus ses architectures types (`*.archetypes.ts`).
- `tests/url-shortener.test.ts` verrouille l'équilibrage : chaque vague gagnée avec la
  réponse attendue, perdue sans elle et perdue sur-dimensionnée.

## Pièges

- Recalibrer le catalogue casse souvent `url-shortener.test.ts` : c'est voulu, vérifier
  que le scénario reste jouable avant d'ajuster les tests.
- `tests/engine.test.ts` utilise son propre catalogue : ne pas le brancher sur
  `src/data/catalog.ts`, sinon le calibrage casse les tests du moteur.
- La latence du SLA ne compte que les lectures et écritures ; l'async est hors chemin
  critique dès qu'il passe par une file. C'est un p95 des latences par tick, pas un
  vrai p99 par requête : toujours l'afficher « p95 (approx.) ».
- Le rate limiting ne compte que le synchrone (décision C5) ; ses niveaux sont des index
  de palier, pas des quantités.
- Imports relatifs avec l'extension `.ts` obligatoire : c'est ce qui permet à Node
  de lancer `scripts/` sans build.
- `tests/balance.test.ts` énumère un espace réduit qui doit contenir toutes les réponses
  attendues : si un recalibrage déplace une réponse hors de cet espace, l'agrandir.
- Le MVP de la spec a été élargi au CDN et à l'autoscaling (`docs/decisions.md`, X1–X4).
- Le calibrage et la partie sont gardés dans `localStorage` (clé `hold-the-line:v5`) :
  changer la version de la clé dès que la forme de la partie ou du catalogue change.
- Tout texte venant de l'état passe par `esc()` (interface) ou `escapeHtml()` (rendu)
  avant d'entrer dans le HTML.
- Le rendu ne simule rien : s'il faut une donnée de plus pour animer, elle s'ajoute aux
  ticks du moteur, jamais recalculée dans `src/render/`.
- `ArchNode.cell` et `ArchLink.path` sont de la mise en scène : la simulation les ignore.
  Tout brouillon passe par `autoPlace` dans `update()`, pour qu'un bâtiment ajouté sans
  case (vue tableau, ancienne sauvegarde) en reçoive une.
- Double narration (décision I6) : nom technique d'abord, métaphore entre parenthèses ;
  toute réplique du chambellan a sa ligne « En vrai ».
- Les incidents (X5) sont calés pour ne faire perdre aucune réponse attendue : en ajouter
  un, c'est relancer `npm run balance` et `url-shortener.test.ts`.
- Pas de cascade de pannes : un aval saturé ne ralentit pas l'amont (décision M3, V2).
- Le travail d'un flux est divisé par sa taille de lot (`batch`), mais les échecs se
  comptent toujours en messages.
