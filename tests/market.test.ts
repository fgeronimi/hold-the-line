import { describe, expect, it } from 'vitest';
import { answersOf } from '../src/data/balance-space.ts';
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
  it('chaque vague est gagnée par chacune de ses réponses attendues', () => {
    market.waves.forEach((w, i) => {
      const answers = answersOf(market.id, i);
      expect(answers.length, w.id).toBeGreaterThan(0);
      answers.forEach((arch, k) => expect(play(arch, w.id).won, `${w.id} #${k}`).toBe(true));
    });
  });

  it('les trois services sont déjà là, et ne coûtent rien tant qu’on ne les fait pas évoluer', () => {
    expect(market.fixtures!.map((n) => n.id)).toEqual(['stock', 'billing', 'mail']);
    const empty: Architecture = { nodes: [{ id: 'src', type: 'traffic-source' }, ...market.fixtures!], links: [] };
    expect(totals(empty, catalog)).toEqual({ cost: 0, complexity: 0 });
  });

  it('vague 1 — les événements passent par une file vers le service e-mail', () => {
    // Appelé en direct, le service e-mail livre tout, mais le client attend l'envoi du mail.
    const inline = play(M.inline, 'market-open');
    expect(inline.won).toBe(false);
    expect(inline.failuresByReason.undelivered).toBe(0);
    expect(inline.gauges.latency.value).toBeGreaterThan(60);
  });

  it('vague 2 — un pub/sub copie chaque événement aux trois services ; une file les partage', () => {
    const fanned = play(M.fannedOut(), 'three-trades');
    const expected = fanned.delivery!.expected;
    expect(fanned.delivery!.delivered).toBeCloseTo(expected);
    // Un seul service sur trois servi, ou chacun un tiers : deux tiers des livraisons manquent.
    for (const arch of [M.queued, M.sharedQueue]) {
      const r = play(arch, 'three-trades');
      expect(r.won).toBe(false);
      expect(r.failuresByReason.undelivered).toBeCloseTo((expected * 2) / 3);
    }
  });

  it('vague 3 — les doublons sont des échecs, sauf chez des services idempotents', () => {
    const naive = play(M.fannedOut(), 'double-delivery');
    expect(naive.won).toBe(false);
    expect(naive.failuresByReason.duplicate).toBeGreaterThan(0);
    const idempotent = play(M.fannedOut({ idempotence: true }), 'double-delivery');
    expect(idempotent.failuresByReason.duplicate).toBe(0);
  });

  it('vague 4 — sans outbox des commandes se perdent ; l’outbox double les écritures, il faut soulager la base', () => {
    const lost = play(M.fannedOut({ idempotence: true }), 'lost-orders');
    expect(lost.won).toBe(false);
    expect(lost.failuresByReason['lost-event']).toBeGreaterThan(0);
    expect(play(M.fannedOut({ idempotence: true, outbox: true }), 'lost-orders').won).toBe(false);
  });

  it('vague 5 — les soldes : tout ce qui précède, plus une instance derrière un load balancer', () => {
    const answer = { idempotence: true, outbox: true, cache: true, extraInstances: 1 };
    expect(play(M.fannedOut({ ...answer, extraInstances: 0 }), 'sales').won).toBe(false);
    expect(play(M.fannedOut({ ...answer, idempotence: false }), 'sales').won).toBe(false);
    expect(play(M.fannedOut({ ...answer, outbox: false }), 'sales').won).toBe(false);
    expect(play(M.fannedOut({ ...answer, extraInstances: 2 }), 'sales').won).toBe(false);
  });

  it('des services abonnés directement, sans file, font attendre le client', () => {
    const fanned = M.fannedOut();
    const isQueue = (id: string) => id === 'queue' || id.startsWith('q-');
    const direct: Architecture = {
      nodes: fanned.nodes.filter((n) => !isQueue(n.id)),
      links: [...fanned.links.filter((l) => !isQueue(l.from) && !isQueue(l.to)), ...['stock', 'billing', 'mail'].map((s) => ({ from: 'bus', to: s }))],
    };
    const r = play(direct, 'three-trades');
    expect(r.won).toBe(false);
    expect(r.gauges.latency.value).toBeGreaterThan(60);
  });

  it('un service que rien n’alimente ne reçoit rien : ses événements comptent comme non livrés', () => {
    const r = play(without(M.fannedOut(), 'q-stock'), 'three-trades');
    expect(r.won).toBe(false);
    expect(r.failuresByReason.undelivered).toBeCloseTo(r.delivery!.expected / 3);
  });
});

describe('ce que le rendu montre des incidents du marché', () => {
  const sum = (arch: Architecture, id: string, key: 'duplicates' | 'deduplicated' | 'lost') =>
    play(arch, id).ticks.reduce((a, t) => a + Object.values(t.nodes).reduce((b, n) => b + (n[key] ?? 0), 0), 0);

  it('compte les doublons traités deux fois, ou écartés par l’idempotence', () => {
    expect(sum(M.fannedOut(), 'double-delivery', 'duplicates')).toBeGreaterThan(0);
    expect(sum(M.fannedOut(), 'double-delivery', 'deduplicated')).toBe(0);
    expect(sum(M.fannedOut({ idempotence: true }), 'double-delivery', 'duplicates')).toBe(0);
    expect(sum(M.fannedOut({ idempotence: true }), 'double-delivery', 'deduplicated')).toBeGreaterThan(0);
  });

  it('compte les événements perdus avant publication, sauf avec l’outbox', () => {
    expect(sum(M.fannedOut({ idempotence: true }), 'lost-orders', 'lost')).toBeGreaterThan(0);
    expect(sum(M.fannedOut({ idempotence: true, outbox: true }), 'lost-orders', 'lost')).toBe(0);
  });
});
