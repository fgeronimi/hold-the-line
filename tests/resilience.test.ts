import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import { checkout } from '../src/data/scenarios/resilience.archetypes.ts';
import { resilience } from '../src/data/scenarios/resilience.ts';
import { fortifiedCity } from '../src/data/themes/fortified-city.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import type { Architecture, WaveResult } from '../src/engine/types.ts';
import { analyzeWave } from '../src/ui/debrief.ts';

const wave = (id: string) => resilience.waves.find((w) => w.id === id)!;
const play = (arch: Architecture, id: string) => simulateWave(arch, wave(id), catalog);
const app = (r: WaveResult, tick: number) => r.ticks[tick]!.nodes.app!;

describe('le comptoir des paiements', () => {
  it('chaque vague est gagnée par sa réponse attendue, et perdue sans elle', () => {
    expect(play(checkout(), 'checkout').won).toBe(true);
    expect(play(checkout({ queue: true }), 'checkout').won).toBe(false);

    expect(play(checkout(), 'slow-banker').won).toBe(false);
    expect(play(checkout({ breaker: true }), 'slow-banker').won).toBe(true);
    expect(play(checkout({ queue: true }), 'slow-banker').won).toBe(true);

    expect(play(checkout({ cache: true }), 'midnight-expiry').won).toBe(false);
    expect(play(checkout({ cache: true, coalescing: true }), 'midnight-expiry').won).toBe(true);
    expect(play(checkout({ replicas: 1 }), 'midnight-expiry').won).toBe(true);

    expect(play(checkout({ breaker: true, cache: true, coalescing: true }), 'banker-closed').won).toBe(false);
    expect(play(checkout({ queue: true, cache: true }), 'banker-closed').won).toBe(true);
    expect(play(checkout({ queue: true, replicas: 1 }), 'banker-closed').won).toBe(true);

    const fair = { cache: true, coalescing: true, replicas: 2, extraInstances: 2 };
    expect(play(checkout(fair), 'fair').won).toBe(false);
    expect(play(checkout({ ...fair, breaker: true }), 'fair').won).toBe(true);
    expect(play(checkout({ ...fair, queue: true }), 'fair').won).toBe(true);
  });

  it('la réponse sur-dimensionnée perd sur le coût ou la complexité', () => {
    const everything = checkout({ breaker: true, queue: true, cache: true, coalescing: true, replicas: 3, extraInstances: 3 });
    for (const w of resilience.waves) {
      const r = simulateWave(everything, w, catalog);
      expect(r.won, w.id).toBe(false);
      expect(r.gauges.cost.value > w.budget || r.gauges.complexity.value > w.complexityCap, w.id).toBe(true);
    }
  });
});

describe('cascade de pannes et circuit breaker', () => {
  const during = 26;

  it('un prestataire lent épuise les fils du serveur : même les lectures échouent', () => {
    const r = play(checkout(), 'slow-banker');
    expect(r.events.some((e) => e.type === 'threads-exhausted' && e.node === 'app' && e.dependency === 'bank')).toBe(true);
    expect(app(r, during).threads).toBeGreaterThan(1);
    // Plus d'échecs que de paiements : la panne s'est propagée aux consultations.
    expect(app(r, during).failed).toBeGreaterThan(r.ticks[during]!.links['app→bank']?.async ?? 0);
    expect(app(r, 10).threads).toBeLessThan(0.2);
  });

  it('le disjoncteur coupe le prestataire : les paiements échouent vite, le reste est servi', () => {
    const r = play(checkout({ breaker: true }), 'slow-banker');
    expect(r.events.some((e) => e.type === 'threads-exhausted')).toBe(false);
    expect(app(r, during).open).toEqual(['bank']);
    expect(r.failuresByReason['circuit-open']).toBeGreaterThan(0);
    expect(r.failuresByReason.saturation).toBe(0);
    // Un appel coupé n'attend pas la banque : la latence reste celle d'un jour normal.
    expect(r.ticks[during]!.avgLatencyMs).toBeLessThan(60);
  });

  it('plus d’instances, c’est plus de fils, mais le client attend toujours la banque', () => {
    const r = play(checkout({ extraInstances: 1 }), 'slow-banker');
    expect(r.events.some((e) => e.type === 'threads-exhausted')).toBe(false);
    expect(r.gauges.latency.value).toBeGreaterThan(wave('slow-banker').sla.maxP95LatencyMs);
  });

  it('une file différé les paiements pendant la panne, et les livre à la réouverture', () => {
    const r = play(checkout({ queue: true, cache: true }), 'banker-closed');
    const backlog = (t: number) => r.ticks[t]!.nodes.queue!.backlog ?? 0;
    expect(backlog(30)).toBeGreaterThan(backlog(20));
    expect(backlog(59)).toBe(0);
    expect(r.gauges.failureRate.value).toBe(0);
  });
});

describe('ruée vers le cache', () => {
  it('sans verrou, chaque absence est recalculée plusieurs fois et la base cède', () => {
    const herd = play(checkout({ cache: true }), 'midnight-expiry');
    const locked = play(checkout({ cache: true, coalescing: true }), 'midnight-expiry');
    expect(herd.ticks[30]!.nodes.db!.utilization).toBeGreaterThan(locked.ticks[30]!.nodes.db!.utilization * 3);
    expect(herd.ticks[30]!.nodes.db!.failed).toBeGreaterThan(locked.ticks[30]!.nodes.db!.failed);
  });
});

describe('le chambellan raconte la résilience', () => {
  const tellsOf = (arch: Architecture, id: string) => analyzeWave(play(arch, id), arch, wave(id), catalog, fortifiedCity);

  it('nomme la cascade sans disjoncteur, et les paiements coupés avec', () => {
    expect(tellsOf(checkout(), 'slow-banker').some((f) => f.concept?.includes('cascade') && f.tone === 'bad')).toBe(true);
    const cut = tellsOf(checkout({ breaker: true }), 'slow-banker');
    expect(cut.some((f) => f.concept?.includes('réponse dégradée'))).toBe(true);
  });

  it('propose le paiement différé quand le prestataire ferme', () => {
    const told = tellsOf(checkout({ breaker: true, cache: true }), 'banker-closed');
    expect(told.some((f) => f.concept?.includes('paiement différé') && f.tone === 'bad')).toBe(true);
  });
});
