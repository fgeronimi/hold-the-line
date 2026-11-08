import type { SearchSpace } from '../balance/canonical.ts';
import { catalog } from './catalog.ts';

const levels = (id: string) => catalog.upgrades[id]?.maxLevel ?? 0;

export const searchSpace: SearchSpace = {
  maxExtraInstances: levels('horizontal-scaling'),
  maxReplicas: levels('read-replica'),
  rateLimitTiers: levels('rate-limiting'),
  maxExtraWorkers: 2,
  autoscalingLevels: [0, 3, 6],
};
