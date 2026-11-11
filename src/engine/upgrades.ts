import type { ArchNode, Catalog, UpgradeEffect } from './types.ts';
import { upgradeLevel } from './validate.ts';

type EffectType = UpgradeEffect['type'];
type EffectOf<T extends EffectType> = Extract<UpgradeEffect, { type: T }>;

/**
 * Les évolutions du catalogue qui s'appliquent au type d'un nœud, dans l'ordre du
 * catalogue, avec leur niveau sur ce nœud (0 compris). Résolues une fois par vague :
 * les effets se lisent ensuite par type, sans repasser par le catalogue.
 */
export type NodeUpgrades = readonly { effect: UpgradeEffect; level: number }[];

export function resolveUpgrades(node: ArchNode, catalog: Catalog): NodeUpgrades {
  return Object.values(catalog.upgrades)
    .filter((u) => u.appliesTo === node.type)
    .map((u) => ({ effect: u.effect, level: upgradeLevel(node, u.id) }));
}

/** Toutes les évolutions d'un effet, niveau 0 compris : un palier se lit par son index. */
export function withEffect<T extends EffectType>(ups: NodeUpgrades, type: T): { effect: EffectOf<T>; level: number }[] {
  return ups.filter((u): u is { effect: EffectOf<T>; level: number } => u.effect.type === type);
}

/** La première évolution active de cet effet, s'il y en a une. */
export function activeEffect<T extends EffectType>(ups: NodeUpgrades, type: T): EffectOf<T> | undefined {
  return withEffect(ups, type).find((u) => u.level > 0)?.effect;
}

export function hasEffect(ups: NodeUpgrades, type: EffectType): boolean {
  return activeEffect(ups, type) !== undefined;
}

/** Instances en service : une de base, plus les niveaux achetés, moins celles en panne. */
export function instancesOf(ups: NodeUpgrades, down = 0): number {
  let extra = 0;
  for (const u of withEffect(ups, 'instances')) extra += u.level;
  return Math.max(0, 1 + extra - down);
}
