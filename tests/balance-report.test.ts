import { describe, expect, it } from 'vitest';
import { diffLines } from '../src/balance/report.ts';

describe('diffLines', () => {
  it('ne signale rien entre deux listes identiques', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('distingue lignes en moins et en plus', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual(['+ x', '- b']);
  });

  it('gère les ajouts et retraits en bout de liste', () => {
    expect(diffLines(['a'], ['a', 'b'])).toEqual(['+ b']);
    expect(diffLines(['a', 'b'], ['a'])).toEqual(['- b']);
  });
});
