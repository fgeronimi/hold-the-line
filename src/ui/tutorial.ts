import type { Architecture, Catalog } from '../engine/types.ts';
import { validateArchitecture } from '../engine/validate.ts';

/** Ce qu'il faut faire maintenant, et quel bouton de la barre d'outils le montre. */
export interface TutorialStep {
  id: 'place-server' | 'link-source' | 'place-database' | 'link-database' | 'fix' | 'launch';
  /** Le chambellan, dans la métaphore. */
  says: string;
  /** La même chose en vrai. */
  real: string;
  /** Bouton à faire clignoter : un outil, ou un composant de la palette. */
  highlight?: { tool: 'link' | 'place' | 'launch'; type?: string };
}

/**
 * Guide de la vague 1, déduit du brouillon : pas de compteur d'étapes à garder, le joueur
 * peut défaire, construire dans le désordre ou passer par la vue tableau, le guide suit.
 */
export function tutorialStep(arch: Architecture, catalog: Catalog): TutorialStep {
  const ofBehavior = (b: string) => arch.nodes.filter((n) => catalog.components[n.type]?.behavior === b);
  const servers = ofBehavior('service');
  const databases = ofBehavior('database');
  const sources = new Set(ofBehavior('source').map((n) => n.id));
  const serverIds = new Set(servers.map((n) => n.id));
  const databaseIds = new Set(databases.map((n) => n.id));

  if (servers.length === 0) {
    return {
      id: 'place-server',
      says: 'Il nous faut des scribes pour répondre aux voyageurs. Posez une Tour des scribes près des hameaux.',
      real: 'Posez un Application server : c’est lui qui exécute le code, ici retrouver l’URL longue derrière un raccourci.',
      highlight: { tool: 'place', type: 'app-server' },
    };
  }
  if (!arch.links.some((l) => sources.has(l.from) && serverIds.has(l.to))) {
    return {
      id: 'link-source',
      says: 'Tracez un chemin des hameaux à la tour, sans quoi personne n’y arrivera.',
      real: 'Reliez les Clients au serveur : outil Relier, cliquer le départ puis l’arrivée. Le sens du lien est celui de la requête.',
      highlight: { tool: 'link' },
    };
  }
  if (databases.length === 0) {
    return {
      id: 'place-database',
      says: 'Les scribes ne savent rien par cœur : il leur faut les Archives royales, où tout est consigné.',
      real: 'Posez une Database : elle stocke les raccourcis créés (écritures) et les retrouve (lectures).',
      highlight: { tool: 'place', type: 'database' },
    };
  }
  if (!arch.links.some((l) => serverIds.has(l.from) && databaseIds.has(l.to))) {
    return {
      id: 'link-database',
      says: 'Reliez la tour aux archives, que les scribes puissent y consulter et y inscrire.',
      real: 'Reliez le serveur à la base : sans ce lien, lectures et écritures n’ont nulle part où aller.',
      highlight: { tool: 'link' },
    };
  }
  const validation = validateArchitecture(arch, catalog);
  if (!validation.ok) {
    return {
      id: 'fix',
      says: 'Quelque chose cloche dans le plan de la cité.',
      real: validation.errors[0] ?? 'Architecture invalide.',
    };
  }
  return {
    id: 'launch',
    says: 'La cité est prête, Sire. Que les voyageurs viennent !',
    real: 'Clients → serveur → base : l’architecture minimale d’un service web. Lancez la vague.',
    highlight: { tool: 'launch' },
  };
}
