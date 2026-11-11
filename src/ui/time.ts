/**
 * Le temps vu par le joueur (décision M7) : un tick vaut une minute, une vague montre une
 * heure. Le moteur compte en ticks, de 0 ; l'écran compte en minutes, de 1. Tout texte de
 * durée passe par ici plutôt que d'écrire « tick » ou « seconde » en dur.
 */

/** Rang d'une minute : « 1ʳᵉ », « 31ᵉ ». */
export const ordinalMinute = (n: number): string => `${n === 1 ? '1ʳᵉ' : `${n}ᵉ`} minute`;

/** La minute affichée d'un tick du moteur (le tick 0 est la 1ʳᵉ minute). */
export const minuteOfTick = (tick: number): number => tick + 1;

/** Un incident `[from, until)` en ticks : « de la 31ᵉ à la 33ᵉ minute », ou « à la 31ᵉ minute ». */
export function minuteSpan(from: number, until: number): string {
  const first = minuteOfTick(from);
  if (until <= first) return `à la ${ordinalMinute(first)}`;
  const last = ordinalMinute(until);
  return `de la ${first === 1 ? '1ʳᵉ' : `${first}ᵉ`} à la ${last}`;
}

/** Une durée en minutes : « 1 minute », « 25 minutes ». */
export const minutes = (n: number): string => `${n} minute${n > 1 ? 's' : ''}`;
