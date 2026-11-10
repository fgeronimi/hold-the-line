import type { ArchLink, ArchNode, Architecture } from '../../engine/types.ts';
import { tournament } from './tournament.ts';

/** Architectures types de la billetterie : la réponse attendue de chaque vague, et ses contre-exemples. */

const link = (from: string, to: string): ArchLink => ({ from, to });

export interface BoxOfficeOptions {
  /** Relances espacées sur les clients. */
  backoff?: boolean;
  /** Instances en plus, derrière un load balancer. */
  extraInstances?: number;
  /** Plafond d'autoscaling du serveur. */
  autoscaling?: number;
  cache?: boolean;
  replicas?: number;
  /** Lectures critiques sur le primaire. */
  leaderReads?: boolean;
  /** Le billet part par une file ; sinon le serveur appelle le prestataire en direct. */
  queue?: boolean;
  /** Niveaux de rétention de la file. */
  retention?: number;
}

/** Serveur, base et prestataire d'e-mail, avec les protections demandées. */
export function boxOffice(o: BoxOfficeOptions = {}): Architecture {
  const nodes: ArchNode[] = [
    { id: 'src', type: 'traffic-source', upgrades: { 'client-backoff': o.backoff ? 1 : 0 } },
    { id: 'app', type: 'app-server', upgrades: { 'horizontal-scaling': o.extraInstances ?? 0, autoscaling: o.autoscaling ?? 0 } },
    { id: 'db', type: 'database', upgrades: { 'read-replica': o.replicas ?? 0, 'leader-reads': o.leaderReads ? 1 : 0 } },
    ...(tournament.fixtures ?? []),
  ];
  const links: ArchLink[] = [link('app', 'db')];
  if (o.extraInstances || o.autoscaling) {
    nodes.push({ id: 'lb', type: 'load-balancer' });
    links.unshift(link('src', 'lb'), link('lb', 'app'));
  } else {
    links.unshift(link('src', 'app'));
  }
  if (o.queue ?? true) {
    nodes.push({ id: 'queue', type: 'message-queue', upgrades: { 'queue-retention': o.retention ?? 0 } });
    links.push(link('app', 'queue'), link('queue', 'mail'));
  } else {
    links.push(link('app', 'mail'));
  }
  if (o.cache) {
    nodes.push({ id: 'cache', type: 'cache' });
    links.push(link('app', 'cache'));
  }
  return { nodes, links };
}
