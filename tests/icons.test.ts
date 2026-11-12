import { describe, expect, it } from 'vitest';
import { icon, type IconName } from '../src/ui/icons.ts';
import { SPRITE, SPRITE_NAMES } from '../src/ui/sprite.ts';

describe('pictogrammes (I18)', () => {
  it('chaque nom a son symbole dans le sprite', () => {
    const missing = SPRITE_NAMES.filter((n) => !SPRITE.includes(`<symbol id="hl-${n}"`));
    expect(missing).toEqual([]);
  });

  it('chaque renvoi du sprite vise un identifiant qu’il définit', () => {
    const ids = new Set([...SPRITE.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const refs = [...SPRITE.matchAll(/(?:href="#|url\(#)([^")]+)/g)].map((m) => m[1]!);
    expect(refs.filter((r) => !ids.has(r))).toEqual([]);
  });

  it('un pictogramme renvoie à son symbole, « rétablir » à « annuler » en miroir', () => {
    expect(icon('coin')).toContain('href="#hl-coin"');
    expect(icon('redo' as IconName)).toContain('href="#hl-undo"');
    expect(icon('redo' as IconName)).toContain('scale(-1 1)');
  });

  it('chaque évolution du catalogue a son pictogramme dans le sprite', async () => {
    const { catalog } = await import('../src/data/catalog.ts');
    const { fortifiedCity } = await import('../src/data/themes/fortified-city.ts');
    const missing = Object.keys(catalog.upgrades).filter((id) => !(SPRITE_NAMES as readonly string[]).includes(fortifiedCity.upgradeIcons[id] ?? ''));
    expect(missing).toEqual([]);
  });
});
