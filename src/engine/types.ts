export type RequestKind = 'read' | 'write' | 'async';
export const REQUEST_KINDS: readonly RequestKind[] = ['read', 'write', 'async'];

/** Seules ces requêtes comptent dans la latence du SLA : l'asynchrone n'est pas sur le chemin critique. */
export const SYNC_KINDS: readonly RequestKind[] = ['read', 'write'];

/**
 * Le comportement est la seule chose codée dans le moteur ; tout le reste (capacités,
 * coûts, poids) vient des données. Un nouveau composant qui réutilise un comportement
 * existant ne demande donc aucun changement de code.
 */
export type Behavior = 'source' | 'edge' | 'balancer' | 'service' | 'cache' | 'database' | 'queue' | 'pubsub';

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
  /** Pourquoi les autres sont refusés, dit au joueur qui tente le lien (« une file se vide par un worker »). */
  downstreamRule?: string;
  /** Jamais proposé à la construction : seul un scénario le pose (les services métier, S10). */
  prePlaced?: boolean;
  /**
   * Serveur : requêtes traitées en même temps par instance (ses fils d'exécution). Un appel
   * direct à une dépendance garde un fil occupé le temps de la réponse (loi de Little) : une
   * dépendance lente les épuise, et le serveur sature pour tout le monde (décision S14).
   */
  threads?: number;
  /**
   * Diffusion (pub/sub) : chaque message est copié vers chacun des voisins qui l'acceptent,
   * au lieu d'être partagé entre eux comme le fait une file.
   */
  fanOut?: boolean;
  /**
   * Prestataire externe : messages acceptés par seconde au plus, quel que soit leur
   * regroupement (son quota). Une file qui le consomme ne se vide pas plus vite (S20).
   */
  maxRps?: number;
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
  | { type: 'autoscaling'; instanceCost: number; startupTicks: number; targetUtilization: number }
  /** Consommateur qui reconnaît un message déjà traité, avec sa propre mémoire des clés (S10). */
  | { type: 'idempotence' }
  /** Événement écrit dans la transaction de la commande, puis relayé : une écriture de plus. */
  | { type: 'outbox' }
  /**
   * Serveur : au-delà de `timeoutMs`, ou si elle est en panne, une dépendance appelée en
   * direct est coupée ; ses appels échouent tout de suite au lieu de bloquer des fils.
   */
  | { type: 'circuitBreaker'; timeoutMs: number }
  /** Cache : une seule requête recalcule une entrée expirée, les autres l'attendent. */
  | { type: 'coalescing' }
  /**
   * Clients : relances espacées (backoff exponentiel, jitter), étalées sur `spreadTicks`
   * ticks ; sans elles, tous les échecs reviennent ensemble au tick suivant (décision S19).
   */
  | { type: 'backoff'; spreadTicks: number }
  /** File : `perLevel` messages de plus avant de déborder, par niveau. */
  | { type: 'retention'; perLevel: number }
  /** Base : les lectures qui doivent être à jour vont au primaire, jamais aux réplicas (S21). */
  | { type: 'leaderReads' };

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
  /**
   * Service déjà en place, fourni par le scénario (décision S8) : il n'est pas facturé et
   * ne se démolit pas ; ses évolutions, elles, se paient. Son nom remplace celui du composant.
   */
  fixed?: { tech: string; metaphor: string };
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
  /**
   * Appelle une API dont les réponses ne se mettent pas en cache en bordure (les partenaires,
   * SC1) : un CDN les laisse passer, le cache applicatif, lui, les sert.
   */
  noEdgeCache?: boolean;
  /**
   * Relances par requête échouée (décision S19) : chaque échec synchrone revient au tick
   * suivant, jusqu'à ce nombre de fois en plus du trafic neuf. Absent : pas de relance.
   */
  retries?: number;
  /**
   * Lit des données qui doivent être à jour (les places restantes) : ses lectures ne
   * tombent jamais dans un cache, et un réplica coupé du primaire les sert périmées (S21).
   */
  consistent?: boolean;
  rps: Partial<Record<RequestKind, number>>;
}

export interface ProfileSegment {
  /** Tick (exclu) jusqu'auquel le facteur s'applique. */
  until: number;
  factor: number;
}

/**
 * Panne annoncée au briefing, qui frappe tous les composants d'un type pendant
 * `[from, until)` (décision X5) :
 * - `instance-down` : `count` instances hors service ; à zéro, le composant ne sert plus rien ;
 * - `cold-cache` : le taux de succès retombe à 0 à `from` et remonte linéairement jusqu'à `until` ;
 * - `duplicate-delivery`, `publish-loss` : voir les effets (décisions S5, S6).
 */
export type IncidentEffect =
  | { type: 'instance-down'; count: number }
  | { type: 'cold-cache' }
  /** Une part `share` des messages qui sortent du composant est livrée deux fois. */
  | { type: 'duplicate-delivery'; share: number }
  /** Le serveur tombe entre l'écriture en base et la publication : une part `share` des événements est perdue. */
  | { type: 'publish-loss'; share: number }
  /** Une dépendance externe ne répond plus du tout : toutes ses instances sont hors service. */
  | { type: 'dependency-down' }
  /** La dépendance répond en `latencyMs` au lieu de sa latence habituelle. */
  | { type: 'slow-dependency'; latencyMs: number }
  /**
   * Tout le cache expire d'un coup : le taux de succès retombe à 0 puis remonte comme un
   * cache froid, et chaque absence est recalculée `herd` fois en base, faute de verrou.
   */
  | { type: 'cache-stampede'; herd: number }
  /** Les réplicas de la base sont coupés du primaire : ils servent des données périmées (S21). */
  | { type: 'partition' };

export interface Incident {
  id: string;
  title: string;
  component: string;
  from: number;
  until: number;
  effect: IncidentEffect;
}

export interface Wave {
  id: string;
  title: string;
  briefing: string;
  ticks: number;
  profile: ProfileSegment[];
  /**
   * Montée et descente du trafic, en ticks (décision S11) : le profil est multiplié par une
   * enveloppe qui part de 25 %, atteint 100 % après `up` ticks, et retombe à 40 % sur les
   * `down` derniers. Absent : le profil seul, à plein dès le premier tick.
   */
  ramp?: { up: number; down: number };
  sources: TrafficSource[];
  sla: { maxFailureRate: number; maxP95LatencyMs: number };
  budget: number;
  complexityCap: number;
  /** Fiche du calendrier Advent of System Design citée au debrief. */
  conceptRef?: string;
  /** Vague à réponse unique assumée (décision B1) : exemptée du critère des deux stratégies. */
  singleStrategy?: boolean;
  incidents?: Incident[];
  /**
   * Services (ids des bâtiments du scénario) qui doivent chacun recevoir chaque événement
   * async (décisions S4, S8). Ce qui ne leur parvient pas compte en échec « non livré ».
   * Absent : aucun contrôle de livraison.
   */
  consumers?: string[];
  /**
   * Troisième étoile : facture au plus égale à ce seuil, calé sur la stratégie gagnante la
   * moins chère (décision E7). Absent : le budget.
   */
  thriftyCost?: number;
  /**
   * Les réponses attendues de la vague, une par stratégie gagnante non dominée : chacune est
   * un choix dans l'espace d'équilibrage du scénario (id de dimension → niveau, 0 = absent,
   * le format de `Choice` dans `src/balance/`). La simulation les ignore : elles servent aux
   * tests de verrouillage et à l'aide, qui les passent par le `build` de l'espace.
   */
  answers?: Record<string, number>[];
}

export interface Scenario {
  id: string;
  title: string;
  subtitle: string;
  waves: Wave[];
  /** Bâtiments déjà sur le plateau au début de la partie, en plus de la source. */
  fixtures?: ArchNode[];
}

/**
 * `lost-at-edge` : tâche async jamais déclenchée parce que sa requête a été servie en
 * bordure sans atteindre le serveur (un clic non compté sur une redirection en cache CDN).
 */
export type FailureReason =
  | 'saturation'
  | 'no-route'
  | 'rate-limited'
  | 'queue-overflow'
  | 'lost-at-edge'
  /** Message traité deux fois par un consommateur sans idempotence. */
  | 'duplicate'
  /** Événement perdu entre l'écriture en base et la publication. */
  | 'lost-event'
  /** Copie d'événement qu'un service attendait et n'a jamais reçue. */
  | 'undelivered'
  /** Appel coupé par un circuit breaker ouvert : échec rapide, sans bloquer le serveur. */
  | 'circuit-open'
  /** Lecture d'une donnée à jour servie périmée par un réplica coupé du primaire. */
  | 'stale-read';

export type SimEvent =
  | { type: 'invalid'; message: string }
  | { type: 'saturation-start'; tick: number; node: string; utilization: number }
  | { type: 'saturation-end'; tick: number; node: string }
  | { type: 'no-route'; tick: number; node: string; kind: RequestKind }
  | { type: 'rate-limited'; tick: number; node: string; source: string; rejectedRps: number }
  | { type: 'queue-overflow'; tick: number; node: string; lostRps: number }
  | { type: 'incident-start'; tick: number; incident: string }
  | { type: 'incident-end'; tick: number; incident: string }
  /** Un serveur sature parce que ses fils attendent une dépendance lente : la cascade. */
  | { type: 'threads-exhausted'; tick: number; node: string; dependency: string };

export interface NodeTick {
  /** Requêtes reçues ce tick (req/s), tous types confondus : émises, pour la source. */
  rps: number;
  utilization: number;
  latencyMs: number;
  failed: number;
  backlog?: number;
  /** Instances en service ce tick, pour un nœud qui en a plusieurs. */
  instances?: number;
  /** Instances demandées par l'autoscaling, encore en démarrage ce tick (le chantier). */
  starting?: number;
  /** Trafic abusif écarté ici par le rate limiting ce tick (req/s), hors échecs. */
  shed?: number;
  /** Instances mises hors service par un incident ce tick. */
  down?: number;
  /** Doublons traités une seconde fois ici (req/s) : déjà comptés dans `failed`. */
  duplicates?: number;
  /** Doublons reconnus et écartés ici grâce à l'idempotence (req/s). */
  deduplicated?: number;
  /** Événements perdus ici entre l'écriture et la publication (req/s) : déjà dans `failed`. */
  lost?: number;
  /** Serveur : part de ses fils d'exécution occupés (1 = tous) ; au-delà, la cascade. */
  threads?: number;
  /** Serveur à court de fils : la dépendance qu'ils attendent tous. */
  waitingOn?: string;
  /** Serveur : dépendances coupées par son circuit breaker ce tick. */
  open?: string[];
  /** Base : lectures servies périmées par des réplicas coupés (req/s) : déjà dans `failed`. */
  stale?: number;
  /**
   * Messages sortis d'une file que ce nœud n'a pas pu traiter ce tick (req/s) : rendus à leur
   * file, non acquittés, ni servis ni en échec (M1).
   */
  deferred?: number;
  /** File : messages rendus par l'aval ce tick (req/s), déjà comptés dans `backlog`. */
  requeued?: number;
  /** Base : ses réplicas sont coupés du primaire ce tick (partition, S21). */
  partitioned?: boolean;
}

export interface TickMetrics {
  tick: number;
  offered: number;
  failed: number;
  /** Latence moyenne d'une requête, pondérée par le débit de chaque type. */
  avgLatencyMs: number;
  /**
   * Ce que le SLA mesure à ce tick (décision S17) : la moyenne, sauf si l'événement de
   * commande, traité en direct, attend plus longtemps. Noyé dans les lectures, un client
   * qui attend 200 ms sa commande passerait sinon le SLA.
   */
  slaLatencyMs: number;
  nodes: Record<string, NodeTick>;
  /** Débit envoyé sur chaque lien (clé `from→to`) par type de requête : ce que le rendu anime. */
  links: Record<string, Partial<Record<RequestKind, number>>>;
  /** Incidents en cours ce tick (ids). */
  incidents?: string[];
  /** Relances des clients injectées ce tick (req/s), déjà comptées dans `offered`. */
  retries?: number;
  /**
   * Requêtes comptées dans le taux d'échec, cumulées depuis le début de la vague : offertes,
   * moins le trafic abusif écarté et les relances injectées (S19). Une relance compte à la
   * place de l'échec qu'elle rejoue. Cumulé et non par tick : une relance réussie rendrait
   * négatif le bilan de son tick.
   */
  countedSoFar: number;
  /**
   * Échecs vus du client, cumulés : les échecs, moins les relances injectées. Le verdict,
   * lui, déduit les relances au tick où il les planifie : en fin de vague,
   * `clientFailedSoFar / countedSoFar` donne son taux d'échec (une relance qui tomberait
   * après la fin n'est jamais planifiée) ; en cours de vague, le cumul suit le client.
   */
  clientFailedSoFar: number;
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

/** Pourquoi une vague est perdue, avec les nombres qui le disent ; la phrase vient de `messages.ts`. */
export type LossReason =
  | { kind: 'invalid'; message: string }
  /** Facture au-delà du budget ; `autoscaling` et `migration` sont déjà dans `cost`. */
  | { kind: 'budget'; cost: number; limit: number; autoscaling: number; migration: number }
  | { kind: 'complexity'; value: number; limit: number }
  | { kind: 'failure-rate'; value: number; limit: number }
  /** p95 des latences par tick : toujours à présenter comme une approximation. */
  | { kind: 'latency'; p95Ms: number; limitMs: number };

export interface WaveResult {
  won: boolean;
  /** Les raisons de `losses`, mises en phrases. */
  lossReasons: string[];
  losses: LossReason[];
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
  /** Quand une vague nomme les services à livrer (`consumers`) : copies attendues et reçues. */
  delivery?: { expected: number; delivered: number };
  nodes: Record<string, NodeSummary>;
  ticks: TickMetrics[];
  events: SimEvent[];
  /**
   * Tick où la latence scelle la défaite : passé lui, le p95 final dépasse forcément sa
   * limite. Absent si la vague tient sa latence.
   */
  latencyBreachTick?: number;
}
