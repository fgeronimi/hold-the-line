import { describe, expect, it } from 'vitest';
import { simulateWave } from '../src/engine/simulate.ts';
import type { ArchLink, ArchNode, Architecture, Catalog, ComponentDef, Incident, IncidentEffect, TrafficSource, Wave } from '../src/engine/types.ts';

// Mécanismes S4 à S21 sur un catalogue propre, aux chiffres ronds : un recalibrage du jeu
// ne doit jamais casser ces tests, et un bug de mécanique ne doit pas s'y cacher derrière
// le calibrage. Ne pas brancher sur src/data/catalog.ts.
//
// Repères de calcul : un serveur `app` sert 100 unités par seconde en 10 ms et a 10 fils ;
// la base sert 100 unités en 10 ms (lecture 1, écriture 2, async 2) ; la latence chargée
// vaut base / (1 − charge), plafonnée à 20 × base au-delà de 95 %.
const svc: Pick<ComponentDef, 'behavior' | 'terminalFor' | 'accepts' | 'routingPriority' | 'workPerRequest'> = {
  behavior: 'service',
  terminalFor: ['async'],
  accepts: ['async'],
  routingPriority: 1,
  workPerRequest: { async: 1 },
};
const catalog: Catalog = {
  components: {
    src: { id: 'src', behavior: 'source', label: 'S', techName: 'S', cost: 0, complexity: 0, capacity: 1, latencyMs: 0, workPerRequest: {}, terminalFor: [], accepts: [] },
    lb: { id: 'lb', behavior: 'balancer', label: 'LB', techName: 'LB', cost: 10, complexity: 1, capacity: 10000, latencyMs: 0, workPerRequest: { read: 1, write: 1, async: 1 }, terminalFor: [], accepts: ['read', 'write', 'async'] },
    edge: { id: 'edge', behavior: 'edge', label: 'CDN', techName: 'CDN', cost: 30, complexity: 2, capacity: 10000, latencyMs: 0, workPerRequest: { read: 1 }, terminalFor: [], accepts: ['read', 'write', 'async'], hitRate: 0.5 },
    app: { id: 'app', behavior: 'service', label: 'App', techName: 'App', cost: 20, complexity: 1, capacity: 100, latencyMs: 10, workPerRequest: { read: 1, write: 1, async: 1 }, terminalFor: [], accepts: ['read', 'write', 'async'], threads: 10 },
    db: { id: 'db', behavior: 'database', label: 'DB', techName: 'DB', cost: 50, complexity: 2, capacity: 100, latencyMs: 10, workPerRequest: { read: 1, write: 2, async: 2 }, terminalFor: ['read', 'write', 'async'], accepts: ['read', 'write', 'async'] },
    cache: { id: 'cache', behavior: 'cache', label: 'Cache', techName: 'Cache', cost: 5, complexity: 2, capacity: 10000, latencyMs: 0, workPerRequest: { read: 1 }, terminalFor: ['read'], accepts: ['read'], lookaside: true, allowedDownstream: [], hitRate: 0.8 },
    queue: { id: 'queue', behavior: 'queue', label: 'Q', techName: 'Q', cost: 25, complexity: 2, capacity: 10000, latencyMs: 0, workPerRequest: { async: 1 }, terminalFor: [], accepts: ['async'], routingPriority: 2, batchSize: 1, maxBacklog: 100 },
    bq: { id: 'bq', behavior: 'queue', label: 'BQ', techName: 'BQ', cost: 25, complexity: 2, capacity: 10000, latencyMs: 0, workPerRequest: { async: 1 }, terminalFor: [], accepts: ['async'], routingPriority: 2, batchSize: 10 },
    bus: { id: 'bus', behavior: 'pubsub', label: 'Bus', techName: 'Bus', cost: 30, complexity: 2, capacity: 10000, latencyMs: 0, workPerRequest: { async: 1 }, terminalFor: [], accepts: ['async'], routingPriority: 2, fanOut: true },
    // Dépendance externe appelée en direct (le banquier) : 40 ms d'habitude.
    provider: { ...svc, id: 'provider', label: 'P', techName: 'P', cost: 0, complexity: 0, capacity: 1000, latencyMs: 40, prePlaced: true },
    // Prestataire à quota : 20 messages par seconde, quel que soit leur regroupement.
    mail: { ...svc, id: 'mail', label: 'M', techName: 'M', cost: 0, complexity: 0, capacity: 1000, latencyMs: 10, maxRps: 20, prePlaced: true },
    // Service métier qui termine l'événement lui-même (S10), lent : 100 ms.
    svc: { ...svc, id: 'svc', label: 'Svc', techName: 'Svc', cost: 40, complexity: 1, capacity: 1000, latencyMs: 100, prePlaced: true },
  },
  upgrades: {
    scale: { id: 'scale', label: 'Scale', techName: 'Scale', appliesTo: 'app', maxLevel: 5, cost: { base: 0, perLevel: 20 }, complexity: { base: 1, perLevel: 0 }, removalCost: 'free', effect: { type: 'instances' } },
    auto: { id: 'auto', label: 'Auto', techName: 'Auto', appliesTo: 'app', maxLevel: 5, cost: { base: 5, perLevel: 0 }, complexity: { base: 2, perLevel: 0 }, requiresUpstream: ['lb'], removalCost: 'on-disable', effect: { type: 'autoscaling', instanceCost: 30, startupTicks: 2, targetUtilization: 0.5 } },
    replica: { id: 'replica', label: 'Replica', techName: 'Replica', appliesTo: 'db', maxLevel: 3, cost: { base: 0, perLevel: 30 }, complexity: { base: 0, perLevel: 1 }, removalCost: 'per-level', effect: { type: 'readReplicas', capacityPerReplica: 100 } },
    breaker: { id: 'breaker', label: 'Breaker', techName: 'Breaker', appliesTo: 'app', maxLevel: 1, cost: { base: 10, perLevel: 0 }, complexity: { base: 2, perLevel: 0 }, removalCost: 'on-disable', effect: { type: 'circuitBreaker', timeoutMs: 100 } },
    coalescing: { id: 'coalescing', label: 'Lock', techName: 'Lock', appliesTo: 'cache', maxLevel: 1, cost: { base: 5, perLevel: 0 }, complexity: { base: 1, perLevel: 0 }, removalCost: 'on-disable', effect: { type: 'coalescing' } },
    backoff: { id: 'backoff', label: 'Backoff', techName: 'Backoff', appliesTo: 'src', maxLevel: 1, cost: { base: 5, perLevel: 0 }, complexity: { base: 1, perLevel: 0 }, removalCost: 'on-disable', effect: { type: 'backoff', spreadTicks: 4 } },
    retention: { id: 'retention', label: 'Retention', techName: 'Retention', appliesTo: 'queue', maxLevel: 3, cost: { base: 0, perLevel: 5 }, complexity: { base: 0, perLevel: 1 }, removalCost: 'per-level', effect: { type: 'retention', perLevel: 50 } },
    leader: { id: 'leader', label: 'Leader', techName: 'Leader', appliesTo: 'db', maxLevel: 1, cost: { base: 5, perLevel: 0 }, complexity: { base: 1, perLevel: 0 }, removalCost: 'on-disable', effect: { type: 'leaderReads' } },
    idem: { id: 'idem', label: 'Idem', techName: 'Idem', appliesTo: 'svc', maxLevel: 1, cost: { base: 5, perLevel: 0 }, complexity: { base: 1, perLevel: 0 }, removalCost: 'on-disable', effect: { type: 'idempotence' } },
    outbox: { id: 'outbox', label: 'Outbox', techName: 'Outbox', appliesTo: 'db', maxLevel: 1, cost: { base: 10, perLevel: 0 }, complexity: { base: 1, perLevel: 0 }, removalCost: 'on-disable', effect: { type: 'outbox' } },
  },
};

const l = (from: string, to: string): ArchLink => ({ from, to });
const n = (id: string, type: string, upgrades?: Record<string, number>): ArchNode => ({ id, type, ...(upgrades ? { upgrades } : {}) });
const arch = (nodes: ArchNode[], links: [string, string][]): Architecture => ({ nodes, links: links.map(([a, b]) => l(a, b)) });

function wave(sources: TrafficSource[], overrides: Partial<Wave> = {}): Wave {
  return {
    id: 'w',
    title: 'w',
    briefing: '',
    ticks: 10,
    profile: [{ until: 10, factor: 1 }],
    sources,
    sla: { maxFailureRate: 0.01, maxP95LatencyMs: 1000 },
    budget: 1000,
    complexityCap: 100,
    ...overrides,
  };
}

const users = (rps: TrafficSource['rps'], extra: Partial<TrafficSource> = {}): TrafficSource => ({ id: 'users', clients: 100, rps, ...extra });
const incident = (component: string, from: number, until: number, effect: IncidentEffect): Incident => ({ id: `${effect.type}-${component}`, title: '', component, from, until, effect });
/** Latence chargée, comme le moteur : base / (1 − charge), charge plafonnée à 95 %. */
const lat = (base: number, u: number) => base / (1 - Math.min(u, 0.95));

// Serveur qui lit en base et appelle la dépendance en direct pour l'async.
const direct = (app: Record<string, number> = {}) =>
  arch([n('s', 'src'), n('a', 'app', app), n('d', 'db'), n('p', 'provider')], [['s', 'a'], ['a', 'd'], ['a', 'p']]);
const slow = incident('provider', 2, 5, { type: 'slow-dependency', latencyMs: 770 });
const closed = incident('provider', 2, 5, { type: 'dependency-down' });
const half = users({ read: 25, async: 25 });

describe('fils d’exécution (S14)', () => {
  it('compte les fils par la loi de Little, attente de l’aval comprise', () => {
    // Lectures : 25 × (10 + 10 ms de base) = 0,5 fil ; async : 25 × (10 + 40 ms) = 1,25 fil.
    // 1,75 fil occupé sur 10 : 0,175, sous la charge processeur (0,5).
    const r = simulateWave(direct(), wave([half]), catalog);
    expect(r.ticks[0]!.nodes.a!.threads).toBeCloseTo(0.175, 9);
    expect(r.ticks[0]!.nodes.a!.utilization).toBe(0.5);
  });

  it('une dépendance lente épuise les fils : le serveur sature pour toutes les requêtes', () => {
    // À 770 ms, l'async garde 25 × 780 / 1000 = 19,5 fils, plus 0,5 pour les lectures :
    // 20 fils demandés pour 10, charge 2. Le serveur ne sert que la moitié, lectures comprises.
    const r = simulateWave(direct(), wave([half], { incidents: [slow] }), catalog);
    const t = r.ticks[2]!.nodes.a!;
    expect(t.threads).toBeCloseTo(2, 9);
    expect(t.utilization).toBeCloseTo(2, 9);
    expect(t.waitingOn).toBe('p');
    expect(t.failed).toBeCloseTo(25, 9);
    expect(r.ticks[2]!.links['a→d']!.read).toBeCloseTo(12.5, 9);
    expect(r.failuresByReason.saturation).toBeCloseTo(25 * 3, 9);
    // Une seule alerte par vague, même si la panne dure trois ticks.
    expect(r.events.filter((e) => e.type === 'threads-exhausted')).toEqual([
      { type: 'threads-exhausted', tick: 2, node: 'a', dependency: 'p' },
    ]);
    expect(r.ticks[5]!.nodes.a!.threads).toBeCloseTo(0.175, 9);
    expect(r.ticks[5]!.nodes.a!.waitingOn).toBeUndefined();
  });

  it('un lot sorti d’une file n’occupe qu’un fil (M6)', () => {
    // 400 messages en lots de 10 : 40 envois × (10 + 10 ms) = 0,8 fil, soit 0,08 sur 10.
    // Comptés un par un, ce serait 8 fils, 0,8.
    const a = arch([n('s', 'src'), n('q', 'bq'), n('w', 'app'), n('d', 'db')], [['s', 'q'], ['q', 'w'], ['w', 'd']]);
    const r = simulateWave(a, wave([users({ async: 400 })]), catalog);
    expect(r.ticks[0]!.nodes.w!.threads).toBeCloseTo(0.08, 9);
    expect(r.ticks[0]!.nodes.w!.utilization).toBeCloseTo(0.4, 9);
    expect(r.failed).toBe(0);
  });

  it('derrière une file, la latence de l’aval ne retient aucun fil', () => {
    // Le serveur n'attend que la file (0 ms) : 0,5 + 25 × 10 / 1000 = 0,75 fil. C'est le
    // worker, qui appelle le banquier en direct, qui s'épuise.
    const a = arch(
      [n('s', 'src'), n('a', 'app'), n('d', 'db'), n('q', 'queue'), n('w', 'app'), n('p', 'provider')],
      [['s', 'a'], ['a', 'd'], ['a', 'q'], ['q', 'w'], ['w', 'p']],
    );
    const r = simulateWave(a, wave([half], { incidents: [slow] }), catalog);
    expect(r.ticks[2]!.nodes.a!.threads).toBeCloseTo(0.075, 9);
    expect(r.ticks[2]!.nodes.a!.failed).toBe(0);
    expect(r.ticks[2]!.nodes.w!.waitingOn).toBe('p');
    expect(r.events.filter((e) => e.type === 'threads-exhausted').map((e) => e.type === 'threads-exhausted' && e.node)).toEqual(['w']);
    // Ce que ses fils ne peuvent pas prendre reste en file au lieu d'échouer (M1).
    expect(r.ticks[2]!.nodes.w!.failed).toBe(0);
    expect(r.ticks[2]!.nodes.q!.backlog).toBeGreaterThan(0);
    expect(r.failed).toBe(0);
  });

  it('fige : une dépendance en panne appelée en direct ne retient aucun fil, et répond en 20 × sa base', () => {
    // À changer par M5 (docs/revue-et-plan.md) : la panne doit retenir les fils jusqu'au délai
    // du client, comme une lenteur ; le serveur sature (threads > 1, waitingOn 'p',
    // threads-exhausted), et la latence de p n'est plus l'artefact de 800 ms (B5).
    const r = simulateWave(direct(), wave([half], { incidents: [closed] }), catalog);
    const t = r.ticks[3]!;
    expect(t.nodes.a!.threads).toBeCloseTo(0.075, 9);
    expect(t.nodes.a!.waitingOn).toBeUndefined();
    expect(r.events.some((e) => e.type === 'threads-exhausted')).toBe(false);
    // p n'a plus d'instance : tout ce qu'il reçoit échoue, à la charge d'affichage de 10.
    expect(t.nodes.p!.down).toBe(1);
    expect(t.nodes.p!.failed).toBe(25);
    expect(t.nodes.p!.latencyMs).toBeCloseTo(40 * 20, 9);
    // L'événement direct compte entier (S17) : 20 ms du serveur + 800 ms artefact.
    expect(t.slaLatencyMs).toBeCloseTo(lat(10, 0.5) + 800, 9);
    expect(r.failuresByReason.saturation).toBe(25 * 3);
  });
});

describe('circuit breaker (S15)', () => {
  it('coupe une dépendance plus lente que son délai : échec rapide, aucun fil retenu', () => {
    // 770 ms > 100 ms : les 25 appels async échouent tout de suite, les fils restent à
    // 0,5 + 25 × 10 / 1000 = 0,75 sur 10. Rien d'autre n'échoue.
    const r = simulateWave(direct({ breaker: 1 }), wave([half], { incidents: [slow] }), catalog);
    const t = r.ticks[3]!;
    expect(t.nodes.a!.open).toEqual(['p']);
    expect(t.nodes.a!.threads).toBeCloseTo(0.075, 9);
    expect(t.nodes.a!.failed).toBe(25);
    expect(r.failuresByReason['circuit-open']).toBe(25 * 3);
    expect(r.failuresByReason.saturation).toBe(0);
    expect(r.ticks[1]!.nodes.a!.open).toBeUndefined();
    expect(r.ticks[5]!.nodes.a!.open).toBeUndefined();
  });

  it('un appel coupé ne compte pas la latence de l’aval', () => {
    // Lecture : 20 (serveur à 50 %) + 13,3 (base à 25 %) ; async coupé : 20, sans p.
    const r = simulateWave(direct({ breaker: 1 }), wave([half], { incidents: [slow] }), catalog);
    const a = lat(10, 0.5);
    const d = lat(10, 0.25);
    expect(r.ticks[3]!.avgLatencyMs).toBeCloseTo((25 * (a + d) + 25 * a) / 50, 9);
    expect(r.ticks[3]!.slaLatencyMs).toBeCloseTo((25 * (a + d) + 25 * a) / 50, 9);
  });

  it('s’ouvre aussi sur une dépendance en panne, avec autant d’échecs qu’un appel direct', () => {
    const r = simulateWave(direct({ breaker: 1 }), wave([half], { incidents: [closed] }), catalog);
    expect(r.ticks[3]!.nodes.a!.open).toEqual(['p']);
    expect(r.failuresByReason['circuit-open']).toBe(25 * 3);
    expect(r.failuresByReason.saturation).toBe(0);
    // Sans disjoncteur, les mêmes 75 échecs, en saturation chez p (voir 3.6).
    const without = simulateWave(direct(), wave([half], { incidents: [closed] }), catalog);
    expect(without.failed).toBe(r.failed);
  });

  it('ne s’ouvre pas sous son délai', () => {
    const r = simulateWave(direct({ breaker: 1 }), wave([half]), catalog);
    expect(r.ticks.every((t) => t.nodes.a!.open === undefined)).toBe(true);
    expect(r.failed).toBe(0);
  });
});

describe('incidents de cache et d’instances', () => {
  const cached = (cache: Record<string, number> = {}) =>
    arch([n('s', 'src'), n('a', 'app'), n('c', 'cache', cache), n('d', 'db')], [['s', 'a'], ['a', 'c'], ['a', 'd']]);
  const dbLoad = (r: ReturnType<typeof simulateWave>) => r.ticks.slice(0, 7).map((t) => t.nodes.d!.utilization);

  it('cache froid : le taux de succès repart de 0 et remonte linéairement', () => {
    // 20 lectures, 80 % de succès en temps normal : 4 absences. De 2 à 6, le taux vaut
    // 0, 20, 40 puis 60 % : 20, 16, 12, 8 absences.
    const r = simulateWave(cached(), wave([users({ read: 20 })], { incidents: [incident('cache', 2, 6, { type: 'cold-cache' })] }), catalog);
    expect(dbLoad(r).map((u) => +u.toFixed(9))).toEqual([0.04, 0.04, 0.2, 0.16, 0.12, 0.08, 0.04]);
    expect(r.failed).toBe(0);
  });

  it('ruée : le cache se vide comme à froid, et chaque absence coûte `herd` fois en base', () => {
    const stampede = incident('cache', 2, 6, { type: 'cache-stampede', herd: 3 });
    const r = simulateWave(cached(), wave([users({ read: 20 })], { incidents: [stampede] }), catalog);
    expect(dbLoad(r).map((u) => +u.toFixed(9))).toEqual([0.04, 0.04, 0.6, 0.48, 0.36, 0.24, 0.04]);
    expect(r.ticks[2]!.links['a→c']).toBeUndefined();
  });

  it('ruée : une base débordée ne fait pas échouer plus de requêtes qu’il n’en arrive', () => {
    // 50 absences × 3 = 150 unités pour 100 : un tiers des 50 lectures échoue, pas 100.
    const stampede = incident('cache', 2, 3, { type: 'cache-stampede', herd: 3 });
    const r = simulateWave(cached(), wave([users({ read: 50 })], { incidents: [stampede] }), catalog);
    expect(r.ticks[2]!.nodes.d!.utilization).toBeCloseTo(1.5, 9);
    expect(r.ticks[2]!.failed).toBeCloseTo(50 / 3, 9);
  });

  it('le verrou de recalcul ramène la ruée à un cache froid', () => {
    const stampede = incident('cache', 2, 6, { type: 'cache-stampede', herd: 3 });
    const r = simulateWave(cached({ coalescing: 1 }), wave([users({ read: 20 })], { incidents: [stampede] }), catalog);
    expect(dbLoad(r).map((u) => +u.toFixed(9))).toEqual([0.04, 0.04, 0.2, 0.16, 0.12, 0.08, 0.04]);
  });

  describe('instance-down', () => {
    const scaled = arch([n('s', 'src'), n('lb', 'lb'), n('a', 'app', { scale: 1 }), n('d', 'db', { replica: 1 })], [['s', 'lb'], ['lb', 'a'], ['a', 'd']]);

    it('retire des instances : la capacité baisse d’autant', () => {
      // 2 instances, une tombe : 100 de capacité pour 150 lectures, 50 échecs par tick.
      const r = simulateWave(scaled, wave([users({ read: 150 })], { incidents: [incident('app', 2, 4, { type: 'instance-down', count: 1 })] }), catalog);
      expect(r.ticks[2]!.nodes.a!).toMatchObject({ instances: 1, down: 1 });
      expect(r.ticks[2]!.nodes.a!.failed).toBeCloseTo(50, 9);
      expect(r.ticks[4]!.nodes.a!).toMatchObject({ instances: 2, failed: 0 });
      expect(r.ticks[4]!.nodes.a!.down).toBeUndefined();
      expect(r.failuresByReason.saturation).toBeCloseTo(100, 9);
      expect(r.events).toContainEqual({ type: 'incident-start', tick: 2, incident: 'instance-down-app' });
      expect(r.events).toContainEqual({ type: 'incident-end', tick: 4, incident: 'instance-down-app' });
    });

    it('fige : à zéro instance, tout échoue et la latence affichée vaut 20 × la base', () => {
      // À changer par M5 (docs/revue-et-plan.md, B5) : un serveur arrêté ne « répond » pas en
      // 200 ms ; la latence d'un nœud sans instance doit cesser d'être cet artefact.
      const r = simulateWave(scaled, wave([users({ read: 150 })], { incidents: [incident('app', 2, 3, { type: 'instance-down', count: 5 })] }), catalog);
      expect(r.ticks[2]!.nodes.a!).toMatchObject({ instances: 0, down: 2, failed: 150 });
      expect(r.ticks[2]!.nodes.a!.latencyMs).toBeCloseTo(200, 9);
    });

    const auto = (upgrades: Record<string, number>) =>
      arch([n('s', 'src'), n('lb', 'lb'), n('a', 'app', upgrades), n('d', 'db')], [['s', 'lb'], ['lb', 'a'], ['a', 'd']]);

    it('une panne de tout le type éteint aussi les instances d’autoscaling, neuves comprises (M2, B1)', () => {
      // 80 lectures à 50 % de charge cible : une instance demandée au tick 0, en service au 2.
      // La panne (ticks 4 et 5) éteint l'instance fixe puis l'instance ajoutée : les 80 lectures
      // échouent. L'autoscaler, qui calcule contre une base à 0, en demande une de plus au
      // tick 4 ; prête au tick 6, après la panne, elle sert, puis est rendue au tick 7.
      const r = simulateWave(auto({ auto: 3 }), wave([users({ read: 80 })], { incidents: [incident('app', 4, 6, { type: 'instance-down', count: 5 })] }), catalog);
      expect(r.ticks.map((t) => t.nodes.a!.instances)).toEqual([1, 1, 2, 2, 0, 0, 3, 2, 2, 2]);
      expect(r.ticks[4]!.nodes.a!.down).toBe(2);
      expect(r.ticks[4]!.failed).toBe(80);
      expect(r.failed).toBe(160);
    });

    it('une instance lancée pendant une panne de tout le type ne sert qu’après elle (M2)', () => {
      // Panne des ticks 2 à 6 : l'instance demandée au tick 0 est prête au tick 2, en pleine
      // panne, et ne sert pas ; celle demandée au tick 2 (prête au 4) non plus.
      const r = simulateWave(auto({ auto: 3 }), wave([users({ read: 80 })], { incidents: [incident('app', 2, 6, { type: 'instance-down', count: 5 })] }), catalog);
      expect(r.ticks.slice(2, 6).map((t) => t.nodes.a!.instances)).toEqual([0, 0, 0, 0]);
      expect(r.ticks[6]!.nodes.a!.instances).toBeGreaterThan(1);
      expect(r.ticks.slice(2, 6).every((t) => t.failed === 80)).toBe(true);
    });

    it('une panne partielle retire d’abord des instances fixes, puis à la demande (M2)', () => {
      // 2 instances fixes et une à la demande (180 lectures, 50 % de cible : 4 voulues, plafond 1).
      // Deux tombent : les deux fixes ; l'instance à la demande sert seule.
      const r = simulateWave(auto({ scale: 1, auto: 1 }), wave([users({ read: 180 })], { incidents: [incident('app', 4, 6, { type: 'instance-down', count: 2 })] }), catalog);
      expect(r.ticks[3]!.nodes.a!.instances).toBe(3);
      expect(r.ticks[4]!.nodes.a!).toMatchObject({ instances: 1, down: 2 });
      const three = simulateWave(auto({ scale: 1, auto: 1 }), wave([users({ read: 180 })], { incidents: [incident('app', 4, 6, { type: 'instance-down', count: 3 })] }), catalog);
      expect(three.ticks[4]!.nodes.a!).toMatchObject({ instances: 0, down: 3 });
    });
  });
});

describe('relances des clients (S19)', () => {
  const appToDb = (src: Record<string, number> = {}) => arch([n('s', 'src', src), n('a', 'app'), n('d', 'db')], [['s', 'a'], ['a', 'd']]);
  const outage = (from: number, until: number) => incident('app', from, until, { type: 'instance-down', count: 1 });
  const retrying = (rps: TrafficSource['rps'], retries = 3) => users(rps, { retries });

  it('un échec synchrone revient au tick suivant, et sort du taux d’échec', () => {
    // Tick 2 : le serveur est arrêté, 50 lectures échouent ; elles reviennent au tick 3, où
    // 100 lectures tiennent tout juste dans 100 de capacité. Le client ne voit aucun échec.
    const r = simulateWave(appToDb(), wave([retrying({ read: 50 })], { incidents: [outage(2, 3)] }), catalog);
    expect(r.ticks[3]!.retries).toBe(50);
    expect(r.ticks[3]!.offered).toBe(100);
    expect(r.ticks[4]!.retries).toBeUndefined();
    expect(r.failuresByReason.saturation).toBe(50);
    expect(r.failed).toBe(0);
    expect(r.offered).toBe(550);
    expect(r.gauges.failureRate.value).toBe(0);
  });

  it('sans relance, le même échec reste', () => {
    const r = simulateWave(appToDb(), wave([users({ read: 50 })], { incidents: [outage(2, 3)] }), catalog);
    expect(r.ticks[3]!.retries).toBeUndefined();
    expect(r.failed).toBe(50);
  });

  it('plafonne les relances à `retries` × le trafic neuf du tick', () => {
    // Panne aux ticks 2 et 3, une relance par requête. Tick 3 : 50 neuves + 50 relances
    // échouent, mais seules 50 (1 × 50 neuves) reviennent au tick 4. Le client voit les 50
    // relancées une fois de trop.
    const once = simulateWave(appToDb(), wave([retrying({ read: 50 }, 1)], { incidents: [outage(2, 4)] }), catalog);
    expect(once.ticks.map((t) => t.retries ?? 0)).toEqual([0, 0, 0, 50, 50, 0, 0, 0, 0, 0]);
    expect(once.failed).toBe(50);
    // Avec trois relances, les 100 reviennent.
    const thrice = simulateWave(appToDb(), wave([retrying({ read: 50 })], { incidents: [outage(2, 4)] }), catalog);
    expect(thrice.ticks[4]!.retries).toBe(100);
  });

  it('effondrement : un nœud saturé ne sert que capacité / charge de ce qu’il pourrait, seulement si des clients relancent', () => {
    // 150 lectures pour 100 : sans relance, 100 servies et 50 échecs. Avec, la charge vaut
    // 150² / 100 = 225, il sert 100 / 225 × 150 = 66,7 lectures : 83,3 échecs.
    const plain = simulateWave(appToDb(), wave([users({ read: 150 })]), catalog);
    expect(plain.ticks[0]!.failed).toBeCloseTo(50, 9);
    const storm = simulateWave(appToDb(), wave([retrying({ read: 150 })]), catalog);
    expect(storm.ticks[0]!.failed).toBeCloseTo(250 / 3, 9);
    expect(storm.ticks[0]!.links['a→d']!.read).toBeCloseTo(200 / 3, 9);
  });

  it('le backoff étale les relances sur `spreadTicks` ticks', () => {
    const r = simulateWave(appToDb({ backoff: 1 }), wave([retrying({ read: 50 })], { incidents: [outage(2, 3)] }), catalog);
    expect(r.ticks.map((t) => t.retries ?? 0)).toEqual([0, 0, 0, 12.5, 12.5, 12.5, 12.5, 0, 0, 0]);
    expect(r.failed).toBe(0);
  });

  it('une relance prévue après la fin de la vague n’a pas lieu : son échec reste', () => {
    const last = simulateWave(appToDb(), wave([retrying({ read: 50 })], { incidents: [outage(9, 10)] }), catalog);
    expect(last.failed).toBe(50);
    // Avec le backoff, panne au tick 7 : 12,5 relances aux ticks 8 et 9, les 25 autres perdues.
    const spread = simulateWave(appToDb({ backoff: 1 }), wave([retrying({ read: 50 })], { incidents: [outage(7, 8)] }), catalog);
    expect(spread.ticks.map((t) => t.retries ?? 0).slice(7)).toEqual([0, 12.5, 12.5]);
    expect(spread.failed).toBe(25);
  });

  it('une écriture relancée réémet son événement async (M10, B2)', () => {
    // 20 écritures et leurs 20 événements échouent au tick 2 ; les deux reviennent au tick 3 :
    // 20 + 20 écritures, 20 + 20 événements. Rien n'est perdu.
    const r = simulateWave(direct(), wave([retrying({ write: 20, async: 20 })], { incidents: [outage(2, 3)] }), catalog);
    expect(r.ticks[3]!.retries).toBe(40);
    expect(r.ticks[3]!.offered).toBe(80);
    expect(r.ticks[3]!.links['a→p']!.async).toBe(40);
    expect(r.failuresByReason.saturation).toBe(40);
    expect(r.failed).toBe(0);
  });

  it('un événement qui échoue seul, sa requête servie, n’est pas relancé (M10)', () => {
    // Le prestataire ferme aux ticks 2 et 3 : les écritures passent, seuls les événements
    // échouent. Le client a eu sa réponse : il ne relance rien.
    const r = simulateWave(direct(), wave([retrying({ write: 20, async: 20 })], { incidents: [closed] }), catalog);
    expect(r.ticks.every((t) => (t.retries ?? 0) === 0)).toBe(true);
    expect(r.failed).toBe(60);
  });

  it('chaque source ne relance que ses propres échecs (M10, B3)', () => {
    // Partenaires sans relance et clients à 3 relances, 20 lectures chacun : 40 échecs au
    // tick 2. Les clients relancent leurs 20 ; les 20 des partenaires restent.
    const partners: TrafficSource = { id: 'partners', clients: 10, rps: { read: 20 } };
    const r = simulateWave(appToDb(), wave([partners, retrying({ read: 20 })], { incidents: [outage(2, 3)] }), catalog);
    expect(r.ticks[3]!.retries).toBe(20);
    expect(r.failed).toBe(20);
  });

  it('une relance refait la requête du même type : une lecture perdue revient en lecture (M10)', () => {
    // La base, seule à saturer, ne fait échouer que des lectures : la relance n'apporte
    // aucune écriture, quelle que soit la répartition de la source.
    const wide = arch([n('s', 'src'), n('a', 'app', { scale: 2 }), n('d', 'db')], [['s', 'a'], ['a', 'd']]);
    const r = simulateWave(wide, wave([retrying({ read: 150, write: 10 })], { ticks: 2, profile: [{ until: 2, factor: 1 }] }), catalog);
    expect(r.ticks[0]!.nodes.a!.failed).toBe(0);
    expect(r.ticks[0]!.nodes.d!.failed).toBeGreaterThan(0);
    expect(r.ticks[1]!.retries).toBeCloseTo(r.ticks[0]!.failed, 9);
    expect(r.ticks[1]!.links['a→d']!.write).toBeCloseTo(10, 9);
  });

  it('un doublon traité deux fois n’est pas relancé : ce n’est pas une requête du client (M10, B10)', () => {
    const a = arch(
      [n('s', 'src'), n('a', 'app'), n('d', 'db'), n('q', 'queue'), n('s1', 'svc')],
      [['s', 'a'], ['a', 'd'], ['a', 'q'], ['q', 's1']],
    );
    const dup = incident('queue', 0, 10, { type: 'duplicate-delivery', share: 0.5 });
    const r = simulateWave(a, wave([retrying({ read: 10, async: 20 })], { incidents: [dup] }), catalog);
    expect(r.ticks.every((t) => (t.retries ?? 0) === 0)).toBe(true);
    expect(r.failuresByReason.duplicate).toBe(100);
    expect(r.failed).toBe(100);
  });

  it('une copie non livrée n’est pas relancée (M10, B10)', () => {
    // Une file partagée entre deux services attendus : chacun n'a que la moitié des
    // événements, l'autre moitié est « non livrée ». Le client, servi, ne relance rien.
    const a = arch(
      [n('s', 'src'), n('a', 'app'), n('d', 'db'), n('q', 'queue'), n('s1', 'svc'), n('s2', 'svc')],
      [['s', 'a'], ['a', 'd'], ['a', 'q'], ['q', 's1'], ['q', 's2']],
    );
    const r = simulateWave(a, wave([retrying({ read: 10, async: 20 })], { consumers: ['s1', 's2'] }), catalog);
    expect(r.failuresByReason.undelivered).toBeGreaterThan(0);
    expect(r.ticks.every((t) => (t.retries ?? 0) === 0)).toBe(true);
  });

  describe('effondrement, seulement pour la part du trafic qui relance (M10, B12)', () => {
    // Les lectures des clients vont au serveur ; l'async des partenaires, sans relance, au
    // prestataire directement (1 000 de capacité).
    const split = arch([n('s', 'src'), n('a', 'app'), n('d', 'db'), n('p', 'provider')], [['s', 'a'], ['s', 'p'], ['a', 'd']]);
    const partners = (async: number): TrafficSource => ({ id: 'partners', clients: 10, rps: { async } });

    it('un nœud qui ne voit aucun client qui relance rejette vite son excédent', () => {
      // 1 500 pour 1 000 : 500 échecs, pas l'effondrement (833) des clients qui relancent.
      const r = simulateWave(split, wave([retrying({ read: 10 }), partners(1500)]), catalog);
      expect(r.ticks[0]!.nodes.p!.failed).toBeCloseTo(500, 9);
    });

    it('seule la part du travail venue de clients qui relancent s’effondre', () => {
      // Moitié relance, moitié pas : charge 1 500 + 0,5 × (1 500² / 1 000 − 1 500) = 1 875 ;
      // le prestataire sert 1 000 / 1 875 de ce qu'il reçoit, 700 échecs.
      const r = simulateWave(split, wave([retrying({ read: 10, async: 750 }), partners(750)]), catalog);
      expect(r.ticks[0]!.nodes.p!.failed).toBeCloseTo(700, 9);
    });
  });
});

describe('file bornée et quota (S20)', () => {
  const sink = (q: Record<string, number> = {}) => arch([n('s', 'src'), n('q', 'queue', q)], [['s', 'q']]);

  it('déborde au-delà de `maxBacklog` : échec queue-overflow', () => {
    // 30 messages par tick, aucun consommateur, 100 places : 120 au tick 3, 20 perdus, puis 30.
    const r = simulateWave(sink(), wave([users({ async: 30 })]), catalog);
    expect(r.ticks.map((t) => t.nodes.q!.backlog)).toEqual([30, 60, 90, 100, 100, 100, 100, 100, 100, 100]);
    expect(r.failuresByReason['queue-overflow']).toBe(300 - 100);
    expect(r.events).toContainEqual({ type: 'queue-overflow', tick: 3, node: 'q', lostRps: 20 });
  });

  it('la rétention ajoute `perLevel` messages par niveau', () => {
    const r = simulateWave(sink({ retention: 2 }), wave([users({ async: 30 })]), catalog);
    expect(r.ticks.map((t) => t.nodes.q!.backlog)).toEqual([30, 60, 90, 120, 150, 180, 200, 200, 200, 200]);
    expect(r.failuresByReason['queue-overflow']).toBe(300 - 200);
  });

  it('un quota compte des messages : appelé en direct, le prestataire rejette l’excédent', () => {
    // 30 messages pour un quota de 20 : charge 1,5, un tiers échoue, bien que 30 unités de
    // travail tiennent dans 1 000.
    const a = arch([n('s', 'src'), n('a', 'app'), n('m', 'mail')], [['s', 'a'], ['a', 'm']]);
    const r = simulateWave(a, wave([users({ async: 30 })]), catalog);
    expect(r.ticks[0]!.nodes.m!.utilization).toBeCloseTo(1.5, 9);
    expect(r.ticks[0]!.nodes.m!.failed).toBeCloseTo(10, 9);
  });

  it('les lots n’échappent pas au quota, qui fixe le rythme de vidage de la file', () => {
    // Lots de 10 : 20 messages ne coûtent que 2 unités, mais remplissent le quota (charge 1).
    // La file ne se vide qu'à 20 par seconde : 50 entrent, l'arriéré monte de 30 par tick.
    const a = arch([n('s', 'src'), n('q', 'bq'), n('m', 'mail')], [['s', 'q'], ['q', 'm']]);
    const r = simulateWave(a, wave([users({ async: 50 })]), catalog);
    expect(r.ticks[0]!.nodes.m!.rps).toBeCloseTo(20, 9);
    expect(r.ticks[0]!.nodes.m!.utilization).toBeCloseTo(1, 9);
    expect(r.ticks.map((t) => t.nodes.q!.backlog).slice(0, 4)).toEqual([30, 60, 90, 120]);
    expect(r.failed).toBe(0);
  });

  it('la file impose le rythme de l’aval : ce que la base refuse retourne dans la file (M1)', () => {
    // 20 messages par tick ; le worker tombe aux ticks 2 à 4, l'arriéré monte à 60. Au tick 5,
    // la file relâche les 80 en attente, le worker les prend, mais la base n'en écrit que 50
    // (100 unités, 2 par message) : les 30 autres ne sont pas acquittés et restent en file.
    // Au tick 6, 30 + 20 tiennent : l'arriéré est vidé, sans un seul échec.
    const a = arch([n('s', 'src'), n('q', 'queue'), n('w', 'app'), n('d', 'db')], [['s', 'q'], ['q', 'w'], ['w', 'd']]);
    const r = simulateWave(a, wave([users({ async: 20 })], { incidents: [incident('app', 2, 5, { type: 'instance-down', count: 1 })] }), catalog);
    expect(r.ticks.map((t) => t.nodes.q!.backlog ?? 0).slice(0, 7)).toEqual([0, 0, 20, 40, 60, 30, 0]);
    expect(r.ticks[5]!.links['q→w']!.async).toBe(80);
    expect(r.ticks[5]!.nodes.d!).toMatchObject({ deferred: 30, failed: 0, utilization: 1 });
    expect(r.ticks[5]!.nodes.q!.requeued).toBe(30);
    expect(r.failed).toBe(0);
  });

  it('un message rendu compte dans l’arriéré : la file déborde si l’aval ne suit pas (M1)', () => {
    // La base n'écrit que 50 messages par seconde (2 unités chacun) pour 80 qui arrivent :
    // 30 de plus en file à chaque tick, jusqu'aux 100 places, puis le surplus déborde.
    const a = arch([n('s', 'src'), n('q', 'queue'), n('w', 'app', { scale: 1 }), n('d', 'db')], [['s', 'q'], ['q', 'w'], ['w', 'd']]);
    const r = simulateWave(a, wave([users({ async: 80 })]), catalog);
    expect(r.ticks.map((t) => +t.nodes.q!.backlog!.toFixed(9)).slice(0, 5)).toEqual([30, 60, 90, 100, 100]);
    expect(r.failuresByReason.saturation).toBe(0);
    expect(r.failuresByReason['queue-overflow']).toBeCloseTo(30 * 10 - 100, 9);
  });

  it('le trafic direct passe avant les messages de file, qui prennent la capacité qu’il laisse (M1)', () => {
    // 40 écritures directes (80 unités) et 30 messages de file (60 unités) pour 100 : les
    // écritures passent toutes, 10 messages sont écrits, 20 retournent en file. Personne n'échoue.
    const a = arch(
      [n('s', 'src'), n('a', 'app', { scale: 1 }), n('q', 'queue'), n('w', 'app'), n('d', 'db')],
      [['s', 'a'], ['a', 'd'], ['a', 'q'], ['q', 'w'], ['w', 'd']],
    );
    const r = simulateWave(a, wave([users({ write: 40, async: 30 })], { ticks: 1, profile: [{ until: 1, factor: 1 }] }), catalog);
    const d = r.ticks[0]!.nodes.d!;
    expect(d.failed).toBe(0);
    expect(d.deferred).toBeCloseTo(20, 9);
    expect(d.utilization).toBeCloseTo(1, 9);
    expect(r.ticks[0]!.nodes.q!.backlog).toBeCloseTo(20, 9);
  });

  it('un message de file ne fait pas s’effondrer un nœud quand les clients relancent (S19, M1)', () => {
    // Mêmes chiffres, clients qui relancent : la base n'est pas saturée par le trafic direct,
    // donc pas d'effondrement ; les messages prennent toujours le reste.
    const a = arch(
      [n('s', 'src'), n('a', 'app', { scale: 1 }), n('q', 'queue'), n('w', 'app'), n('d', 'db')],
      [['s', 'a'], ['a', 'd'], ['a', 'q'], ['q', 'w'], ['w', 'd']],
    );
    const r = simulateWave(a, wave([users({ write: 40, async: 30 }, { retries: 3 })], { ticks: 1, profile: [{ until: 1, factor: 1 }] }), catalog);
    expect(r.failed).toBe(0);
    expect(r.ticks[0]!.nodes.d!.deferred).toBeCloseTo(20, 9);
  });
});

describe('pub/sub et livraison (S4, S8)', () => {
  const fan = (via: 'bus' | 'queue', subscribers = ['s1', 's2']) =>
    arch(
      [n('s', 'src'), n('a', 'app'), n('x', via), ...subscribers.map((id) => n(id, 'svc'))],
      [['s', 'a'], ['a', 'x'], ...subscribers.map((id): [string, string] => ['x', id])],
    );

  it('un pub/sub copie chaque message à chaque abonné', () => {
    const r = simulateWave(fan('bus'), wave([users({ async: 30 })], { consumers: ['s1', 's2'] }), catalog);
    expect(r.ticks[0]!.links['x→s1']).toEqual({ async: 30 });
    expect(r.ticks[0]!.links['x→s2']).toEqual({ async: 30 });
    expect(r.delivery).toEqual({ expected: 600, delivered: 600 });
    expect(r.failuresByReason.undelivered).toBe(0);
  });

  it('une file partage : chaque service n’en reçoit que sa part, le reste est non livré', () => {
    const r = simulateWave(fan('queue'), wave([users({ async: 30 })], { consumers: ['s1', 's2'] }), catalog);
    expect(r.ticks[0]!.links['x→s1']).toEqual({ async: 15 });
    expect(r.delivery).toEqual({ expected: 600, delivered: 300 });
    expect(r.failuresByReason.undelivered).toBe(300);
  });

  it('sans `consumers`, aucun contrôle de livraison', () => {
    const r = simulateWave(fan('queue'), wave([users({ async: 30 })]), catalog);
    expect(r.delivery).toBeUndefined();
    expect(r.failed).toBe(0);
  });

  it('fige : les copies non livrées se comptent contre des événements offerts, le taux d’échec dépasse 100 %', () => {
    // Trois services, une file partagée : 900 copies attendues, 300 livrées, 600 « non
    // livrées » rapportées à 300 événements offerts.
    // À trancher (hors docs/revue-et-plan.md, à voir avec A1 et M4) : rapporter les copies
    // à des copies attendues, ou compter un événement non livré une seule fois.
    const r = simulateWave(fan('queue', ['s1', 's2', 's3']), wave([users({ async: 30 })], { consumers: ['s1', 's2', 's3'] }), catalog);
    expect(r.failuresByReason.undelivered).toBe(600);
    expect(r.gauges.failureRate.value).toBe(2);
  });
});

describe('doublons et idempotence (S5)', () => {
  const consumer = (idem: boolean) =>
    arch([n('s', 'src'), n('a', 'app'), n('q', 'queue'), n('s1', 'svc', idem ? { idem: 1 } : undefined)], [['s', 'a'], ['a', 'q'], ['q', 's1']]);
  const dup = incident('queue', 0, 10, { type: 'duplicate-delivery', share: 0.5 });

  it('sans idempotence, un message livré deux fois est un échec « doublon »', () => {
    // La file livre ses 20 messages, plus 10 copies : 10 doublons par tick.
    const r = simulateWave(consumer(false), wave([users({ async: 20 })], { incidents: [dup] }), catalog);
    expect(r.ticks[0]!.nodes.s1!.duplicates).toBe(10);
    expect(r.ticks[0]!.nodes.s1!.deduplicated).toBeUndefined();
    expect(r.failuresByReason.duplicate).toBe(100);
  });

  it('avec, il est reconnu et écarté sans échec', () => {
    const r = simulateWave(consumer(true), wave([users({ async: 20 })], { incidents: [dup] }), catalog);
    expect(r.ticks[0]!.nodes.s1!.deduplicated).toBe(10);
    expect(r.ticks[0]!.nodes.s1!.duplicates).toBeUndefined();
    expect(r.failed).toBe(0);
  });

  it('un doublon ne compte jamais comme livré', () => {
    const r = simulateWave(consumer(true), wave([users({ async: 20 })], { incidents: [dup], consumers: ['s1'] }), catalog);
    expect(r.delivery).toEqual({ expected: 200, delivered: 200 });
  });
});

describe('perte à la publication et outbox (S6)', () => {
  const publisher = (outbox: boolean) =>
    arch(
      [n('s', 'src'), n('a', 'app'), n('d', 'db', outbox ? { outbox: 1 } : undefined), n('q', 'queue'), n('s1', 'svc')],
      [['s', 'a'], ['a', 'd'], ['a', 'q'], ['q', 's1']],
    );
  const loss = incident('app', 0, 10, { type: 'publish-loss', share: 0.25 });
  const orders = users({ write: 20, async: 20 });

  it('sans outbox, une part des événements publiés est perdue', () => {
    const r = simulateWave(publisher(false), wave([orders], { incidents: [loss] }), catalog);
    expect(r.ticks[0]!.nodes.a!.lost).toBe(5);
    expect(r.ticks[0]!.links['a→q']).toEqual({ async: 15 });
    expect(r.failuresByReason['lost-event']).toBe(50);
    // 20 écritures × 2 unités.
    expect(r.ticks[0]!.nodes.d!.utilization).toBeCloseTo(0.4, 9);
  });

  it('avec, plus rien ne se perd, au prix d’une écriture de plus par événement', () => {
    const r = simulateWave(publisher(true), wave([orders], { incidents: [loss] }), catalog);
    expect(r.failuresByReason['lost-event']).toBe(0);
    expect(r.ticks[0]!.links['a→q']).toEqual({ async: 20 });
    expect(r.ticks[0]!.links['a→d']).toEqual({ write: 40 });
    expect(r.ticks[0]!.nodes.d!.utilization).toBeCloseTo(0.8, 9);
  });

  it('seul un serveur qui publie vers une file ou un pub/sub est exposé', () => {
    // Async appelé en direct : pas de bus entre l'écriture et la publication, rien à perdre.
    const r = simulateWave(direct(), wave([orders], { incidents: [loss] }), catalog);
    expect(r.failuresByReason['lost-event']).toBe(0);
  });
});

describe('partition et lectures à jour (S21)', () => {
  const replicated = (db: Record<string, number> = { replica: 1 }) =>
    arch([n('s', 'src'), n('a', 'app'), n('c', 'cache'), n('d', 'db', db)], [['s', 'a'], ['a', 'c'], ['a', 'd']]);
  const seats = (rps: number, extra: Partial<TrafficSource> = {}): TrafficSource => ({ id: 'seats', clients: 10, consistent: true, rps: { read: rps }, ...extra });
  const partition = incident('db', 2, 5, { type: 'partition' });

  it('une source `consistent` ne tombe jamais en cache', () => {
    // 50 lectures ordinaires (40 en cache) et 20 à jour, toutes en base.
    const r = simulateWave(replicated(), wave([users({ read: 50 }), seats(20)]), catalog);
    expect(r.ticks[0]!.links['a→c']).toEqual({ read: 40 });
    expect(r.ticks[0]!.links['a→d']).toEqual({ read: 30 });
  });

  it('pendant une partition, la part servie par les réplicas coupés est une lecture périmée', () => {
    // Primaire libre (100) + un réplica (100) : la moitié des lectures va au réplica, soit
    // 10 des 20 lectures à jour. Les lectures ordinaires ne s'en soucient pas.
    const r = simulateWave(replicated(), wave([users({ read: 50 }), seats(20)], { incidents: [partition] }), catalog);
    expect(r.ticks[2]!.nodes.d!).toMatchObject({ stale: 10, partitioned: true, failed: 10 });
    expect(r.ticks[5]!.nodes.d!.partitioned).toBeUndefined();
    expect(r.failuresByReason['stale-read']).toBe(30);
  });

  it('la lecture sur le primaire supprime les lectures périmées', () => {
    const r = simulateWave(replicated({ replica: 1, leader: 1 }), wave([users({ read: 50 }), seats(20)], { incidents: [partition] }), catalog);
    expect(r.failuresByReason['stale-read']).toBe(0);
    expect(r.failed).toBe(0);
  });

  it('sans réplica, la partition ne coupe rien', () => {
    const r = simulateWave(replicated({}), wave([users({ read: 50 }), seats(20)], { incidents: [partition] }), catalog);
    expect(r.failuresByReason['stale-read']).toBe(0);
    expect(r.ticks[2]!.nodes.d!.partitioned).toBeUndefined();
  });

  it('une lecture périmée n’est pas relancée : le client ne sait pas qu’elle est fausse', () => {
    const r = simulateWave(replicated(), wave([users({ read: 50 }), seats(20, { retries: 3 })], { incidents: [partition] }), catalog);
    expect(r.ticks.every((t) => t.retries === undefined)).toBe(true);
    expect(r.failed).toBe(30);
  });

  it('un CDN ne sert pas les lectures d’une source `consistent` (B11)', () => {
    // Comme le cache : les 20 lectures à jour traversent la bordure et arrivent au serveur.
    const a = arch([n('s', 'src'), n('e', 'edge'), n('a', 'app'), n('d', 'db')], [['s', 'e'], ['e', 'a'], ['a', 'd']]);
    const r = simulateWave(a, wave([seats(20)]), catalog);
    expect(r.ticks[0]!.nodes.a!.utilization).toBeCloseTo(0.2, 9);
  });

  it('un CDN laisse passer une API non cachable en bordure, que le cache applicatif sert (SC1)', () => {
    const a = arch([n('s', 'src'), n('e', 'edge'), n('a', 'app'), n('c', 'cache'), n('d', 'db')], [['s', 'e'], ['e', 'a'], ['a', 'c'], ['a', 'd']]);
    const r = simulateWave(a, wave([users({ read: 20 }, { noEdgeCache: true })]), catalog);
    expect(r.ticks[0]!.links['e→a']).toEqual({ read: 20 });
    expect(r.ticks[0]!.links['a→c']).toEqual({ read: 16 });
  });
});

describe('latence du SLA (S10, S17, S21)', () => {
  it('l’async traité en direct compte entier, pas dilué dans les lectures', () => {
    // 45 lectures et 5 commandes : la commande attend le serveur (20 ms) puis le service (100 ms).
    const a = arch([n('s', 'src'), n('a', 'app'), n('d', 'db'), n('s1', 'svc')], [['s', 'a'], ['a', 'd'], ['a', 's1']]);
    const r = simulateWave(a, wave([users({ read: 45, async: 5 })]), catalog);
    const app = lat(10, 0.5);
    const event = app + lat(100, 5 / 1000);
    expect(r.ticks[0]!.avgLatencyMs).toBeCloseTo((45 * (app + lat(10, 0.45)) + 5 * event) / 50, 9);
    expect(r.ticks[0]!.slaLatencyMs).toBeCloseTo(event, 9);
  });

  it('derrière une file, l’async sort du chemin critique', () => {
    const a = arch([n('s', 'src'), n('a', 'app'), n('d', 'db'), n('q', 'queue'), n('s1', 'svc')], [['s', 'a'], ['a', 'd'], ['a', 'q'], ['q', 's1']]);
    const r = simulateWave(a, wave([users({ read: 45, async: 5 })]), catalog);
    const app = lat(10, 0.5);
    expect(r.ticks[0]!.slaLatencyMs).toBeCloseTo((45 * (app + lat(10, 0.45)) + 5 * app) / 50, 9);
    expect(r.ticks[0]!.slaLatencyMs).toBe(r.ticks[0]!.avgLatencyMs);
  });

  describe('lectures à jour', () => {
    const a = arch([n('s', 'src'), n('a', 'app'), n('c', 'cache'), n('d', 'db')], [['s', 'a'], ['a', 'c'], ['a', 'd']]);
    const seats = (rps: number): TrafficSource => ({ id: 'seats', clients: 10, consistent: true, rps: { read: rps } });

    it('comptent à part au-delà de 5 % du trafic : serveur puis base, sans cache', () => {
      // 5 lectures à jour sur 55, soit 9 % : leur chemin, plus lent que la moyenne, fait le SLA.
      const t = simulateWave(a, wave([users({ read: 50 }), seats(5)]), catalog).ticks[0]!;
      expect(t.slaLatencyMs).toBeCloseTo(t.nodes.a!.latencyMs + t.nodes.d!.latencyMs, 9);
      expect(t.slaLatencyMs).toBeGreaterThan(t.avgLatencyMs);
    });

    it('en deçà, la moyenne seule', () => {
      // 2 sur 52 : 3,8 %, le p95 ne les voit pas.
      const t = simulateWave(a, wave([users({ read: 50 }), seats(2)]), catalog).ticks[0]!;
      expect(t.slaLatencyMs).toBe(t.avgLatencyMs);
    });
  });
});

describe('service pré-posé (S8)', () => {
  it('n’est pas facturé ; ses évolutions le sont', () => {
    const build = (fixed: boolean) =>
      arch(
        [n('s', 'src'), n('a', 'app'), n('q', 'queue'), { ...n('s1', 'svc', { idem: 1 }), ...(fixed ? { fixed: { tech: 'Stock', metaphor: 'Grenier' } } : {}) }],
        [['s', 'a'], ['a', 'q'], ['q', 's1']],
      );
    // Serveur 20 + file 25 + idempotence 5 ; le service lui-même (40) n'est dû que s'il est construit.
    expect(simulateWave(build(true), wave([users({ async: 10 })]), catalog).bill.fixed).toBe(50);
    expect(simulateWave(build(false), wave([users({ async: 10 })]), catalog).bill.fixed).toBe(90);
    // La complexité suit la même règle : 1 + 2 + 1 de l'idempotence.
    expect(simulateWave(build(true), wave([users({ async: 10 })]), catalog).gauges.complexity.value).toBe(4);
  });
});
