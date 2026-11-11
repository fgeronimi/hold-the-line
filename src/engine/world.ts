import type { Flow } from './flow.ts';
import type { IncidentState } from './incidents.ts';
import type { Ledger } from './ledger.ts';
import type { MessagingRoles } from './route.ts';
import type { RouteTable } from './routing.ts';
import type { ArchNode, Catalog, ComponentDef, TrafficSource } from './types.ts';
import { instancesOf, type NodeUpgrades } from './upgrades.ts';

export interface AutoscaleState {
  instanceCost: number;
  active: number;
  pending: { readyAt: number; count: number }[];
  /** Somme sur les ticks des instances ajoutées en service : base de la facture. */
  instanceTicks: number;
}

/** Ce qui vaut pour toute la vague : le graphe résolu, et les états qui durent d'un tick à l'autre. */
export interface World {
  catalog: Catalog;
  nodes: Map<string, ArchNode>;
  routes: RouteTable;
  upgrades: Map<string, NodeUpgrades>;
  roles: Map<string, MessagingRoles>;
  sourcesById: Map<string, TrafficSource>;
  /** Services qui doivent recevoir chaque événement : ce qui leur parvient compte comme livré. */
  consumers: Set<string>;
  /**
   * Les clients relancent (S19) : un serveur saturé ne rejette plus vite, il fait attendre
   * jusqu'au délai du client, et travaille encore pour des requêtes déjà abandonnées.
   */
  timeouts: boolean;
  backlogs: Map<string, Flow>;
  autoscalers: Map<string, AutoscaleState>;
}

/** L'état d'un tick, construit à chaque tick : ses compteurs, ses incidents, ses circuits ouverts. */
export interface Now {
  ledger: Ledger;
  incidents: IncidentState;
  /** Dépendances coupées par le circuit breaker de chaque serveur. */
  open: Map<string, Set<string>>;
}

export const defOf = (w: World, id: string): ComponentDef => w.catalog.components[w.nodes.get(id)!.type]!;

/** Instances d'un nœud en service à ce tick, incidents déduits. */
export const instancesNow = (w: World, incidents: IncidentState, node: ArchNode): number =>
  instancesOf(w.upgrades.get(node.id)!, incidents.down(node.type));

export const isDown = (w: World, incidents: IncidentState, id: string): boolean => instancesNow(w, incidents, w.nodes.get(id)!) === 0;

/** Latence d'un nœud hors charge, ralentie par un incident en cours. */
export const latencyOf = (w: World, incidents: IncidentState, id: string): number =>
  incidents.latencyMs(w.nodes.get(id)!.type, defOf(w, id).latencyMs);
