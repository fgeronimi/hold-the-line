import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as M from '../src/data/scenarios/market.archetypes.ts';
import { market } from '../src/data/scenarios/market.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import type { Architecture } from '../src/engine/types.ts';

const wave = (id: string) => market.waves.find((w) => w.id === id)!;
const play = (arch: Architecture, id: string) => simulateWave(arch, wave(id), catalog);

describe('le grand marché', () => {
  it('vague 1 — les événements passent par une file, la base seule ne tient pas', () => {
    expect(play(M.queued, 'market-open').won).toBe(true);
    expect(play(M.inline, 'market-open').won).toBe(false);
  });

  it('vague 2 — un pub/sub copie chaque événement aux trois services ; une file les partage', () => {
    const fanned = play(M.fannedOut(), 'three-trades');
    expect(fanned.won).toBe(true);
    expect(fanned.delivery).toEqual({ expected: 18000, delivered: 18000 });
    for (const arch of [M.queued, M.threeQueues]) {
      const r = play(arch, 'three-trades');
      expect(r.won).toBe(false);
      expect(r.failuresByReason.undelivered).toBeCloseTo(12000);
    }
  });

  it('vague 3 — les doublons sont des échecs, sauf chez un consommateur idempotent', () => {
    const naive = play(M.fannedOut(), 'double-delivery');
    expect(naive.won).toBe(false);
    expect(naive.failuresByReason.duplicate).toBeGreaterThan(0);
    const idempotent = play(M.fannedOut({ idempotence: true }), 'double-delivery');
    expect(idempotent.won).toBe(true);
    expect(idempotent.failuresByReason.duplicate).toBe(0);
  });

  it('vague 4 — sans outbox des commandes se perdent ; l’outbox double les écritures, il faut soulager la base', () => {
    const lost = play(M.fannedOut({ idempotence: true }), 'lost-orders');
    expect(lost.won).toBe(false);
    expect(lost.failuresByReason['lost-event']).toBeGreaterThan(0);
    expect(play(M.fannedOut({ idempotence: true, outbox: true }), 'lost-orders').won).toBe(false);
    expect(play(M.fannedOut({ idempotence: true, outbox: true, cache: true }), 'lost-orders').won).toBe(true);
    expect(play(M.fannedOut({ idempotence: true, outbox: true, replicas: 1 }), 'lost-orders').won).toBe(true);
  });

  it('vague 5 — les soldes : tout ce qui précède, plus une instance derrière un load balancer', () => {
    const answer = { idempotence: true, outbox: true, cache: true, extraInstances: 1 };
    expect(play(M.fannedOut(answer), 'sales').won).toBe(true);
    expect(play(M.fannedOut({ ...answer, extraInstances: 0 }), 'sales').won).toBe(false);
    expect(play(M.fannedOut({ ...answer, idempotence: false }), 'sales').won).toBe(false);
    expect(play(M.fannedOut({ ...answer, outbox: false }), 'sales').won).toBe(false);
    expect(play(M.fannedOut({ ...answer, extraInstances: 2 }), 'sales').lossReasons).toEqual(['Budget dépassé : 285 / 270']);
  });

  it('des workers abonnés directement, sans file, noient la base', () => {
    const direct: Architecture = {
      nodes: [
        { id: 'src', type: 'traffic-source' },
        { id: 'app', type: 'app-server' },
        { id: 'db', type: 'database' },
        { id: 'bus', type: 'pubsub' },
        ...['w1', 'w2', 'w3'].map((id) => ({ id, type: 'app-server' })),
      ],
      links: [
        { from: 'src', to: 'app' },
        { from: 'app', to: 'db' },
        { from: 'app', to: 'bus' },
        ...['w1', 'w2', 'w3'].flatMap((w) => [{ from: 'bus', to: w }, { from: w, to: 'db' }]),
      ],
    };
    const r = play(direct, 'three-trades');
    expect(r.won).toBe(false);
    expect(r.nodes.db!.peakUtilization).toBeGreaterThan(1);
  });

  it('une file sans consommateur ne livre rien : ses messages comptent comme non livrés', () => {
    const fanned = M.fannedOut();
    const noWorker: Architecture = {
      nodes: fanned.nodes.filter((n) => n.id !== 'worker'),
      links: fanned.links.filter((l) => l.from !== 'worker' && l.to !== 'worker'),
    };
    const r = play(noWorker, 'three-trades');
    expect(r.won).toBe(false);
    expect(r.failuresByReason.undelivered).toBeGreaterThan(0);
  });
});
