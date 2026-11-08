import type { Architecture, ArchNode, Catalog, UpgradeDef } from './types.ts';

export interface BillLine {
  node: string;
  item: string;
  cost: number;
  complexity: number;
}

function upgradeCost(up: UpgradeDef, level: number): number {
  return level > 0 ? up.cost.base + up.cost.perLevel * level : 0;
}

/** Facture de l'architecture : ce qu'elle coûte et ce qu'elle pèse à opérer, par vague. */
export function bill(arch: Architecture, catalog: Catalog): BillLine[] {
  const lines: BillLine[] = [];
  for (const node of arch.nodes) {
    const def = catalog.components[node.type];
    if (!def) continue;
    lines.push({ node: node.id, item: def.id, cost: def.cost, complexity: def.complexity });
    for (const [upgradeId, level] of Object.entries(node.upgrades ?? {})) {
      const up = catalog.upgrades[upgradeId];
      if (!up || level <= 0) continue;
      lines.push({
        node: node.id,
        item: up.id,
        cost: upgradeCost(up, level),
        complexity: up.complexity.base + up.complexity.perLevel * level,
      });
    }
  }
  return lines;
}

export function totals(arch: Architecture, catalog: Catalog): { cost: number; complexity: number } {
  return bill(arch, catalog).reduce(
    (acc, l) => ({ cost: acc.cost + l.cost, complexity: acc.complexity + l.complexity }),
    { cost: 0, complexity: 0 },
  );
}

function upgradeRemovalCost(up: UpgradeDef, from: number, to: number): number {
  if (to >= from) return 0;
  switch (up.removalCost) {
    case 'free':
      return 0;
    case 'per-level':
      return upgradeCost(up, from) - upgradeCost(up, to);
    case 'on-disable':
      return to === 0 ? upgradeCost(up, from) : 0;
  }
}

function nodeRemovalCost(node: ArchNode, catalog: Catalog): number {
  let cost = catalog.components[node.type]?.cost ?? 0;
  for (const [upgradeId, level] of Object.entries(node.upgrades ?? {})) {
    const up = catalog.upgrades[upgradeId];
    if (up) cost += upgradeRemovalCost(up, level, 0);
  }
  return cost;
}

/**
 * Coût unique des retraits entre deux vagues (décision E2). Ajouter ne coûte rien de plus
 * que la facture ; un nœud qui change de type compte comme retiré puis ajouté.
 */
export function migrationCost(previous: Architecture, next: Architecture, catalog: Catalog): number {
  const nextById = new Map(next.nodes.map((n) => [n.id, n]));
  let cost = 0;
  for (const old of previous.nodes) {
    const current = nextById.get(old.id);
    if (!current || current.type !== old.type) {
      cost += nodeRemovalCost(old, catalog);
      continue;
    }
    for (const [upgradeId, level] of Object.entries(old.upgrades ?? {})) {
      const up = catalog.upgrades[upgradeId];
      if (up) cost += upgradeRemovalCost(up, level, current.upgrades?.[upgradeId] ?? 0);
    }
  }
  return cost;
}
