import { CONCEPT_ACHIEVEMENTS, noHintId } from '../data/achievements.ts';
import type { Architecture, Catalog, IncidentEffect, UpgradeEffect, Wave, WaveResult } from '../engine/types.ts';

/**
 * Les succès d'une vague tenue (décision I20) : chaque concept dont la parade a joué. On ne
 * relance aucune simulation : on lit ce que le moteur a publié (compteurs des ticks, échecs
 * pendant un incident, liens parcourus). Une vague perdue ne débloque rien.
 */
export function earned(result: WaveResult, arch: Architecture, wave: Wave, catalog: Catalog): string[] {
  if (!result.won) return [];
  const ticks = result.ticks;
  const behaviorOf = (id: string) => catalog.components[arch.nodes.find((n) => n.id === id)?.type ?? '']?.behavior;
  const ofBehavior = (b: string) => arch.nodes.filter((n) => catalog.components[n.type]?.behavior === b);
  const nodeSum = (field: 'shed' | 'deduplicated' | 'starting') => ticks.reduce((a, t) => a + Object.values(t.nodes).reduce((b, n) => b + (n[field] ?? 0), 0), 0);
  const readsInto = (id: string) => ticks.reduce((a, t) => a + Object.entries(t.links).filter(([k]) => k.endsWith(`→${id}`)).reduce((b, [, v]) => b + (v.read ?? 0), 0), 0);
  const readsOutOf = (id: string) => ticks.reduce((a, t) => a + Object.entries(t.links).filter(([k]) => k.startsWith(`${id}→`)).reduce((b, [, v]) => b + (v.read ?? 0), 0), 0);
  // Les évolutions se reconnaissent à leur effet, comme dans le moteur, pas à leur identifiant.
  const effects = arch.nodes.flatMap((n) =>
    Object.entries(n.upgrades ?? {})
      .filter(([, level]) => level > 0)
      .flatMap(([id]) => (catalog.upgrades[id] ? [catalog.upgrades[id].effect] : [])),
  );
  const upgraded = (type: UpgradeEffect['type']) => effects.some((e) => e.type === type);
  const limits = effects.filter((e): e is Extract<UpgradeEffect, { type: 'rateLimit' }> => e.type === 'rateLimit');
  const shed = nodeSum('shed');

  // Un incident encaissé : il touchait un bâtiment de la cité, et rien n'a échoué pendant sa fenêtre.
  const held = (type: IncidentEffect['type'], component?: string) =>
    (wave.incidents ?? []).some(
      (i) =>
        i.effect.type === type &&
        (!component || i.component === component) &&
        arch.nodes.some((n) => n.type === i.component) &&
        Math.round(ticks.slice(i.from, i.until).reduce((a, t) => a + t.failed, 0)) === 0,
    );
  // Un incident survenu sur un bâtiment de la cité : avec une parade en place et la vague tenue, elle a joué.
  const during = (type: IncidentEffect['type']) => (wave.incidents ?? []).some((i) => i.effect.type === type && arch.nodes.some((n) => n.type === i.component));
  const typeOf = (id: string) => arch.nodes.find((n) => n.id === id)?.type;
  const last = ticks.at(-1);
  const deadLetters = Object.values(last?.nodes ?? {}).reduce((a, n) => a + (n.deadLetters ?? 0), 0);
  const stillPoisoned = Object.values(last?.nodes ?? {}).some((n) => (n.poisoned ?? 0) > 0);
  const storm = ticks.some((t) => (t.retries ?? 0) > 0.5 * (t.offered - (t.retries ?? 0)));

  const checks: Record<string, () => boolean> = {
    'client-server': () => arch.links.some((l) => typeOf(l.from) === 'app-server' && behaviorOf(l.to) === 'database'),
    'horizontal-scaling': () =>
      ofBehavior('balancer').length > 0 && ofBehavior('service').some((n) => !n.fixed && ticks.some((t) => (t.nodes[n.id]?.instances ?? 1) >= 2)),
    autoscaling: () => nodeSum('starting') > 0,
    redundancy: () => held('instance-down'),
    cache: () => ofBehavior('cache').some((n) => readsInto(n.id) > 0),
    'cold-cache': () => during('cold-cache') && ofBehavior('cache').length > 0,
    cdn: () => ofBehavior('edge').some((n) => readsInto(n.id) - readsOutOf(n.id) > 0),
    'read-replica': () => upgraded('readReplicas'),
    'rate-limiting': () => shed > 0 && limits.some((l) => l.class === undefined),
    'api-quotas': () => shed > 0 && limits.some((l) => l.class !== undefined),
    'queue-worker': () => arch.links.some((l) => behaviorOf(l.from) === 'queue' && behaviorOf(l.to) === 'service'),
    pubsub: () => ofBehavior('pubsub').some((n) => arch.links.filter((l) => l.from === n.id).length >= 2) && (result.delivery?.delivered ?? 0) > 0,
    idempotence: () => nodeSum('deduplicated') > 0,
    outbox: () => held('publish-loss'),
    'dead-letter': () => deadLetters >= 1 && !stillPoisoned,
    'circuit-breaker': () => ticks.some((t) => Object.values(t.nodes).some((n) => (n.open?.length ?? 0) > 0)),
    'deferred-payment': () =>
      arch.links.some((l) => behaviorOf(l.from) === 'queue' && typeOf(l.to) === 'payment-provider') && (wave.incidents ?? []).some((i) => i.component === 'payment-provider'),
    coalescing: () => during('cache-stampede') && upgraded('coalescing'),
    backoff: () => upgraded('backoff') && ticks.some((t) => (t.retries ?? 0) > 0) && !storm,
    'load-shedding': () => result.failuresByReason['load-shed'] > 0,
    partition: () => held('partition'),
    retention: () => held('dependency-down', 'mail-provider'),
  };
  return CONCEPT_ACHIEVEMENTS.filter((a) => checks[a.id]?.()).map((a) => a.id);
}

/** Le succès « sans indice » d'un scénario, gagné en finissant la partie sans en avoir pris un. */
export const noHintEarned = (scenarioId: string, finished: boolean, hinted: boolean | undefined): string[] =>
  finished && !hinted ? [noHintId(scenarioId)] : [];
