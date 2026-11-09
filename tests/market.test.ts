import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as M from '../src/data/scenarios/market.archetypes.ts';
import { market } from '../src/data/scenarios/market.ts';
import { totals } from '../src/engine/budget.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import type { Architecture } from '../src/engine/types.ts';

const wave = (id: string) => market.waves.find((w) => w.id === id)!;
const play = (arch: Architecture, id: string) => simulateWave(arch, wave(id), catalog);
const without = (arch: Architecture, id: string): Architecture => ({
  nodes: arch.nodes.filter((n) => n.id !== id),
  links: arch.links.filter((l) => l.from !== id && l.to !== id),
});

describe('le grand marché', () => {
  it('les trois services sont déjà là, et ne coûtent rien tant qu’on ne les fait pas évoluer', () => {
    expect(market.fixtures!.map((n) => n.id)).toEqual(['stock', 'billing', 'mail']);
    const empty: Architecture = { nodes: [{ id: 'src', type: 'traffic-source' }, ...market.fixtures!], links: [] };
    expect(totals(empty, catalog)).toEqual({ cost: 0, complexity: 0 });
  });

  it('vague 1 — les événements passent par une file vers le service e-mail', () => {
    expect(play(M.queued, 'market-open').won).toBe(true);
    const inline = play(M.inline, 'market-open');
    expect(inline.won).toBe(false);
    expect(inline.failuresByReason.undelivered).toBeGreaterThan(0);
  });

  it('vague 2 — un pub/sub copie chaque événement aux trois services ; une file les partage', () => {
    const fanned = play(M.fannedOut(), 'three-trades');
    expect(fanned.won).toBe(true);
    expect(fanned.delivery).toEqual({ expected: 18000, delivered: 18000 });
    for (const arch of [M.queued, M.sharedQueue]) {
      const r = play(arch, 'three-trades');
      expect(r.won).toBe(false);
      expect(r.failuresByReason.undelivered).toBeCloseTo(12000);
    }
  });

  it('vague 3 — les doublons sont des échecs, sauf chez des services idempotents', () => {
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
    expect(play(M.fannedOut({ ...answer, extraInstances: 2 }), 'sales').won).toBe(false);
  });

  it('des services abonnés directement, sans file, noient la base', () => {
    const fanned = M.fannedOut();
    const direct: Architecture = {
      nodes: fanned.nodes.filter((n) => !n.id.startsWith('q-')),
      links: [...fanned.links.filter((l) => !l.from.startsWith('q-') && !l.to.startsWith('q-')), ...['stock', 'billing', 'mail'].map((s) => ({ from: 'bus', to: s }))],
    };
    const r = play(direct, 'three-trades');
    expect(r.won).toBe(false);
    expect(r.nodes.db!.peakUtilization).toBeGreaterThan(1);
  });

  it('un service que rien n’alimente ne reçoit rien : ses événements comptent comme non livrés', () => {
    const r = play(without(M.fannedOut(), 'q-stock'), 'three-trades');
    expect(r.won).toBe(false);
    expect(r.failuresByReason.undelivered).toBeCloseTo(6000);
  });
});
