import { simulateWave } from './simulate.ts';
import type { Architecture, Catalog, Wave } from './types.ts';

/** Ce qu'on peut retirer d'une architecture en tenant encore la vague : un bâtiment, ou un cran d'évolution. */
export interface Spare {
  node: string;
  /** Absent : le bâtiment entier est en trop. */
  upgrade?: string;
  /** Le niveau qui suffirait, pour une évolution. */
  level?: number;
}

/**
 * Sans ce bâtiment : ses liens tombent. Un simple passage (CDN, load balancer, passerelle) se
 * retire aussi en reliant ses voisins par-dessus : c'est ce que ferait le joueur.
 */
function without(arch: Architecture, id: string, catalog: Catalog): Architecture[] {
  const nodes = arch.nodes.filter((n) => n.id !== id);
  const kept = arch.links.filter((l) => l.from !== id && l.to !== id);
  const behavior = catalog.components[arch.nodes.find((n) => n.id === id)?.type ?? '']?.behavior;
  if (behavior !== 'edge' && behavior !== 'balancer') return [{ nodes, links: kept }];
  const before = arch.links.filter((l) => l.to === id).map((l) => l.from);
  const after = arch.links.filter((l) => l.from === id).map((l) => l.to);
  const bridge = before.flatMap((from) => after.filter((to) => !kept.some((l) => l.from === from && l.to === to)).map((to) => ({ from, to })));
  return [{ nodes, links: kept }, { nodes, links: [...kept, ...bridge] }];
}

/** La vague tient-elle encore, côté service ? Coût et complexité ne peuvent que baisser en retirant. */
function holds(arch: Architecture, wave: Wave, catalog: Catalog): boolean {
  const r = simulateWave(arch, wave, catalog);
  const valid = !r.events.some((e) => e.type === 'invalid') && r.failuresByReason['no-route'] === 0;
  return valid && r.gauges.failureRate.margin >= 0 && r.gauges.latency.margin >= 0 && Object.values(r.latencyByKind ?? {}).every((g) => g.margin >= 0);
}

/**
 * Le superflu d'une architecture pour une vague (étoile « juste ce qu'il faut », E7) : chaque
 * bâtiment qu'on peut démolir, chaque évolution qu'on peut baisser d'un cran, la vague tenant
 * toujours. La source et les services déjà en place ne se retirent pas. Un palier de rate
 * limiting est un réglage, pas une quantité : on n'essaie que de s'en passer.
 */
export function superfluous(arch: Architecture, wave: Wave, catalog: Catalog): Spare[] {
  const spare: Spare[] = [];
  for (const n of arch.nodes) {
    if (catalog.components[n.type]?.behavior === 'source' || n.fixed) continue;
    if (without(arch, n.id, catalog).some((a) => holds(a, wave, catalog))) spare.push({ node: n.id });
  }
  for (const n of arch.nodes) {
    // Un bâtiment en trop l'est avec toutes ses évolutions : inutile de les détailler.
    if (spare.some((s) => s.node === n.id && !s.upgrade)) continue;
    for (const [upgrade, level] of Object.entries(n.upgrades ?? {})) {
      const def = catalog.upgrades[upgrade];
      if (!def || level <= 0) continue;
      const lower = def.effect.type === 'rateLimit' ? 0 : level - 1;
      const { [upgrade]: _, ...rest } = n.upgrades ?? {};
      const upgrades = lower > 0 ? { ...rest, [upgrade]: lower } : rest;
      const lighter = { ...arch, nodes: arch.nodes.map((x) => (x.id === n.id ? { ...x, upgrades } : x)) };
      if (holds(lighter, wave, catalog)) spare.push({ node: n.id, upgrade, level: lower });
    }
  }
  return spare;
}
