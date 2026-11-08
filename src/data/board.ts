/**
 * Le plateau jouable est un grand hexagone de cases hexagonales. Les clients sont posés à
 * sa pointe gauche, la case (0, 0) : le trafic entre par le bord et s'écoule vers la droite.
 */
export const BOARD = { center: { q: 9, r: 0 }, radius: 9 };

/**
 * La rivière, du bord haut au bord bas, en tronçons droits : direction (index de
 * `hexNeighbours`, 4 = sud-ouest, 5 = sud-est) et nombre de cases. Les tronçons droits
 * laissent des cases où un chemin peut la franchir par un pont.
 */
export const RIVER = {
  from: { q: 12, r: -9 },
  runs: [
    { dir: 4, length: 4 },
    { dir: 5, length: 4 },
    { dir: 4, length: 4 },
    { dir: 5, length: 3 },
    { dir: 4, length: 3 },
  ],
};
