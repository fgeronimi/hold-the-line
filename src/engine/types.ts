export type RequestKind = 'read' | 'write' | 'async';
export const REQUEST_KINDS: readonly RequestKind[] = ['read', 'write', 'async'];

/** Seules ces requêtes comptent dans la latence du SLA : l'asynchrone n'est pas sur le chemin critique. */
export const SYNC_KINDS: readonly RequestKind[] = ['read', 'write'];

/**
 * Le comportement est la seule chose codée dans le moteur ; tout le reste (capacités,
 * coûts, poids) vient des données. Un nouveau composant qui réutilise un comportement
 * existant ne demande donc aucun changement de code.
 */
export type Behavior = 'source' | 'edge' | 'balancer' | 'service' | 'cache' | 'database' | 'queue';

export interface ComponentDef {
  id: string;
  behavior: Behavior;
  label: string;
  techName: string;
  cost: number;
  complexity: number;
  /** Unités de travail par seconde, pour une instance. */
  capacity: number;
  latencyMs: number;
  /** Travail consommé par requête ; un type absent ne coûte rien à ce nœud. */
  workPerRequest: Partial<Record<RequestKind, number>>;
  /** Types de requêtes dont le traitement s'arrête ici. */
  terminalFor: RequestKind[];
  /** Types de requêtes que ce composant reçoit quand un voisin amont lui est relié. */
  accepts: RequestKind[];
  /**
   * Un type va de préférence au voisin de plus haute priorité qui l'accepte : un cache
   * (lectures) ou une file (async) passent avant la base, qui accepte tout.
   */
  routingPriority?: number;
  /**
   * Composant consulté plutôt que traversé (cache-aside) : il sert une part des requêtes
   * (`hitRate`), le reste repart du nœud qui l'a consulté vers ses autres voisins.
   */
  lookaside?: boolean;
  hitRate?: number;
  /** File : nombre de messages regroupés en un seul envoi vers l'aval. */
  batchSize?: number;
  /** File : messages en attente au-delà desquels les nouveaux sont perdus. */
  maxBacklog?: number;
  /** Types de composants autorisés en aval ; absent = tous. */
  allowedDownstream?: string[];
}

export type UpgradeEffect =
  | { type: 'instances' }
  | { type: 'readReplicas'; capacityPerReplica: number }
  /** Le niveau de l'évolution est l'index du palier, à partir de 1 ; 0 = désactivé. */
  | { type: 'rateLimit'; tiersPerClientRps: number[] }
  /**
   * Le niveau est le nombre maximal d'instances ajoutées à la demande. Une instance
   * demandée ne sert qu'après `startupTicks` ; elle est facturée au prorata des ticks actifs.
   */
  | { type: 'autoscaling'; instanceCost: number; startupTicks: number; targetUtilization: number };

/**
 * Ce que coûte une baisse de niveau (décision E2) :
 * - `free` : rien, comme retirer des instances ;
 * - `per-level` : le prix d'achat de chaque niveau retiré, comme un réplica ;
 * - `on-disable` : changer de niveau est gratuit, revenir à 0 coûte l'achat complet.
 */
export type RemovalCost = 'free' | 'per-level' | 'on-disable';

export interface UpgradeDef {
  id: string;
  label: string;
  techName: string;
  appliesTo: string;
  maxLevel: number;
  /** Coût et complexité totaux = base + perLevel × niveau, dès le niveau 1. */
  cost: { base: number; perLevel: number };
  complexity: { base: number; perLevel: number };
  /** Types de composants dont doit venir tout le trafic du nœud amélioré. */
  requiresUpstream?: string[];
  removalCost: RemovalCost;
  effect: UpgradeEffect;
}

export interface Catalog {
  components: Record<string, ComponentDef>;
  upgrades: Record<string, UpgradeDef>;
}

/** Case d'un plateau hexagonal, en coordonnées axiales. */
export interface BoardCell {
  q: number;
  r: number;
}

export interface ArchNode {
  id: string;
  type: string;
  upgrades?: Record<string, number>;
  /** Case du plateau où le joueur a posé le bâtiment. Ignorée par la simulation. */
  cell?: BoardCell;
}

/** Un lien relie deux composants ; ce qui y circule est déduit par `routeTable`. */
export interface ArchLink {
  from: string;
  to: string;
  /** Cases du chemin tracé sur le plateau, départ et arrivée inclus. Ignoré par la simulation. */
  path?: BoardCell[];
}

export interface Architecture {
  nodes: ArchNode[];
  links: ArchLink[];
}

export interface TrafficSource {
  id: string;
  /** Nombre de clients qui se partagent ce trafic, pour le rate limiting par client. */
  clients: number;
  /** Un client abusif rejeté par le rate limiting ne compte pas comme un échec. */
  abusive?: boolean;
  /**
   * Parcourt la longue traîne (un crawler qui visite tous les liens) : ses lectures ne
   * tombent jamais dans un cache, CDN compris.
   */
  longTail?: boolean;
  rps: Partial<Record<RequestKind, number>>;
}

export interface ProfileSegment {
  /** Tick (exclu) jusqu'auquel le facteur s'applique. */
  until: number;
  factor: number;
}

export interface Wave {
  id: string;
  title: string;
  briefing: string;
  ticks: number;
  profile: ProfileSegment[];
  sources: TrafficSource[];
  sla: { maxFailureRate: number; maxP95LatencyMs: number };
  budget: number;
  complexityCap: number;
  /** Fiche du calendrier Advent of System Design citée au debrief. */
  conceptRef?: string;
  /** Vague à réponse unique assumée (décision B1) : exemptée du critère des deux stratégies. */
  singleStrategy?: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  subtitle: string;
  waves: Wave[];
}

/**
 * `lost-at-edge` : tâche async jamais déclenchée parce que sa requête a été servie en
 * bordure sans atteindre le serveur (un clic non compté sur une redirection en cache CDN).
 */
export type FailureReason = 'saturation' | 'no-route' | 'rate-limited' | 'queue-overflow' | 'lost-at-edge';

export type SimEvent =
  | { type: 'invalid'; message: string }
  | { type: 'saturation-start'; tick: number; node: string; utilization: number }
  | { type: 'saturation-end'; tick: number; node: string }
  | { type: 'no-route'; tick: number; node: string; kind: RequestKind }
  | { type: 'rate-limited'; tick: number; node: string; source: string; rejectedRps: number }
  | { type: 'queue-overflow'; tick: number; node: string; lostRps: number };

export interface NodeTick {
  utilization: number;
  latencyMs: number;
  failed: number;
  backlog?: number;
  /** Instances en service ce tick, pour un nœud qui en a plusieurs. */
  instances?: number;
  /** Trafic abusif écarté ici par le rate limiting ce tick (req/s), hors échecs. */
  shed?: number;
}

export interface TickMetrics {
  tick: number;
  offered: number;
  failed: number;
  avgLatencyMs: number;
  nodes: Record<string, NodeTick>;
  /** Débit envoyé sur chaque lien (clé `from→to`) par type de requête : ce que le rendu anime. */
  links: Record<string, Partial<Record<RequestKind, number>>>;
}

export interface Gauge {
  value: number;
  limit: number;
  /** Marge relative : 0.2 = 20 % sous la limite, négatif = dépassement. */
  margin: number;
}

export interface NodeSummary {
  peakUtilization: number;
  failed: number;
  saturatedTicks: number;
}

export interface WaveResult {
  won: boolean;
  lossReasons: string[];
  /**
   * Facture de la vague : le fixe (composants et évolutions), les instances ajoutées par
   * l'autoscaling au prorata de leur temps de service, et les retraits depuis la vague précédente.
   */
  bill: { fixed: number; autoscaling: number; migration: number };
  avgLatencyMs: number;
  gauges: {
    cost: Gauge;
    complexity: Gauge;
    failureRate: Gauge;
    /** p95 des latences par tick : approximation, le moteur ne suit pas les requêtes une à une. */
    latency: Gauge;
  };
  offered: number;
  failed: number;
  failuresByReason: Record<FailureReason, number>;
  /** Requêtes abusives écartées par le rate limiting : voulu, donc hors échecs. */
  shed: number;
  nodes: Record<string, NodeSummary>;
  ticks: TickMetrics[];
  events: SimEvent[];
}
