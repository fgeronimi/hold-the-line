import { migrationCost, totals } from '../engine/budget.ts';
import type { Architecture, Catalog, Wave } from '../engine/types.ts';
import { validateArchitecture } from '../engine/validate.ts';
import { fortifiedCity as theme } from '../data/themes/fortified-city.ts';
import { nodeNames } from '../render/theme.ts';
import { minuteSpan } from './time.ts';

/** Ce qu'il faut faire maintenant, et quel bouton de la barre d'outils le montre. */
export interface TutorialStep {
  id:
    | 'place-server'
    | 'link-source'
    | 'place-database'
    | 'link-database'
    | 'feed-consumer'
    | 'dead-end'
    | 'fix'
    | 'over-budget'
    | 'over-complexity'
    | 'launch';
  /** Le chambellan, dans la métaphore. */
  says: string;
  /** La même chose en vrai. */
  real: string;
  /**
   * Ce qui clignote : un outil, un composant de la palette, et pour l'aide (`hints.ts`) le
   * bâtiment visé, la pastille d'une de ses évolutions ou le bouton qui retire un lien.
   */
  highlight?: {
    tool?: 'link' | 'place' | 'launch' | 'remove';
    type?: string;
    node?: string;
    upgrade?: string;
    link?: { from: string; to: string };
  };
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

/**
 * Ce qu'il faut faire maintenant, à toutes les vagues : le pas-à-pas à la première, puis
 * le défi de la vague et ce qui bloque le lancement. Ne souffle jamais la parade : c'est
 * au joueur de la trouver, le chambellan l'explique au debrief.
 */
export function guideStep(
  arch: Architecture,
  catalog: Catalog,
  wave: Wave,
  waveIndex: number,
  committed: Architecture,
  /** Le pas-à-pas n'existe que pour la toute première vague du jeu. */
  tutorial = waveIndex === 0,
): TutorialStep {
  if (tutorial) {
    const step = tutorialStep(arch, catalog);
    if (step.id !== 'launch') return step;
  }
  const validation = validateArchitecture(arch, catalog);
  if (!validation.ok) {
    return { id: 'fix', says: 'Quelque chose cloche dans le plan de la cité.', real: validation.errors[0] ?? 'Architecture invalide.' };
  }
  // Le plan est valide mais vide de sens : rien ne sort des hameaux, ou un service attendu n'est alimenté par rien.
  const source = arch.nodes.find((n) => catalog.components[n.type]?.behavior === 'source');
  if (source && !arch.links.some((l) => l.from === source.id)) {
    return {
      id: 'link-source',
      says: 'Personne ne quitte encore les hameaux : aucun chemin n’en part.',
      real: 'Reliez les Clients au premier bâtiment de votre architecture : outil Relier, cliquer le départ puis l’arrivée.',
      highlight: { tool: 'link' },
    };
  }
  // Une impasse : un bâtiment reçoit du travail qu'il ne sait pas finir, et rien n'en part.
  const deadEnd = arch.nodes.find((n) => {
    const def = catalog.components[n.type];
    return (
      def &&
      def.accepts.some((k) => !def.terminalFor.includes(k)) &&
      arch.links.some((l) => l.to === n.id) &&
      !arch.links.some((l) => l.from === n.id)
    );
  });
  if (deadEnd) {
    const { tech, metaphor } = nodeNames(deadEnd, catalog, theme);
    return {
      id: 'dead-end',
      says: `${metaphor} reçoit du travail mais n’a nulle part où le porter : aucun chemin n’en part.`,
      real: `${tech} reçoit des requêtes mais n’a aucun lien sortant : tout ce qu’il ne termine pas lui-même échouera (no-route).`,
      highlight: { tool: 'link' },
    };
  }
  const starved = (wave.consumers ?? []).map((id) => arch.nodes.find((n) => n.id === id)).find((n) => n && !arch.links.some((l) => l.to === n.id));
  if (starved?.fixed) {
    return {
      id: 'feed-consumer',
      says: `Le ${starved.fixed.metaphor.toLowerCase()} attend toujours les commandes : aucun chemin ne mène à lui.`,
      real: `Le ${starved.fixed.tech} doit recevoir chaque événement de commande, et rien ne l’alimente encore.`,
    };
  }
  const { cost, complexity } = totals(arch, catalog);
  const bill = cost + migrationCost(committed, arch, catalog);
  if (bill > wave.budget) {
    return {
      id: 'over-budget',
      says: `Le trésor ne suffira pas, Sire : ${Math.round(bill)} écus pour ${wave.budget}.`,
      real: `La facture prévue dépasse le budget de la vague (${Math.round(bill)} / ${wave.budget}, retraits compris). Retirer un composant ou baisser une évolution.`,
    };
  }
  if (complexity > wave.complexityCap) {
    return {
      id: 'over-complexity',
      says: `Trop de rouages à entretenir : vos gens n’en suivront pas ${complexity}.`,
      real: `La complexité dépasse le plafond de la vague (${complexity} / ${wave.complexityCap}). Chaque composant et chaque évolution en ajoute.`,
    };
  }
  const incidents = (wave.incidents ?? []).map((i) => ` Incident annoncé : ${i.title.toLowerCase()} (${minuteSpan(i.from, i.until)}).`).join('');
  if (tutorial) return { ...tutorialStep(arch, catalog), real: `${tutorialStep(arch, catalog).real}${incidents}` };
  return {
    id: 'launch',
    says: `${wave.title} : la cité tiendra-t-elle ? Quand vous serez prêt, lancez la vague.`,
    real: `${wave.briefing}${incidents}`,
    highlight: { tool: 'launch' },
  };
}
