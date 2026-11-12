import type { Flow } from '../flow.ts';
import type { ArchNode, ComponentDef } from '../types.ts';
import type { Now, World } from '../world.ts';
import { processBalancer } from './balancer.ts';
import { processCache } from './cache.ts';
import type { NodeOutcome } from './common.ts';
import { processDatabase } from './database.ts';
import { processEdge } from './edge.ts';
import { processQueue } from './queue.ts';
import { processService } from './service.ts';

export type { NodeOutcome } from './common.ts';

export function processNode(node: ArchNode, def: ComponentDef, incoming: Flow, w: World, now: Now): NodeOutcome {
  switch (def.behavior) {
    case 'source':
      return { passed: incoming, utilization: 0 };
    case 'edge':
      return processEdge(node, def, incoming, w, now);
    case 'balancer':
      return processBalancer(node, def, incoming, w, now);
    case 'service':
      return processService(node, def, incoming, w, now);
    case 'cache':
    case 'pubsub':
      return processCache(node, def, incoming, w, now);
    case 'database':
      return processDatabase(node, def, incoming, w, now);
    case 'queue':
      return processQueue(node, def, incoming, w, now);
  }
}
