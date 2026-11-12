import { describe, expect, it } from 'vitest';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import type { Architecture } from '../src/engine/types.ts';
import { emptyHistory, historyCounts, MAX_UNDO, remember, travel } from '../src/ui/history.ts';

const draft = (i: number): Architecture => ({ nodes: [{ id: `n${i}`, type: 'cache' }], links: [] });

describe('annuler et rétablir', () => {
  it('annuler puis rétablir revient au même brouillon', () => {
    const h = remember(emptyHistory, A.minimal);
    const back = travel(h, 'undo', A.withCache, true);
    expect(back.draft).toBe(A.minimal);
    expect(historyCounts(back.history)).toEqual({ undo: 0, redo: 1 });
    const forth = travel(back.history, 'redo', back.draft!, true);
    expect(forth.draft).toBe(A.withCache);
    expect(historyCounts(forth.history)).toEqual({ undo: 1, redo: 0 });
  });

  it('un nouveau pas efface ce qu’on pouvait rétablir', () => {
    const back = travel(remember(emptyHistory, A.minimal), 'undo', A.withCache, true);
    expect(historyCounts(remember(back.history, A.minimal))).toEqual({ undo: 1, redo: 0 });
  });

  it('la pile est bornée : les plus vieux pas tombent', () => {
    let h = emptyHistory;
    for (let i = 0; i < MAX_UNDO + 5; i++) h = remember(h, draft(i));
    expect(h.undo).toHaveLength(MAX_UNDO);
    expect(h.undo[0]).toEqual(draft(5));
  });

  it('rien à annuler : rien ne change', () => {
    expect(travel(emptyHistory, 'undo', A.minimal, true)).toEqual({ history: emptyHistory });
  });

  it('hors construction, rien ne bouge : le pas reste à annuler', () => {
    const step = travel(remember(emptyHistory, A.minimal), 'undo', A.withCache, false);
    expect(step.draft).toBeUndefined();
    expect(historyCounts(step.history)).toEqual({ undo: 1, redo: 0 });
  });
});
