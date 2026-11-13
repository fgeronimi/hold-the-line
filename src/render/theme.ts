import type { ArchNode, Catalog, RequestKind } from '../engine/types.ts';

/**
 * Formes low-poly que la scène sait construire. Le thème choisit une forme par composant :
 * les formes sont du code, mais leur attribution, les noms et les couleurs sont des données.
 */
export type Shape = 'hamlet' | 'watchtower' | 'gatehouse' | 'tower' | 'lectern' | 'keep' | 'stables' | 'belfry' | 'counting-house' | 'dovecote' | 'tollhouse';

export interface BuildingStyle {
  /** Nom dans la métaphore ; le nom technique du catalogue est toujours affiché à côté. */
  metaphor: string;
  /** À quoi sert le bâtiment : dans la métaphore (`says`), puis en vrai (`real`). */
  role: { says: string; real: string };
  /** Icône de la barre de construction. */
  icon: string;
  shape: Shape;
  color: string;
  accent: string;
}

export interface VehicleStyle {
  metaphor: string;
  /** Couleur de légende, et de la boîte qui remplace le personnage s'il n'y en a pas. */
  color: string;
  /** Largeur, hauteur, longueur, en unités de la grille. */
  size: [number, number, number];
  /** Personnage animé (`.glb` sous `public/models/`), figé dans une pose de marche. */
  model?: string;
}

export interface Theme {
  id: string;
  title: string;
  /** Teinte d'un bâtiment saturé, et des requêtes en échec. */
  alert: string;
  /** Nom d'une requête en échec qui fait demi-tour. */
  failed: string;
  /** Trafic abusif repoussé par le rate limiting : l'ennemi du tower defense. */
  hostile: { metaphor: string; color: string; model?: string };
  buildings: Record<string, BuildingStyle>;
  vehicles: Record<RequestKind, VehicleStyle>;
  /** Le personnage qui annonce les vagues et analyse les défaites : le recruteur, dans la métaphore. */
  /** Le narrateur : son nom, et son portrait (un personnage du kit, rendu par `npm run captures -- narrateur`). */
  /** `portrait` : le visage des bulles ; `full` : le personnage en pied, animé, de l'accueil. */
  narrator: { name: string; portrait: string; full: string };
  /** Le récit de chaque vague dans la métaphore (clé : id de la vague) ; les chiffres restent affichés à côté. */
  narratives: Record<string, string>;
  /** La règle du temps (décision M7), annoncée au premier briefing de chaque scénario : sa réplique, puis « En vrai ». */
  timeRule: { says: string; real: string };
  /**
   * Le pictogramme de chaque évolution (clé : id du catalogue ; valeur : nom d'un symbole du
   * sprite, `src/ui/sprite.ts`), sur sa pastille, sa carte et l'étiquette du bâtiment (I18).
   */
  upgradeIcons: Record<string, string>;
  /**
   * Les répliques du narrateur pour l'aide (`src/ui/hints.ts`), une par nature d'indice. Elles
   * ne disent rien d'une vague en particulier : `{name}`, `{from}`, `{to}`, `{upgrade}`,
   * `{level}` et `{wave}` y sont remplacés par l'élément désigné, dans la métaphore.
   */
  hints: Record<HintLine, string>;
  /**
   * Les répliques du narrateur au debrief (`src/ui/debrief.ts`) qui ne viennent pas d'une
   * leçon : l'ouverture, ce qui a marché, l'alerte et ce qu'on pourrait alléger. La ligne
   * « En vrai » reste dans le code, comme pour l'aide. `{name}` est le nom d'un bâtiment
   * dans la métaphore ; les autres variables sont décrites à `DebriefLine`.
   */
  debrief: Record<DebriefLine, string>;
  /** L'écran de choix du scénario : la question du narrateur, puis « En vrai ». */
  choose: { says: string; real: string };
  /**
   * Les répliques du narrateur dans le guide (`src/ui/tutorial.ts`) : le pas-à-pas de la vague 1,
   * puis ce qui bloque le lancement. La ligne « En vrai » reste dans le code. `{name}`, `{bill}`,
   * `{budget}`, `{complexity}` et `{wave}` y sont remplacés.
   */
  guide: Record<GuideLine, string>;
  /**
   * L'accueil, au premier lancement (P4) : le chambellan se présente, « En vrai » dit ce qu'est
   * le jeu, puis les étapes d'une vague. Chaque étape nomme un pictogramme du sprite.
   */
  welcome: { title: string; says: string; real: string; steps: { icon: string; title: string; text: string }[]; start: string };
  /**
   * Le bilan d'un scénario tenu jusqu'au bout : le chambellan, « En vrai », puis les intitulés
   * du tableau (`applied` : les notions qu'une vague ajoute aux précédentes). `done` remplace
   * « À revoir » quand il ne reste rien.
   */
  review: { title: string; says: string; real: string; applied: string; alternatives: string; toReview: string; done: string };
  /** Ce qu'affiche le plateau pendant qu'il se charge. */
  loading: string;
  /**
   * Les succès (I20) : la fenêtre (le narrateur, puis « en vrai »), la ligne du debrief qui en
   * annonce un, et le succès « sans indice » d'un scénario (`noHint` : sa métaphore).
   */
  achievements: { says: string; real: string; unlocked: string; noHint: string; noHintReal: string };
}

export type GuideLine =
  | 'placeServer'
  | 'linkSourceServer'
  | 'placeDatabase'
  | 'linkDatabase'
  | 'fix'
  | 'ready'
  | 'linkSource'
  | 'deadEnd'
  | 'feedConsumer'
  | 'overBudget'
  | 'overComplexity'
  | 'launch';

export type HintLine = 'place' | 'placeMore' | 'link' | 'upgrade' | 'level' | 'remove' | 'unlink' | 'lower' | 'ready';

/**
 * - `won` (`{story}` : ce qui a marché, ou `wonQuiet`), `wonQuiet` (`{title}` : la vague), `lost` ;
 * - ce qui a marché : `edge`, `cache` (`{share}` : sur 100 lectures), `instances`, `workers`, `replicas`
 *   (`{count}`), `replica`, `rateLimit`, `classLimits` (des limites par classe de client),
 *   `pubsub` (`{count}` : abonnés), `idempotence`,
 *   `outbox`, `queue`, `queues` (`{count}`) ;
 * - `hot` : le bâtiment le plus chargé d'une vague tenue ;
 * - `superfluous`, `superfluousMany` (`{names}`) : ce dont la vague se passait ;
 * - `superfluousLevel` (`{names}`) : les évolutions dont un cran de moins suffisait ;
 * - `paradeCosts` : ce qu'ont coûté les protections en place, même quand elles ont tenu ;
 * - `sizing` (`{name}`) : le calcul de dimensionnement du serveur le plus chargé ;
 * - `replayHint` : une vague tenue sans ses trois étoiles se rejoue, sans rien perdre.
 */
export type DebriefLine =
  | 'won'
  | 'wonQuiet'
  | 'lost'
  | 'edge'
  | 'cache'
  | 'instances'
  | 'workers'
  | 'replica'
  | 'replicas'
  | 'rateLimit'
  | 'classLimits'
  | 'pubsub'
  | 'idempotence'
  | 'outbox'
  | 'queue'
  | 'queues'
  | 'hot'
  | 'superfluous'
  | 'superfluousMany'
  | 'superfluousLevel'
  | 'paradeCosts'
  | 'sizing'
  | 'replayHint';

/** Nom technique et nom dans la métaphore d'un bâtiment ; un service déjà en place a le sien. */
export function nodeNames(node: ArchNode, catalog: Catalog, theme: Theme): { tech: string; metaphor: string } {
  if (node.fixed) return node.fixed;
  return { tech: catalog.components[node.type]?.techName ?? node.type, metaphor: theme.buildings[node.type]?.metaphor ?? '' };
}
