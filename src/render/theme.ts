import type { RequestKind } from '../engine/types.ts';

/**
 * Formes low-poly que la scène sait construire. Le thème choisit une forme par composant :
 * les formes sont du code, mais leur attribution, les noms et les couleurs sont des données.
 */
export type Shape = 'hamlet' | 'watchtower' | 'gatehouse' | 'tower' | 'lectern' | 'keep' | 'stables';

export interface BuildingStyle {
  /** Nom dans la métaphore ; le nom technique du catalogue est toujours affiché à côté. */
  metaphor: string;
  shape: Shape;
  color: string;
  accent: string;
}

export interface VehicleStyle {
  metaphor: string;
  color: string;
  /** Largeur, hauteur, longueur, en unités de la grille. */
  size: [number, number, number];
}

export interface Theme {
  id: string;
  title: string;
  ground: string;
  road: string;
  /** Teinte d'un bâtiment saturé, et des requêtes en échec. */
  alert: string;
  /** Nom d'une requête en échec qui fait demi-tour. */
  failed: string;
  /** Trafic abusif repoussé par le rate limiting : l'ennemi du tower defense. */
  hostile: { metaphor: string; color: string };
  /** Enceinte autour de tout ce qui n'est pas une source : la cité à défendre. */
  ramparts?: { color: string };
  buildings: Record<string, BuildingStyle>;
  vehicles: Record<RequestKind, VehicleStyle>;
}
