/**
 * La géométrie de la main de cartes : où tombe chaque carte dans l'éventail. Sans unité ni
 * DOM : la feuille de style multiplie ces facteurs par un pas qui dépend de la largeur de
 * l'écran, si bien qu'un redimensionnement ne demande aucun rendu.
 */

/** L'ouverture totale de l'éventail, en degrés : au-delà, les cartes du bord deviennent illisibles. */
const MAX_SPREAD_DEG = 24;
/** L'angle entre deux cartes voisines tant que la main est petite. */
const STEP_DEG = 5;

export interface FanSlot {
  /** Rang depuis le centre de la main : −1,5 ; −0,5 ; 0,5 ; 1,5 pour quatre cartes. */
  offset: number;
  /** Inclinaison, en degrés : négative à gauche du centre. */
  tilt: number;
  /** De combien la carte descend, en pas : les bords tombent comme sur un arc. */
  drop: number;
}

export function fan(count: number): FanSlot[] {
  if (count <= 0) return [];
  const middle = (count - 1) / 2;
  const step = count > 1 ? Math.min(STEP_DEG, MAX_SPREAD_DEG / (count - 1)) : 0;
  return Array.from({ length: count }, (_, i) => {
    const offset = i - middle;
    // Le carré de l'écart au centre, ramené entre 0 et 1 : la main garde la même courbure
    // qu'elle tienne trois cartes ou onze.
    const drop = middle > 0 ? (offset / middle) ** 2 : 0;
    return { offset, tilt: offset * step, drop };
  });
}
