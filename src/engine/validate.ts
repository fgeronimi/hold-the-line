import type { Architecture, ArchNode, Catalog } from './types.ts';

export interface ValidationOk {
  ok: true;
  order: string[];
  sourceId: string;
}
export interface ValidationError {
  ok: false;
  errors: string[];
}

export function upgradeLevel(node: ArchNode, upgradeId: string): number {
  return node.upgrades?.[upgradeId] ?? 0;
}

/** Vérifie que l'architecture est simulable et renvoie un ordre topologique des nœuds. */
export function validateArchitecture(
  arch: Architecture,
  catalog: Catalog,
): ValidationOk | ValidationError {
  const errors: string[] = [];
  const byId = new Map<string, ArchNode>();

  for (const node of arch.nodes) {
    if (byId.has(node.id)) errors.push(`Identifiant de nœud en double : ${node.id}`);
    byId.set(node.id, node);
    if (!catalog.components[node.type]) errors.push(`Type de composant inconnu : ${node.type}`);
  }

  const sources = arch.nodes.filter(
    (n) => catalog.components[n.type]?.behavior === 'source',
  );
  if (sources.length !== 1) {
    errors.push(`Il faut exactement une source de trafic (trouvé : ${sources.length})`);
  }

  for (const link of arch.links) {
    if (!byId.has(link.from)) errors.push(`Lien depuis un nœud inconnu : ${link.from}`);
    if (!byId.has(link.to)) errors.push(`Lien vers un nœud inconnu : ${link.to}`);
    if (link.from === link.to) errors.push(`Lien d'un nœud vers lui-même : ${link.from}`);
    if (link.kinds.length === 0) errors.push(`Lien ${link.from} → ${link.to} sans type de requête`);
    const target = byId.get(link.to);
    const origin = byId.get(link.from);
    const allowed = origin && catalog.components[origin.type]?.allowedDownstream;
    if (allowed && target && !allowed.includes(target.type)) {
      errors.push(`${origin.type} ne peut alimenter que ${allowed.join(', ')} (${link.from} → ${link.to})`);
    }
    if (target && catalog.components[target.type]?.behavior === 'source') {
      errors.push(`Aucun lien ne peut entrer dans la source (${link.from} → ${link.to})`);
    }
  }

  for (const node of arch.nodes) {
    for (const [upgradeId, level] of Object.entries(node.upgrades ?? {})) {
      const up = catalog.upgrades[upgradeId];
      if (!up) {
        errors.push(`Évolution inconnue sur ${node.id} : ${upgradeId}`);
        continue;
      }
      if (up.appliesTo !== node.type) {
        errors.push(`${up.label} ne s'applique pas à ${node.id} (${node.type})`);
      }
      if (!Number.isInteger(level) || level < 0 || level > up.maxLevel) {
        errors.push(`${up.label} sur ${node.id} : niveau ${level} hors de [0, ${up.maxLevel}]`);
      }
      const required = up.requiresUpstream;
      if (level > 0 && required) {
        const parents = arch.links.filter((l) => l.to === node.id).map((l) => byId.get(l.from));
        const allOk = parents.length > 0 && parents.every((p) => p && required.includes(p.type));
        if (!allOk) {
          errors.push(
            `${up.label} sur ${node.id} exige que tout son trafic arrive par : ${required.join(' ou ')}`,
          );
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const order = topologicalOrder(arch);
  if (!order) return { ok: false, errors: ['Le graphe contient un cycle'] };

  return { ok: true, order, sourceId: sources[0]!.id };
}

function topologicalOrder(arch: Architecture): string[] | null {
  const indegree = new Map(arch.nodes.map((n) => [n.id, 0]));
  for (const l of arch.links) indegree.set(l.to, (indegree.get(l.to) ?? 0) + 1);

  // Tri par identifiant pour un ordre stable, indépendant de l'ordre de saisie.
  const ready = [...indegree].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const l of arch.links.filter((x) => x.from === id)) {
      const d = indegree.get(l.to)! - 1;
      indegree.set(l.to, d);
      if (d === 0) {
        ready.push(l.to);
        ready.sort();
      }
    }
  }
  return order.length === arch.nodes.length ? order : null;
}
