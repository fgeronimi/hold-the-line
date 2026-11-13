import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { newGame } from '../src/engine/game.ts';
import { minuteSpan, minutes } from '../src/ui/time.ts';
import { renderDialog, upgradePips, type ViewState } from '../src/ui/views.ts';

describe('le temps compressé (M7)', () => {
  it('un incident [from, until) se lit en minutes, de 1', () => {
    expect(minuteSpan(30, 33)).toBe('de la 31ᵉ à la 33ᵉ minute');
    expect(minuteSpan(0, 3)).toBe('de la 1ʳᵉ à la 3ᵉ minute');
    expect(minuteSpan(44, 45)).toBe('à la 45ᵉ minute');
    expect(minutes(1)).toBe('1 minute');
    expect(minutes(25)).toBe('25 minutes');
  });

  const briefing = (waveIndex: number): ViewState =>
    ({ catalog, scenario: urlShortener, game: { ...newGame(), waveIndex }, draft: { nodes: [], links: [] }, attempts: [], tool: { kind: 'select' }, phase: 'briefing', history: { undo: 0, redo: 0 } }) as unknown as ViewState;

  it('la règle est annoncée au premier briefing seulement, avec sa ligne « En vrai »', () => {
    const first = renderDialog(briefing(0));
    expect(first).toContain('un tick de simulation vaut une minute');
    expect(first).toContain('class="real"');
    expect(renderDialog(briefing(1))).not.toContain('un tick de simulation vaut une minute');
  });

  it('un incident annoncé se dit en minutes, jamais en ticks', () => {
    const html = renderDialog(briefing(1));
    expect(html).toContain('de la 31ᵉ à la 40ᵉ minute');
    expect(html).not.toMatch(/ticks? \d/);
  });

  it('les pastilles disent les délais en minutes, d’après les données', () => {
    expect(upgradePips({ id: 'app', type: 'app-server' }, catalog)).toContain('une instance démarre en 2 minutes');
    expect(upgradePips({ id: 'src', type: 'traffic-source' }, catalog)).toContain('relances étalées sur 15 minutes');
  });
});
