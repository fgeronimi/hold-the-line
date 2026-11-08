import type { Architecture, ArchNode } from '../engine/types.ts';

/** Opérations d'édition de l'architecture : pures, l'interface ne fait que les appeler. */

export function nextNodeId(arch: Architecture, type: string): string {
  const taken = new Set(arch.nodes.map((n) => n.id));
  if (!taken.has(type)) return type;
  let i = 2;
  while (taken.has(`${type}-${i}`)) i++;
  return `${type}-${i}`;
}

export function addNode(arch: Architecture, type: string): Architecture {
  return { ...arch, nodes: [...arch.nodes, { id: nextNodeId(arch, type), type }] };
}

/** Retirer un nœud retire aussi ses liens, qui n'auraient plus de sens. */
export function removeNode(arch: Architecture, id: string): Architecture {
  return {
    nodes: arch.nodes.filter((n) => n.id !== id),
    links: arch.links.filter((l) => l.from !== id && l.to !== id),
  };
}

export function setUpgrade(arch: Architecture, nodeId: string, upgradeId: string, level: number): Architecture {
  return {
    ...arch,
    nodes: arch.nodes.map((n): ArchNode => {
      if (n.id !== nodeId) return n;
      const upgrades = { ...n.upgrades, [upgradeId]: level };
      if (level === 0) delete upgrades[upgradeId];
      return Object.keys(upgrades).length > 0 ? { ...n, upgrades } : { id: n.id, type: n.type };
    }),
  };
}

/** Relier deux nœuds déjà reliés, ou un nœud à lui-même, ne change rien. */
export function addLink(arch: Architecture, from: string, to: string): Architecture {
  if (from === to || arch.links.some((l) => l.from === from && l.to === to)) return arch;
  return { ...arch, links: [...arch.links, { from, to }] };
}

export function removeLink(arch: Architecture, index: number): Architecture {
  return { ...arch, links: arch.links.filter((_, i) => i !== index) };
}
