/** Tout texte venant des données ou du joueur passe par ici avant d'entrer dans le HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/*
 * Formats partagés par le rendu et l'interface. Le moteur a les siens pour ses messages
 * (`src/engine/messages.ts`) : ils n'arrondissent pas pareil, on ne les mélange pas.
 */

/** Une part arrondie à l'unité, « 37 % » : ce qu'on lit d'un coup d'œil. */
export function percent(n: number): string {
  return `${Math.round(n * 100)} %`;
}

/** Une part à deux décimales, « 0.37 % » : un taux d'échec se joue souvent sous 1 %. */
export function percentPrecise(n: number): string {
  return `${(n * 100).toFixed(2)} %`;
}
