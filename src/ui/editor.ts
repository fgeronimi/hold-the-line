import type { Architecture, ArchNode, RequestKind } from '../engine/types.ts';

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

/** Un lien déjà présent entre les deux mêmes nœuds reçoit les types en plus. */
export function addLink(arch: Architecture, from: string, to: string, kinds: RequestKind[]): Architecture {
  if (kinds.length === 0 || from === to) return arch;
  const existing = arch.links.find((l) => l.from === from && l.to === to);
  if (existing) {
    const merged = [...new Set([...existing.kinds, ...kinds])];
    return { ...arch, links: arch.links.map((l) => (l === existing ? { ...l, kinds: merged } : l)) };
  }
  return { ...arch, links: [...arch.links, { from, to, kinds }] };
}

export function removeLink(arch: Architecture, index: number): Architecture {
  return { ...arch, links: arch.links.filter((_, i) => i !== index) };
}

/** Retirer le dernier type d'un lien retire le lien. */
export function toggleLinkKind(arch: Architecture, index: number, kind: RequestKind): Architecture {
  const links = arch.links.flatMap((l, i) => {
    if (i !== index) return [l];
    const kinds = l.kinds.includes(kind) ? l.kinds.filter((k) => k !== kind) : [...l.kinds, kind];
    return kinds.length > 0 ? [{ ...l, kinds }] : [];
  });
  return { ...arch, links };
}
