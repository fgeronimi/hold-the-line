import { describe, expect, it } from 'vitest';
import { answersOf } from '../src/data/balance-space.ts';
import { catalog } from '../src/data/catalog.ts';
import { SCENARIOS } from '../src/data/scenarios/index.ts';
import { starsFor } from '../src/engine/score.ts';
import { simulateWave } from '../src/engine/simulate.ts';

/**
 * Les trois étoiles se gagnent toutes avec une architecture juste (E7, E9) : chaque vague doit
 * en avoir au moins une parmi ses réponses attendues. Sinon la vague ne peut jamais être
 * « parfaite » : c'est la réponse ou le calibrage qu'il faut revoir, pas l'étoile.
 */
describe('chaque vague peut se gagner avec ses trois étoiles', () => {
  for (const { scenario } of SCENARIOS) {
    scenario.waves.forEach((wave, i) => {
      it(`${scenario.id}, vague ${i + 1} (${wave.id})`, () => {
        const best = answersOf(scenario.id, i).map((arch) => starsFor(simulateWave(arch, wave, catalog), arch, wave, catalog));
        expect(best.some((s) => s.held && s.lean && s.thrifty), JSON.stringify(best)).toBe(true);
      });
    });
  }
});
