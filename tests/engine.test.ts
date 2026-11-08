import { describe, expect, it } from 'vitest';
import { simulateWave } from '../src/engine/simulate.ts';
import type { ArchLink, Architecture, Catalog, TrafficSource, Wave } from '../src/engine/types.ts';
import { validateArchitecture } from '../src/engine/validate.ts';

// Catalogue aux chiffres ronds, indépendant du calibrage du jeu.
const catalog: Catalog = {
  components: {
    src: { id: 'src', behavior: 'source', label: 'S', techName: 'S', cost: 0, complexity: 0, capacity: 1, latencyMs: 0, workPerRequest: {}, terminalFor: [], accepts: [] },
    edge: { id: 'edge', behavior: 'edge', label: 'CDN', techName: 'CDN', cost: 30, complexity: 2, capacity: 10000, latencyMs: 1, workPerRequest: { read: 1 }, terminalFor: [], accepts: ['read', 'write', 'async'], hitRate: 0.5 },
    lb: { id: 'lb', behavior: 'balancer', label: 'LB', techName: 'LB', cost: 10, complexity: 1, capacity: 10000, latencyMs: 1, workPerRequest: { read: 1, write: 1, async: 1 }, terminalFor: [], accepts: ['read', 'write', 'async'] },
    app: { id: 'app', behavior: 'service', label: 'App', techName: 'App', cost: 20, complexity: 1, capacity: 100, latencyMs: 10, workPerRequest: { read: 1, write: 1, async: 1 }, terminalFor: [], accepts: ['read', 'write', 'async'] },
    cache: { id: 'cache', behavior: 'cache', label: 'Cache', techName: 'Cache', cost: 5, complexity: 2, capacity: 10000, latencyMs: 1, workPerRequest: { read: 1 }, terminalFor: [], accepts: ['read'], routingPriority: 1, hitRate: 0.8 },
    db: { id: 'db', behavior: 'database', label: 'DB', techName: 'DB', cost: 50, complexity: 2, capacity: 100, latencyMs: 5, workPerRequest: { read: 1, write: 2, async: 2 }, terminalFor: ['read', 'write', 'async'], accepts: ['read', 'write', 'async'] },
    queue: { id: 'queue', behavior: 'queue', label: 'Q', techName: 'Q', cost: 25, complexity: 2, capacity: 10000, latencyMs: 2, workPerRequest: { async: 1 }, terminalFor: [], accepts: ['async'], routingPriority: 1, batchSize: 10, maxBacklog: 1000, allowedDownstream: ['app'] },
  },
  upgrades: {
    scale: { id: 'scale', label: 'Scale', techName: 'Scale', appliesTo: 'app', maxLevel: 5, cost: { base: 0, perLevel: 20 }, complexity: { base: 1, perLevel: 0 }, requiresUpstream: ['lb', 'queue'], removalCost: 'free', effect: { type: 'instances' } },
    auto: { id: 'auto', label: 'Auto', techName: 'Auto', appliesTo: 'app', maxLevel: 5, cost: { base: 5, perLevel: 0 }, complexity: { base: 2, perLevel: 0 }, requiresUpstream: ['lb'], removalCost: 'on-disable', effect: { type: 'autoscaling', instanceCost: 30, startupTicks: 2, targetUtilization: 0.5 } },
    replica: { id: 'replica', label: 'Replica', techName: 'Replica', appliesTo: 'db', maxLevel: 3, cost: { base: 0, perLevel: 30 }, complexity: { base: 0, perLevel: 1 }, removalCost: 'per-level', effect: { type: 'readReplicas', capacityPerReplica: 100 } },
    limit: { id: 'limit', label: 'Limit', techName: 'Limit', appliesTo: 'lb', maxLevel: 2, cost: { base: 5, perLevel: 0 }, complexity: { base: 1, perLevel: 0 }, removalCost: 'on-disable', effect: { type: 'rateLimit', tiersPerClientRps: [10, 20] } },
  },
};

const l = (from: string, to: string): ArchLink => ({ from, to });

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

const users = (rps: TrafficSource['rps'], clients = 100): TrafficSource => ({ id: 'users', clients, rps });

const appToDb: Architecture = {
  nodes: [{ id: 's', type: 'src' }, { id: 'a', type: 'app' }, { id: 'd', type: 'db' }],
  links: [l('s', 'a'), l('a', 'd')],
};

describe('simulateWave', () => {
  it('est déterministe', () => {
    const w = wave([users({ read: 150, write: 10 })]);
    expect(simulateWave(appToDb, w, catalog)).toEqual(simulateWave(appToDb, w, catalog));
  });

  it('sert tout le trafic sous la capacité', () => {
    const r = simulateWave(appToDb, wave([users({ read: 50, write: 10 })]), catalog);
    expect(r.failed).toBe(0);
    expect(r.won).toBe(true);
    expect(r.offered).toBe(600);
  });

  it('fait échouer la part qui dépasse la capacité et journalise la saturation', () => {
    // 200 req/s sur un serveur de capacité 100 : la moitié échoue.
    const r = simulateWave(appToDb, wave([users({ read: 200 })]), catalog);
    expect(r.nodes.a!.peakUtilization).toBe(2);
    expect(r.failuresByReason.saturation).toBeGreaterThan(0);
    expect(r.events).toContainEqual({ type: 'saturation-start', tick: 0, node: 'a', utilization: 2 });
    expect(r.events).toContainEqual({ type: 'saturation-end', tick: 10, node: 'a' });
    expect(r.won).toBe(false);
  });

  it('suit le profil de la vague', () => {
    const w = wave([users({ read: 50 })], { profile: [{ until: 5, factor: 1 }, { until: 10, factor: 3 }] });
    const r = simulateWave(appToDb, w, catalog);
    expect(r.ticks[4]!.offered).toBe(50);
    expect(r.ticks[5]!.offered).toBe(150);
    expect(r.events.filter((e) => e.type === 'saturation-start')).toEqual([
      { type: 'saturation-start', tick: 5, node: 'a', utilization: 1.5 },
    ]);
  });

  it('fait échouer une requête qui n’a pas de route', () => {
    const arch: Architecture = {
      nodes: [{ id: 's', type: 'src' }, { id: 'a', type: 'app' }],
      links: [l('s', 'a')],
    };
    const r = simulateWave(arch, wave([users({ read: 10 })]), catalog);
    expect(r.gauges.failureRate.value).toBe(1);
    expect(r.events).toContainEqual({ type: 'no-route', tick: 0, node: 'a', kind: 'read' });
  });

  it('fait monter la latence avec la charge', () => {
    const low = simulateWave(appToDb, wave([users({ read: 10 })]), catalog);
    const high = simulateWave(appToDb, wave([users({ read: 90 })]), catalog);
    expect(high.gauges.latency.value).toBeGreaterThan(low.gauges.latency.value * 3);
  });

  it('le cache détourne sa part de lectures de la base', () => {
    const arch: Architecture = {
      nodes: [{ id: 's', type: 'src' }, { id: 'a', type: 'app' }, { id: 'c', type: 'cache' }, { id: 'd', type: 'db' }],
      links: [l('s', 'a'), l('a', 'c'), l('c', 'd')],
    };
    const r = simulateWave(arch, wave([users({ read: 90 })]), catalog);
    expect(r.ticks[0]!.nodes.d!.utilization).toBeCloseTo(0.18);
  });

  describe('CDN', () => {
    const arch: Architecture = {
      nodes: [{ id: 's', type: 'src' }, { id: 'e', type: 'edge' }, { id: 'a', type: 'app' }, { id: 'd', type: 'db' }],
      links: [l('s', 'e'), l('e', 'a'), l('a', 'd')],
    };

    it('sert une part des lectures en bordure', () => {
      const r = simulateWave(arch, wave([users({ read: 80 })]), catalog);
      expect(r.ticks[0]!.nodes.a!.utilization).toBeCloseTo(0.4);
    });

    it('perd les tâches async des requêtes servies en bordure', () => {
      const r = simulateWave(arch, wave([users({ read: 20, async: 20 })]), catalog);
      expect(r.failuresByReason['lost-at-edge']).toBe(10 * 10);
    });

    it('ne cache rien pour une source en longue traîne', () => {
      const crawler: TrafficSource = { id: 'crawler', clients: 1, longTail: true, rps: { read: 80 } };
      const r = simulateWave(arch, wave([crawler]), catalog);
      expect(r.ticks[0]!.nodes.a!.utilization).toBeCloseTo(0.8);
    });
  });

  describe('autoscaling', () => {
    const arch: Architecture = {
      nodes: [
        { id: 's', type: 'src' },
        { id: 'lb', type: 'lb' },
        { id: 'a', type: 'app', upgrades: { auto: 3 } },
        { id: 'd', type: 'db', upgrades: { replica: 3 } },
      ],
      links: [l('s', 'lb'), l('lb', 'a'), l('a', 'd')],
    };
    // 40 req/s pendant 4 ticks, puis 200 req/s : il faut 3 instances de plus à 50 % de charge cible.
    const peak = wave([users({ read: 40 })], {
      ticks: 10,
      profile: [{ until: 4, factor: 1 }, { until: 8, factor: 5 }, { until: 10, factor: 1 }],
    });

    it('ajoute des instances après leur délai de démarrage, et réduit aussitôt', () => {
      const r = simulateWave(arch, peak, catalog);
      expect(r.ticks.map((t) => t.nodes.a!.instances)).toEqual([1, 1, 1, 1, 1, 1, 4, 4, 4, 1]);
    });

    it('fait échouer le trafic pendant le démarrage', () => {
      const r = simulateWave(arch, peak, catalog);
      expect(r.ticks[4]!.failed).toBe(100);
      expect(r.ticks[6]!.failed).toBe(0);
    });

    it('facture les instances au prorata de leur temps de service', () => {
      const r = simulateWave(arch, peak, catalog);
      // 3 instances pendant 3 ticks sur 10, à 30 la vague : 27, plus 5 de socle.
      expect(r.bill.autoscaling).toBeCloseTo(27);
      expect(r.gauges.cost.value).toBeCloseTo(10 + 20 + 50 + 90 + 5 + 27);
    });
  });

  it('les réplicas ajoutent de la capacité en lecture, pas en écriture', () => {
    const withReplica: Architecture = {
      ...appToDb,
      nodes: appToDb.nodes.map((n) => (n.id === 'd' ? { ...n, upgrades: { replica: 1 } } : n)),
    };
    const reads = wave([users({ read: 90 })], { ticks: 1, profile: [{ until: 1, factor: 1 }] });
    // 90 lectures + travail des écritures : la base seule sature, le réplica absorbe.
    const readsAndWrites = wave([users({ read: 80, write: 15 })]);
    expect(simulateWave(appToDb, readsAndWrites, catalog).nodes.d!.peakUtilization).toBeGreaterThan(1);
    expect(simulateWave(withReplica, readsAndWrites, catalog).failed).toBe(0);
    expect(simulateWave(withReplica, reads, catalog).failed).toBe(0);

    const writes = wave([users({ write: 80 })]);
    expect(simulateWave(withReplica, writes, catalog).nodes.d!.peakUtilization).toBe(1.6);
  });

  describe('rate limiting', () => {
    // Paliers du catalogue de test : niveau 1 = 10 req/s par client, niveau 2 = 20.
    const arch = (tier: number): Architecture => ({
      nodes: [
        { id: 's', type: 'src' },
        { id: 'lb', type: 'lb', upgrades: { limit: tier } },
        { id: 'a', type: 'app', upgrades: { scale: 1 } },
        { id: 'd', type: 'db', upgrades: { replica: 2 } },
      ],
      links: [l('s', 'lb'), l('lb', 'a'), l('a', 'd')],
    });
    const abuser: TrafficSource = { id: 'bot', clients: 1, abusive: true, rps: { read: 150 } };

    it('écarte le client abusif sans compter d’échec', () => {
      const w = wave([users({ read: 100 }), abuser]);
      expect(simulateWave(arch(0), w, catalog).failed).toBeGreaterThan(0);
      const r = simulateWave(arch(1), w, catalog);
      expect(r.failed).toBe(0);
      expect(r.shed).toBe(140 * 10);
      expect(r.won).toBe(true);
    });

    it('compte comme échec le trafic légitime rejeté par une limite trop basse', () => {
      // 20 req/s par client pour une limite à 10 : la moitié du trafic légitime saute.
      const r = simulateWave(arch(1), wave([users({ read: 100 }, 5)]), catalog);
      expect(r.failuresByReason['rate-limited']).toBe(50 * 10);
      expect(r.shed).toBe(0);
    });

    it('le niveau choisit le palier', () => {
      const r = simulateWave(arch(2), wave([users({ read: 100 }, 5)]), catalog);
      expect(r.failuresByReason['rate-limited']).toBe(0);
    });

    it('l’async n’entame pas le quota du client', () => {
      // 8 lectures + 8 tâches async par client : seul le synchrone compte face à la limite de 10.
      const r = simulateWave(arch(1), wave([users({ read: 40, async: 40 }, 5)]), catalog);
      expect(r.failuresByReason['rate-limited']).toBe(0);
    });
  });

  describe('file de messages', () => {
    const arch = (worker = true): Architecture => ({
      nodes: [
        { id: 's', type: 'src' },
        { id: 'a', type: 'app' },
        { id: 'q', type: 'queue' },
        { id: 'w', type: 'app' },
        { id: 'd', type: 'db' },
      ],
      // L'async entre directement dans la file pour isoler son comportement du serveur.
      links: [
        l('s', 'a'),
        l('a', 'd'),
        l('s', 'q'),
        ...(worker ? [l('q', 'w'), l('w', 'd')] : []),
      ],
    });

    it('regroupe les messages : l’aval paie un envoi par lot', () => {
      const r = simulateWave(arch(), wave([users({ async: 50 })]), catalog);
      expect(r.failed).toBe(0);
      // 50 messages/s en lots de 10 → 5 lots, 2 unités de travail chacun.
      expect(r.ticks[0]!.nodes.d!.utilization).toBeCloseTo(0.1);
    });

    it('n’ajoute pas la latence de l’aval au chemin synchrone', () => {
      const r = simulateWave(arch(), wave([users({ read: 10, async: 50 })]), catalog);
      const readsOnly = simulateWave(arch(), wave([users({ read: 10 })]), catalog);
      // Seule la charge des lots sur la base partagée bouge un peu la latence des lectures.
      expect(r.gauges.latency.value).toBeLessThan(readsOnly.gauges.latency.value * 1.1);
    });

    it('accumule un arriéré quand le consommateur est trop lent, puis le résorbe', () => {
      const slow: Catalog = {
        ...catalog,
        components: { ...catalog.components, queue: { ...catalog.components.queue!, batchSize: 1 } },
      };
      const w = wave([users({ async: 40 })], {
        ticks: 6,
        profile: [{ until: 2, factor: 4 }, { until: 6, factor: 1 }],
      });
      // Le worker absorbe 100 messages/s : 160 entrent pendant 2 ticks, puis 40.
      const r = simulateWave(arch(), w, slow);
      expect(r.ticks.map((t) => t.nodes.q!.backlog)).toEqual([60, 120, 60, 0, 0, 0]);
      expect(r.failuresByReason['queue-overflow']).toBe(0);
    });

    it('perd des messages au-delà de l’arriéré maximal', () => {
      const r = simulateWave(arch(false), wave([users({ async: 300 })]), catalog);
      expect(r.failuresByReason['queue-overflow']).toBe(300 * 10 - 1000);
      expect(r.events.some((e) => e.type === 'queue-overflow')).toBe(true);
    });
  });

  it('mesure la latence au p95 des ticks, pas en moyenne', () => {
    // 1 tick de pic sur 20 : la moyenne l'écrase, le p95 (rang 19 sur 20) ne le voit pas encore.
    const oneSpike = wave([users({ read: 10 })], {
      ticks: 20,
      profile: [{ until: 19, factor: 1 }, { until: 20, factor: 9.5 }],
    });
    const r1 = simulateWave(appToDb, oneSpike, catalog);
    expect(r1.gauges.latency.value).toBeLessThan(r1.avgLatencyMs);

    const twoSpikes = { ...oneSpike, profile: [{ until: 18, factor: 1 }, { until: 20, factor: 9.5 }] };
    const r2 = simulateWave(appToDb, twoSpikes, catalog);
    expect(r2.gauges.latency.value).toBeGreaterThan(r2.avgLatencyMs);
    expect(r2.gauges.latency.value).toBe(Math.max(...r2.ticks.map((t) => t.avgLatencyMs)));
  });

  it('calcule coût et complexité, et perd sur l’un ou l’autre', () => {
    const w = wave([users({ read: 10 })], { budget: 60, complexityCap: 2 });
    const r = simulateWave(appToDb, w, catalog);
    expect(r.gauges.cost).toEqual({ value: 70, limit: 60, margin: -10 / 60 });
    expect(r.gauges.complexity.value).toBe(3);
    expect(r.lossReasons).toEqual(['Budget dépassé : 70 / 60', 'Trop complexe : 3 / 2 points']);
  });

  it('renvoie une défaite expliquée pour une architecture invalide', () => {
    const arch: Architecture = { ...appToDb, links: [...appToDb.links, l('d', 'a')] };
    const r = simulateWave(arch, wave([users({ read: 10 })]), catalog);
    expect(r.won).toBe(false);
    expect(r.lossReasons).toEqual(['Architecture invalide : Le graphe contient un cycle']);
  });
});

describe('validateArchitecture', () => {
  const errorsOf = (arch: Architecture) => {
    const v = validateArchitecture(arch, catalog);
    return v.ok ? [] : v.errors;
  };

  it('exige une seule source', () => {
    expect(errorsOf({ nodes: [{ id: 'a', type: 'app' }], links: [] })).toEqual([
      'Il faut exactement une source de trafic (trouvé : 0)',
    ]);
  });

  it('refuse le scaling sans load balancer en amont', () => {
    const arch: Architecture = {
      ...appToDb,
      nodes: appToDb.nodes.map((n) => (n.id === 'a' ? { ...n, upgrades: { scale: 2 } } : n)),
    };
    expect(errorsOf(arch)).toEqual(['Scale sur a exige que tout son trafic arrive par : lb ou queue']);
  });

  it('autorise le scaling d’un worker derrière une file', () => {
    const arch: Architecture = {
      nodes: [{ id: 's', type: 'src' }, { id: 'q', type: 'queue' }, { id: 'w', type: 'app', upgrades: { scale: 2 } }],
      links: [l('s', 'q'), l('q', 'w')],
    };
    expect(errorsOf(arch)).toEqual([]);
  });

  it('refuse une évolution sur le mauvais composant ou hors niveau', () => {
    const arch: Architecture = {
      ...appToDb,
      nodes: appToDb.nodes.map((n) => (n.id === 'd' ? { ...n, upgrades: { scale: 1, replica: 9 } } : n)),
    };
    expect(errorsOf(arch)).toEqual([
      'Scale ne s\'applique pas à d (db)',
      'Scale sur d exige que tout son trafic arrive par : lb ou queue',
      'Replica sur d : niveau 9 hors de [0, 3]',
    ]);
  });

  it('respecte les composants autorisés en aval', () => {
    const arch: Architecture = {
      nodes: [{ id: 's', type: 'src' }, { id: 'q', type: 'queue' }, { id: 'd', type: 'db' }],
      links: [l('s', 'q'), l('q', 'd')],
    };
    expect(errorsOf(arch)).toEqual(['queue ne peut alimenter que app (q → d)']);
  });

  it('donne un ordre topologique stable', () => {
    const v = validateArchitecture(appToDb, catalog);
    expect(v.ok && v.order).toEqual(['s', 'a', 'd']);
  });
});
