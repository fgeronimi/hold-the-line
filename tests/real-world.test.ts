import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import { realWorldComponents, realWorldUpgrades } from '../src/data/real-world.ts';

describe('lignes « en vrai » des fiches (D3b)', () => {
  it('chaque bâtiment du catalogue a la sienne, sauf la source', () => {
    const missing = Object.values(catalog.components)
      .filter((c) => c.behavior !== 'source' && !realWorldComponents[c.id])
      .map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it('ne parle que de bâtiments et d’évolutions qui existent, et cite des sources en https', () => {
    expect(Object.keys(realWorldComponents).filter((id) => !catalog.components[id])).toEqual([]);
    expect(Object.keys(realWorldUpgrades).filter((id) => !catalog.upgrades[id])).toEqual([]);
    const sources = [...Object.values(realWorldComponents), ...Object.values(realWorldUpgrades)].flatMap((r) => (r.source ? [r.source.url] : []));
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((u) => u.startsWith('https://'))).toBe(true);
  });
});
