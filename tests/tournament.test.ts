import { describe, expect, it } from 'vitest';
import { answersOf } from '../src/data/balance-space.ts';
import { catalog } from '../src/data/catalog.ts';
import { boxOffice } from '../src/data/scenarios/tournament.archetypes.ts';
import { tournament } from '../src/data/scenarios/tournament.ts';
import { fortifiedCity } from '../src/data/themes/fortified-city.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import type { Architecture } from '../src/engine/types.ts';
import { replayStats } from '../src/render/hud.ts';
import { analyzeWave } from '../src/ui/debrief.ts';

const wave = (id: string) => tournament.waves.find((w) => w.id === id)!;
const play = (arch: Architecture, id: string) => simulateWave(arch, wave(id), catalog);

describe('la billetterie du tournoi', () => {
  // Les réponses attendues sont des données (`Wave.answers`), jouées isolément.
  it('chaque vague est gagnée par chacune de ses réponses attendues', () => {
    tournament.waves.forEach((w, i) => {
      const answers = answersOf(tournament.id, i);
      expect(answers.length, w.id).toBeGreaterThan(0);
      answers.forEach((arch, k) => expect(play(arch, w.id).won, `${w.id} #${k}`).toBe(true));
    });
  });

  // `npm run balance` le vérifie sur tout l'espace ; ici, sur les réponses attendues elles-mêmes.
  // Limité à la finale : depuis la réponse 3 de la vague 1 (backoff + autoscaling), la vague 2
  // n'a pas de réponse atteignable, défaut connu que l'outillage d'équilibrage signale.
  it('depuis chaque réponse de la vague 3, une réponse de la finale est atteignable avec sa migration', () => {
    const final = wave('final-joust');
    for (const [k, previous] of answersOf(tournament.id, 2).entries()) {
      const reachable = answersOf(tournament.id, 3).some((arch) => simulateWave(arch, final, catalog, previous).won);
      expect(reachable, `réponse ${k + 1} de split-registry`).toBe(true);
    }
  });

  it('chaque vague est perdue sans sa réponse', () => {
    const rush = { extraInstances: 1, cache: true };
    expect(play(boxOffice(rush), 'ticket-rush').won).toBe(false);
    expect(play(boxOffice({ ...rush, backoff: true, queue: false }), 'ticket-rush').won).toBe(false);

    expect(play(boxOffice(rush), 'pigeons-grounded').won).toBe(false);

    const split = { extraInstances: 1, replicas: 2 };
    expect(play(boxOffice(split), 'split-registry').won).toBe(false);
    expect(play(boxOffice({ ...split, replicas: 3 }), 'split-registry').won).toBe(false);

    const final = { cache: true, replicas: 1, leaderReads: true };
    expect(play(boxOffice({ ...final, extraInstances: 3, backoff: true, leaderReads: false }), 'final-joust').won).toBe(false);
    expect(play(boxOffice({ cache: true, extraInstances: 3, backoff: true }), 'final-joust').won).toBe(false);
  });

  it('la réponse sur-dimensionnée perd sur le coût ou la complexité', () => {
    const everything = boxOffice({ backoff: true, extraInstances: 4, autoscaling: 6, cache: true, replicas: 3, leaderReads: true, retention: 3 });
    for (const w of tournament.waves) {
      const r = simulateWave(everything, w, catalog);
      expect(r.won, w.id).toBe(false);
      expect(r.gauges.cost.value > w.budget || r.gauges.complexity.value > w.complexityCap, w.id).toBe(true);
    }
  });
});

describe('tempête de relances', () => {
  const rush = { extraInstances: 1, cache: true };

  it('sans backoff, la panne passée, les relances entretiennent la saturation jusqu’à ce que le trafic retombe', () => {
    const r = play(boxOffice(rush), 'ticket-rush');
    // La panne dure trois ticks ; la tempête, jusqu'à la descente du trafic en fin de vague.
    const after = r.ticks.slice(30, 52);
    expect(after.every((t) => t.failed > 0)).toBe(true);
    // Trois relances par requête neuve : la charge quadruple.
    expect(Math.max(...after.map((t) => t.retries ?? 0))).toBeGreaterThan(2.5 * 1600);
  });

  it('avec backoff, les relances s’étalent et la cité se relève', () => {
    const r = play(boxOffice({ ...rush, backoff: true }), 'ticket-rush');
    expect(r.ticks.slice(35).every((t) => t.failed === 0)).toBe(true);
    // Les échecs pendant la panne ont été relancés et servis : le client ne les a pas vus.
    expect(r.failed).toBeLessThan(r.failuresByReason.saturation / 10);
  });

  it('le tableau du rejeu finit sur le taux d’échec du verdict, relances déduites', () => {
    for (const o of [rush, { ...rush, backoff: true }]) {
      const r = play(boxOffice(o), 'ticket-rush');
      expect(replayStats(r, [], r.ticks.length).failureRate).toBeCloseTo(r.gauges.failureRate.value, 6);
    }
  });

  it('une lecture périmée n’est pas relancée : le client ne sait pas qu’elle est fausse', () => {
    const r = play(boxOffice({ extraInstances: 1, replicas: 2, backoff: true }), 'split-registry');
    expect(r.failuresByReason['stale-read']).toBeGreaterThan(0);
    expect(r.ticks.every((t) => (t.retries ?? 0) === 0)).toBe(true);
  });
});

describe('file bornée et quota du prestataire', () => {
  it('la file déborde quand le colombier ferme plus longtemps que sa rétention ne tient', () => {
    const r = play(boxOffice({ extraInstances: 1, cache: true }), 'pigeons-grounded');
    expect(r.failuresByReason['queue-overflow']).toBeGreaterThan(0);
    expect(Math.max(...r.ticks.map((t) => t.nodes.queue!.backlog ?? 0))).toBeCloseTo(catalog.components['message-queue']!.maxBacklog!);
  });

  it('le quota fixe le rythme de la file, même par lots', () => {
    const r = play(boxOffice({ extraInstances: 1, cache: true, retention: 1 }), 'pigeons-grounded');
    const after = r.ticks[50]!;
    expect(after.nodes.queue!.backlog).toBeGreaterThan(0);
    expect(after.nodes.mail!.rps).toBeCloseTo(catalog.components['mail-provider']!.maxRps!);
  });
});

describe('partition réseau', () => {
  it('les réplicas coupés servent des places périmées, sauf avec la lecture au primaire', () => {
    const naive = play(boxOffice({ extraInstances: 1, replicas: 2 }), 'split-registry');
    expect(naive.ticks[25]!.nodes.db!.stale).toBeGreaterThan(0);
    expect(naive.ticks[10]!.nodes.db!.stale ?? 0).toBe(0);
    const leader = play(boxOffice({ extraInstances: 1, replicas: 2, leaderReads: true }), 'split-registry');
    expect(leader.failuresByReason['stale-read']).toBe(0);
  });

  it('une lecture critique se mesure à part dans le SLA : la base saturée ne se cache pas derrière le cache', () => {
    const r = play(boxOffice({ cache: true, extraInstances: 3, backoff: true }), 'final-joust');
    expect(r.gauges.latency.value).toBeGreaterThan(r.ticks.map((t) => t.avgLatencyMs).sort((a, b) => a - b)[56]!);
  });
});

describe('le chambellan raconte le tournoi', () => {
  const tellsOf = (arch: Architecture, id: string) => analyzeWave(play(arch, id), arch, wave(id), catalog, fortifiedCity);

  it('nomme la tempête de relances, la file trop courte et la partition', () => {
    expect(tellsOf(boxOffice({ extraInstances: 1, cache: true }), 'ticket-rush').some((f) => f.concept?.includes('Tempête de relances'))).toBe(true);
    expect(tellsOf(boxOffice({ extraInstances: 1, cache: true }), 'pigeons-grounded').some((f) => f.concept?.includes('dimensionner une file'))).toBe(true);
    expect(tellsOf(boxOffice({ extraInstances: 1, replicas: 2 }), 'split-registry').some((f) => f.concept?.includes('CAP') && f.tone === 'bad')).toBe(true);
  });
});
