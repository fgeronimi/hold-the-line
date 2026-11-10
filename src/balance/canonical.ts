import type { Architecture } from '../engine/types.ts';

/**
 * Un espace d'architectures canoniques (décision B3) : chaque scénario a son schéma de
 * référence, où chaque composant a une place fixe ; seuls varient sa présence et ses
 * niveaux. L'énumération, les stratégies et la dominance ne connaissent que ces
 * dimensions, pas les composants : un nouveau scénario n'a qu'à décrire les siennes.
 */
export interface Dimension {
  id: string;
  /** Niveaux essayés, du plus petit au plus grand ; 0 veut dire absent. */
  levels: number[];
  /**
   * Nom dans la stratégie dès que la dimension n'est pas à 0 (décision B2 : les niveaux
   * sont ignorés). Une liste quand chaque niveau est une variante distincte (une façon
   * de livrer, par exemple) : `label[niveau]`. Sans nom, la dimension n'est qu'un réglage
   * (le nombre de workers) et ne compte ni comme stratégie ni comme élément à retirer.
   */
  label?: string | readonly string[];
  /** N'a de sens que si cette autre dimension est active : le scaling sans load balancer. */
  requires?: string;
}

export type Choice = Readonly<Record<string, number>>;

export interface BalanceSpace {
  dimensions: readonly Dimension[];
  build(choice: Choice): Architecture;
}

export interface Candidate {
  choice: Choice;
  arch: Architecture;
  /** Décision B2 : composants et évolutions activés, niveaux ignorés. */
  strategy: string;
  parts: string[];
}

const nameOf = (d: Dimension, level: number): string | undefined =>
  level === 0 ? undefined : typeof d.label === 'string' ? d.label : d.label?.[level];

export function strategyParts(space: BalanceSpace, c: Choice): string[] {
  return space.dimensions.map((d) => nameOf(d, c[d.id] ?? 0)).filter((p): p is string => p !== undefined);
}

export function strategyName(parts: string[], empty = 'serveur + base'): string {
  return parts.length > 0 ? parts.join(' + ') : empty;
}

/** Tout au maximum : la réponse sur-dimensionnée type, qui doit perdre partout. */
export function maxedChoice(space: BalanceSpace): Choice {
  return Object.fromEntries(space.dimensions.map((d) => [d.id, Math.max(...d.levels)]));
}

export function choiceKey(space: BalanceSpace, c: Choice): string {
  return space.dimensions.map((d) => c[d.id] ?? 0).join('|');
}

/** Ce qui ne tient qu'à `id` : le retirer retire aussi ces dimensions, transitivement. */
function dependents(space: BalanceSpace, id: string): string[] {
  const direct = space.dimensions.filter((d) => d.requires === id).map((d) => d.id);
  return [...direct, ...direct.flatMap((d) => dependents(space, d))];
}

/**
 * Les architectures obtenues en retirant un seul élément nommé, avec ce qui en dépend :
 * retirer le load balancer retire aussi le scaling, l'autoscaling et le rate limiting.
 */
export function reductions(space: BalanceSpace, c: Choice): Choice[] {
  return space.dimensions
    .filter((d) => d.label !== undefined && (c[d.id] ?? 0) > 0)
    .map((d) => {
      const out: Record<string, number> = { ...c, [d.id]: 0 };
      for (const dep of dependents(space, d.id)) out[dep] = 0;
      return out;
    });
}

/** Toutes les architectures canoniques de l'espace, sans doublon. */
export function* enumerate(space: BalanceSpace): Generator<Candidate> {
  const dims = space.dimensions;
  function* walk(i: number, acc: Record<string, number>): Generator<Choice> {
    if (i === dims.length) {
      yield { ...acc };
      return;
    }
    const d = dims[i]!;
    // Une dimension dont le parent est absent ne prend que 0 : pas de doublon.
    const levels = d.requires && (acc[d.requires] ?? 0) === 0 ? [0] : d.levels;
    for (const level of levels) {
      acc[d.id] = level;
      yield* walk(i + 1, acc);
    }
  }
  for (const choice of walk(0, {})) {
    const parts = strategyParts(space, choice);
    yield { choice, arch: space.build(choice), strategy: strategyName(parts), parts };
  }
}

/** `[0, 1, …, max]`. */
export const upTo = (max: number): number[] => Array.from({ length: max + 1 }, (_, i) => i);
