import { describe, expect, it } from 'vitest';
import { market } from '../src/data/scenarios/market.ts';
import { envelopeAt } from '../src/engine/simulate.ts';

describe('montée et descente du trafic', () => {
  const wave = market.waves[0]!;

  it('part bas, monte sans à-coup, tient le plateau, puis retombe', () => {
    const f = Array.from({ length: wave.ticks }, (_, t) => envelopeAt(wave, t));
    expect(f[0]).toBeGreaterThan(0.25);
    expect(f[0]).toBeLessThan(0.3);
    for (let t = 1; t < 8; t++) expect(f[t]).toBeGreaterThan(f[t - 1]!);
    expect(f.slice(8, wave.ticks - 8).every((x) => x === 1)).toBe(true);
    expect(f.at(-1)).toBeCloseTo(0.4);
  });

  it('sans rampe, le trafic est à plein dès le premier tick', () => {
    const { ramp: _, ...flat } = wave;
    expect(envelopeAt(flat, 0)).toBe(1);
  });
});
