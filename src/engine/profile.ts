import type { Wave } from './types.ts';

export function factorAt(wave: Wave, tick: number): number {
  const base = wave.profile.find((seg) => tick < seg.until)?.factor ?? wave.profile.at(-1)?.factor ?? 1;
  return base * envelopeAt(wave, tick);
}

/** Courbe en S : une montée sans à-coup, ni au départ ni à l'arrivée. */
const smooth = (x: number) => {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
};

export function envelopeAt(wave: Wave, tick: number): number {
  if (!wave.ramp) return 1;
  const { up, down } = wave.ramp;
  let f = 1;
  if (up > 0 && tick < up) f = 0.25 + 0.75 * smooth((tick + 1) / up);
  const fromEnd = wave.ticks - tick;
  if (down > 0 && fromEnd <= down) f = Math.min(f, 1 - 0.6 * smooth((down - fromEnd + 1) / down));
  return f;
}
