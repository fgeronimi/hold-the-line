import type { Architecture } from '../engine/types.ts';

/**
 * Annuler et rétablir, pendant la construction. Pas sauvegardé : une session qui recommence
 * repart de son brouillon. Vidé dès que le brouillon change de nature (vague lancée, autre
 * scénario, retour en arrière dans la partie) : c'est `main.ts` qui appelle `emptyHistory`.
 */
export interface History {
  readonly undo: readonly Architecture[];
  readonly redo: readonly Architecture[];
}

export const MAX_UNDO = 50;

export const emptyHistory: History = { undo: [], redo: [] };

export const historyCounts = (h: History) => ({ undo: h.undo.length, redo: h.redo.length });

/** Un pas de construction : le brouillon d'avant passe sur la pile, et l'avenir s'efface. */
export function remember(h: History, previous: Architecture): History {
  const undo = [...h.undo, previous];
  if (undo.length > MAX_UNDO) undo.shift();
  return { undo, redo: [] };
}

/**
 * Le brouillon d'avant (`undo`) ou d'après (`redo`), et la pile où va le brouillon courant.
 * Hors construction (vague, debrief), rien ne bouge : un ⌘Z égaré ne doit pas coûter un pas.
 */
export function travel(h: History, direction: 'undo' | 'redo', current: Architecture, building: boolean): { history: History; draft?: Architecture } {
  const from = direction === 'undo' ? h.undo : h.redo;
  const draft = from.at(-1);
  if (!draft || !building) return { history: h };
  const rest = from.slice(0, -1);
  return direction === 'undo'
    ? { history: { undo: rest, redo: [...h.redo, current] }, draft }
    : { history: { undo: [...h.undo, current], redo: rest }, draft };
}
