import { describe, expect, it } from 'vitest';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { fortifiedCity } from '../src/data/themes/fortified-city.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import { chartModel, renderChart, tickAt, tickX, tooltipRows } from '../src/render/charts.ts';

const wave = urlShortener.waves.find((w) => w.id === 'read-surge')!;
const model = chartModel(simulateWave(A.withCache, wave, catalog), A.withCache, wave, catalog, fortifiedCity);

describe('courbes tick par tick', () => {
  it('trafic, taux d’échec, puis un bâtiment par panneau dans l’ordre du trafic', () => {
    expect(model.panels.map((p) => p.id)).toEqual(['traffic', 'failure-rate', 'app', 'cache', 'db']);
    expect(model.panels.every((p) => p.values.length === 60)).toBe(true);
  });

  it('l’incident est une bande, et la base déborde pendant le cache froid', () => {
    expect(model.incidents).toEqual([{ from: 30, until: 33, title: 'Le cache redémarre à froid' }]);
    const db = model.panels.find((p) => p.id === 'db')!;
    expect(db.values[30]).toBeGreaterThan(1);
    expect(db.values[10]).toBeLessThan(0.2);
  });

  it('l’infobulle lit tous les panneaux au même tick, valeur d’abord', () => {
    const rows = tooltipRows(model, 30);
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => r.label === 'Database')!.value).toMatch(/%$/);
  });

  it('abscisse et tick se répondent', () => {
    for (const t of [0, 17, 59]) expect(tickAt(model, tickX(model, t))).toBe(t);
    expect(renderChart(model)).toContain('chart-incident');
  });
});
