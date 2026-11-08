# Modèles 3D

Les modèles de `kaykit/` viennent du **KayKit Medieval Hexagon Pack 1.0** de
**Kay Lousberg** (www.kaylousberg.com), sous licence
[CC0 1.0](http://creativecommons.org/publicdomain/zero/1.0/) (voir `kaykit/LICENSE.txt`).
Le crédit n'est pas obligatoire ; on le donne quand même.

Source : https://github.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0
(dossier `Assets/gltf/`). Seuls les modèles utilisés sont copiés, à plat, avec leur
`.bin` et la texture commune `hexagons_medieval.png`, identique dans tous les dossiers
du pack.

Les personnages de `kaykit-chars/` viennent des packs **KayKit Character Pack :
Adventurers 1.0** (Rogue, Barbarian, Mage) et **KayKit Character Pack : Skeletons 1.0**
(Skeleton_Warrior) de **Kay Lousberg**, sous licence CC0 (voir les `LICENSE-*.txt`).

- https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0
- https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0

Ils ont été allégés avec `scripts/strip-characters.mjs` (gltf-transform) : une seule
animation de marche gardée, pour figer la pose, et seulement les accessoires utilisés.
Les originaux pèsent environ 20 Mo au total, les versions allégées 1,3 Mo.
