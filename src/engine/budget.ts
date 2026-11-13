import type { Architecture, Catalog, UpgradeDef } from './types.ts';

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
    // Un service déjà en place n'est pas à construire : seules ses évolutions se paient.
    if (!node.fixed) lines.push({ node: node.id, item: def.id, cost: def.cost, complexity: def.complexity });
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
