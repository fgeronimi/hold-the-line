import { bill, type BillLine } from '../engine/budget.ts';
import { linkFlows, type LinkFlows } from '../engine/routing.ts';
import type { Architecture, Catalog } from '../engine/types.ts';
import { validateArchitecture } from '../engine/validate.ts';

/**
 * Un brouillon analysé : ce que la barre d'outils, la fiche, la vue tableau, le guide, l'aide
 * et le plateau lisent tous du même brouillon au même rendu. Chaque champ n'est calculé
 * qu'à sa première lecture, puis gardé tant que le brouillon et le catalogue sont les
 * mêmes objets : l'état est immuable, un changement en fabrique de nouveaux.
 */
export interface DraftInfo {
  validation: ReturnType<typeof validateArchitecture>;
  /** L'ordre du trafic, ou l'ordre des nœuds si le brouillon est invalide. */
  order: string[];
  /** Ce qui circule sur chaque lien, clé `from→to`. */
  flows: LinkFlows;
  /** La facture par ligne. */
  bill: BillLine[];
  cost: number;
  complexity: number;
}

// Clés faibles : un brouillon ou un catalogue abandonné emporte son analyse.
const memo = new WeakMap<Catalog, WeakMap<Architecture, DraftInfo>>();

export function draftInfo(arch: Architecture, catalog: Catalog): DraftInfo {
  let byArch = memo.get(catalog);
  if (!byArch) memo.set(catalog, (byArch = new WeakMap()));
  let info = byArch.get(arch);
  if (!info) byArch.set(arch, (info = analyze(arch, catalog)));
  return info;
}

function analyze(arch: Architecture, catalog: Catalog): DraftInfo {
  let validation: DraftInfo['validation'] | undefined;
  let flows: LinkFlows | undefined;
  let lines: BillLine[] | undefined;
  let sums: { cost: number; complexity: number } | undefined;
  const totals = () =>
    (sums ??= {
      // Même ordre d'addition que `totals` du moteur : les arrondis restent les mêmes.
      cost: info.bill.reduce((a, l) => a + l.cost, 0),
      complexity: info.bill.reduce((a, l) => a + l.complexity, 0),
    });
  const info: DraftInfo = {
    get validation() {
      return (validation ??= validateArchitecture(arch, catalog));
    },
    get order() {
      const v = info.validation;
      return v.ok ? v.order : arch.nodes.map((n) => n.id);
    },
    get flows() {
      return (flows ??= linkFlows(arch, catalog));
    },
    get bill() {
      return (lines ??= bill(arch, catalog));
    },
    get cost() {
      return totals().cost;
    },
    get complexity() {
      return totals().complexity;
    },
  };
  return info;
}
