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
- `npm run dev` / `npm run build` : Vite (pas encore d'`index.html`)

## Architecture

- `src/engine/` : moteur pur, sans DOM. `simulateWave(architecture, wave, catalog, previous?)`
  renvoie jauges, facture (dont migration depuis `previous`), journal d'événements et
  métriques par tick. `game.ts` enchaîne les vagues et les rejeux, `score.ts` note.
- Modèle de flux par ticks : à chaque tick, le trafic traverse le graphe en ordre
  topologique ; au-delà de sa capacité un nœud fait échouer l'excédent. Seule la file
  garde un arriéré d'un tick à l'autre. Pas d'aléa, donc pas de graine.
- `src/engine/types.ts` : seul le `Behavior` d'un composant est codé dans le moteur ;
  capacités, coûts, poids et contraintes viennent des données.
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
- Pas de cascade de pannes : un aval saturé ne ralentit pas l'amont (décision M3, V2).
- Le travail d'un flux est divisé par sa taille de lot (`batch`), mais les échecs se
  comptent toujours en messages.
