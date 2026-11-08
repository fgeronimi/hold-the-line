# Hold the Line

Un jeu de construction et de défense où l'on bâtit une architecture distribuée, puis on
la fait tenir vague après vague. Chaque vague rejoue une relance d'entretien de
**system design** : une nouvelle contrainte arrive, il faut adapter le schéma sans tout
casser, en arbitrant entre coût, complexité et fiabilité.

**Jouer : https://fgeronimi.github.io/hold-the-line/**

Le premier scénario, *Les portes de la cité*, est un raccourcisseur d'URL vu comme une
cité médiévale :

| Dans la cité | Dans l'architecture |
|---|---|
| Hameaux | Clients |
| Porte de la cité (sa caserne : la garde) | Load balancer (rate limiting) |
| Tours des scribes | Serveurs d'application, une tour par instance |
| Carnet du scribe | Cache (cache-aside) |
| Archives royales, et leurs annexes | Base de données, et réplicas en lecture |
| Relais de poste | File de messages |
| Avant-poste | CDN |
| Messagers, porteurs, mages | Lectures, écritures, tâches async |
| Pillards squelettes | Trafic abusif |

Le vrai nom technique est toujours affiché à côté de la métaphore : le jeu prépare à des
entretiens, la métaphore aide à mémoriser.

## Comment on joue

1. Le chambellan annonce la vague : le trafic, le budget, le plafond de complexité, le SLA.
2. Bâtir sur le plateau hexagonal avec la barre du bas : poser des bâtiments, les relier
   (clic sur le départ, puis sur l'arrivée), régler leurs évolutions dans leur fiche.
3. Lancer la vague : elle se joue en direct, chaque requête fait l'aller-retour depuis les
   hameaux, +1 quand la réponse revient, −1 là où elle est refusée.
4. Le chambellan explique ce qui a tenu ou cassé, et la parade. Une vague perdue se
   rejoue ; le menu permet de revenir à une vague antérieure.

Mode debug (calibrage, vue tableau, essais) : ajouter `?debug` à l'URL, ou touche D.

## Développement

```bash
npm install
npm run dev        # le jeu en local
npm test           # tests (Vitest)
npm run typecheck  # TypeScript
npm run balance    # simulation en masse : l'équilibrage des vagues
npm run build      # site statique dans dist/
```

TypeScript natif, Vite, Three.js pour le plateau. Le moteur de simulation (`src/engine/`)
est pur et sans DOM ; scénarios, composants et thèmes sont des données (`src/data/`).
Les décisions de design sont dans [`docs/decisions.md`](docs/decisions.md).

Chaque push sur `main` lance les tests puis publie sur GitHub Pages.

## Crédits

Modèles 3D : [KayKit](https://kaylousberg.com) de Kay Lousberg (Medieval Hexagon Pack,
Character Packs Adventurers et Skeletons), sous licence CC0. Détails dans
[`public/models/CREDITS.md`](public/models/CREDITS.md).

Le jeu prolonge le calendrier
[Advent of System Design](https://github.com/fgeronimi/advent-of-system-design).
