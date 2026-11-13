import { superfluous } from './lean.ts';
import type { Architecture, Catalog, Wave, WaveResult } from './types.ts';

/**
 * Les trois objectifs d'une vague (décision E7), chacun vaut une étoile : la tenir, sans rien
 * de superflu, et sans dépasser le seuil d'économie. Pas de score (E9) : on ne peut avoir les
 * trois qu'avec une architecture juste, et on peut rejouer pour les obtenir.
 */
export interface Stars {
  held: boolean;
  lean: boolean;
  thrifty: boolean;
}

export const NO_STARS: Stars = { held: false, lean: false, thrifty: false };

export function starsFor(result: WaveResult, arch: Architecture, wave: Wave, catalog: Catalog): Stars {
  const held = result.won;
  return {
    held,
    // Une simulation par bâtiment et par évolution : seulement si la vague est tenue.
    lean: held && superfluous(arch, wave, catalog).length === 0,
    thrifty: held && result.gauges.cost.value <= (wave.thriftyCost ?? wave.budget),
  };
}

export const starCount = (s: Stars) => Number(s.held) + Number(s.lean) + Number(s.thrifty);

/** Les meilleures étoiles de deux essais, objectif par objectif : chacun n'a besoin d'être atteint qu'une fois. */
export const bestStars = (a: Stars | undefined, b: Stars): Stars => ({
  held: !!a?.held || b.held,
  lean: !!a?.lean || b.lean,
  thrifty: !!a?.thrifty || b.thrifty,
});
