import { validateArchitecture } from '../engine/validate.ts';
import type { Architecture, Catalog, Wave, WaveResult } from '../engine/types.ts';
import { escapeHtml } from './html.ts';
import { nodeNames, type Theme } from './theme.ts';

/**
 * Courbes tick par tick d'une vague : le trafic, le taux d'échec cumulé face au SLA, puis
 * la charge de chaque bâtiment, dans l'ordre du trafic. Une seule figure, un seul axe des
 * ticks : un réticule les lit toutes au même instant. Le modèle est pur et testé ; le
 * rendu est une chaîne SVG, l'interaction un peu de DOM.
 */

export interface ChartPanel {
  id: string;
  title: string;
  subtitle: string;
  unit: '%' | 'req/s';
  values: number[];
  /** Haut de l'échelle : au-delà, la courbe est écrêtée (une panne affiche 1 000 %). */
  top: number;
  /** Ligne de seuil : la capacité (100 %) ou le SLA. */
  threshold?: { value: number; label: string };
  /** Débit reçu par tick (req/s), lu à côté de la charge : de quoi refaire le calcul de capacité. */
  rps?: number[];
  /** Échecs par tick, dessinés en barres sous la courbe. */
  failed?: number[];
  /** Ce que l'infobulle ajoute à la valeur, tick par tick. */
  notes: string[][];
  peak: number;
}

export interface ChartModel {
  ticks: number;
  panels: ChartPanel[];
  incidents: { from: number; until: number; title: string }[];
}

const pct = (n: number) => `${Math.round(n * 100)} %`;
const num = (n: number) => (n === 0 ? '0' : Math.abs(n) >= 100 ? String(Math.round(n)) : n.toFixed(n < 10 ? 1 : 0));

export function chartModel(result: WaveResult, arch: Architecture, wave: Wave, catalog: Catalog, theme: Theme): ChartModel {
  const ticks = result.ticks;
  const n = ticks.length;

  const offered = ticks.map((t) => t.offered);
  let counted = 0;
  let failedSoFar = 0;
  const failureRate = ticks.map((t) => {
    const shed = Object.values(t.nodes).reduce((a, x) => a + (x.shed ?? 0), 0);
    counted += t.offered - shed;
    failedSoFar += t.failed;
    return counted > 0 ? failedSoFar / counted : 0;
  });
  const sla = wave.sla.maxFailureRate;

  const panels: ChartPanel[] = [
    {
      id: 'traffic',
      title: 'Trafic',
      subtitle: 'requêtes par seconde',
      unit: 'req/s',
      values: offered,
      top: Math.max(1, ...offered) * 1.1,
      failed: ticks.map((t) => t.failed),
      notes: ticks.map((t) => [`${num(t.failed)} req/s en échec`]),
      peak: Math.max(0, ...offered),
    },
    {
      id: 'failure-rate',
      title: 'Taux d’échec cumulé',
      subtitle: `face au SLA (${pct(sla)})`,
      unit: '%',
      values: failureRate,
      top: Math.max(sla * 2, ...failureRate) * 1.1,
      threshold: { value: sla, label: 'SLA' },
      notes: ticks.map(() => []),
      peak: Math.max(0, ...failureRate),
    },
  ];

  const validation = validateArchitecture(arch, catalog);
  const order = validation.ok ? validation.order : arch.nodes.map((x) => x.id);
  for (const id of order) {
    const node = arch.nodes.find((x) => x.id === id);
    if (!node || catalog.components[node.type]?.behavior === 'source') continue;
    const load = ticks.map((t) => t.nodes[id]?.utilization ?? 0);
    panels.push({
      rps: ticks.map((t) => t.nodes[id]?.rps ?? 0),
      id,
      title: nodeNames(node, catalog, theme).tech,
      subtitle: nodeNames(node, catalog, theme).metaphor,
      unit: '%',
      values: load,
      top: Math.min(2, Math.max(1.2, ...load) * 1.05),
      threshold: { value: 1, label: 'capacité' },
      failed: ticks.map((t) => t.nodes[id]?.failed ?? 0),
      notes: ticks.map((t) => {
        const x = t.nodes[id];
        if (!x) return [];
        return [
          ...(x.down ? [`⚡ ${x.down} instance${x.down > 1 ? 's' : ''} en panne`] : []),
          ...(x.instances !== undefined && x.instances > 1 ? [`${x.instances} instances`] : []),
          ...(x.backlog ? [`${num(x.backlog)} messages en attente`] : []),
          ...(x.failed > 0 ? [`${num(x.failed)} req/s en échec`] : []),
        ];
      }),
      peak: Math.max(0, ...load),
    });
  }

  const incidents = (wave.incidents ?? [])
    .filter((i) => arch.nodes.some((x) => x.type === i.component))
    .map((i) => ({ from: i.from, until: Math.min(i.until, n), title: i.title }));
  return { ticks: n, panels, incidents };
}

/** Géométrie partagée par le rendu et l'interaction. */
export const CHART = { width: 640, left: 150, right: 12, top: 18, plot: 46, strip: 12, gap: 14, axis: 18 };

const panelHeight = (p: ChartPanel) => CHART.plot + (p.failed ? CHART.strip + 2 : 0) + CHART.gap;
export const chartHeight = (m: ChartModel) => CHART.top + m.panels.reduce((a, p) => a + panelHeight(p), 0) + CHART.axis;

/** Abscisse du milieu d'un tick. */
export function tickX(m: ChartModel, tick: number): number {
  const w = CHART.width - CHART.left - CHART.right;
  return CHART.left + ((tick + 0.5) / Math.max(1, m.ticks)) * w;
}

/** Tick sous une abscisse, borné à la vague. */
export function tickAt(m: ChartModel, x: number): number {
  const w = CHART.width - CHART.left - CHART.right;
  return Math.max(0, Math.min(m.ticks - 1, Math.floor(((x - CHART.left) / w) * m.ticks)));
}

/** Une charge de 10 (1 000 %) est celle d'un bâtiment sans instance en service. */
function format(p: ChartPanel, v: number): string {
  if (p.unit === 'req/s') return `${num(v)} req/s`;
  if (p.id === 'failure-rate') return `${(v * 100).toFixed(2)} %`;
  return v >= 10 ? 'hors service' : pct(v);
}

/** La lecture d'un tick : la charge d'un bâtiment vient avec le débit qui la produit. */
export function readingAt(p: ChartPanel, tick: number): string {
  const v = format(p, p.values[tick] ?? 0);
  return p.rps ? `${num(p.rps[tick] ?? 0)} req/s · charge ${v}` : v;
}

/** Le pic d'une vague jouée : la plus forte charge, et le plus fort débit reçu. */
function peakReading(p: ChartPanel): string {
  return p.rps ? `pic ${format(p, p.peak)} · ${num(Math.max(0, ...p.rps))} req/s` : `pic ${format(p, p.peak)}`;
}

/** Les ids SVG sont globaux au document : deux figures affichées ne doivent pas partager leurs clipPath. */
let renders = 0;

/**
 * `live` : la figure se dévoile au fil de la vague. Un voile cache tout ce qui suit le
 * curseur, et les pics ne sont pas annoncés : on découvre les échecs quand ils arrivent.
 */
export function renderChart(m: ChartModel, opts: { live?: boolean } = {}): string {
  const uid = `c${++renders}`;
  const H = chartHeight(m);
  const x0 = CHART.left;
  const x1 = CHART.width - CHART.right;
  const step = (x1 - x0) / Math.max(1, m.ticks);
  let y = CHART.top;
  const parts: string[] = [];
  // Les repères d'échelle passent au-dessus du voile : ils ne disent rien de ce qui va arriver.
  const scales: string[] = [];

  // Les incidents d'abord, sous tout le reste, sur toute la hauteur.
  for (const i of m.incidents) {
    const xa = x0 + i.from * step;
    parts.push(
      `<rect class="chart-incident" x="${xa}" y="${CHART.top - 4}" width="${(i.until - i.from) * step}" height="${H - CHART.top - CHART.axis + 4}"/>`,
      // Près du bord droit, l'étiquette s'aligne sur la fin de la bande pour ne pas sortir du cadre.
      xa > (x0 + x1) / 2
        ? `<text class="chart-incident-label" x="${xa + (i.until - i.from) * step}" y="${CHART.top - 6}" text-anchor="end">⚡ ${escapeHtml(i.title)}</text>`
        : `<text class="chart-incident-label" x="${xa + 3}" y="${CHART.top - 6}">⚡ ${escapeHtml(i.title)}</text>`,
    );
  }

  m.panels.forEach((p, k) => {
    const yTop = y;
    const yBottom = y + CHART.plot;
    const scale = (v: number) => yBottom - (Math.min(v, p.top) / p.top) * CHART.plot;
    const points = p.values.map((v, t) => `${(x0 + (t + 0.5) * step).toFixed(1)},${scale(v).toFixed(1)}`).join(' ');

    parts.push(
      `<text class="chart-title" x="0" y="${yTop + 12}">${escapeHtml(p.title)}</text>`,
      `<text class="chart-subtitle" x="0" y="${yTop + 25}">${escapeHtml(p.subtitle)}</text>`,
      // En direct, la valeur du tick joué ; après coup, le pic de la vague.
      opts.live
        ? `<text class="chart-now" data-chart="now" data-panel="${k}" x="0" y="${yTop + 38}">${escapeHtml(readingAt(p, 0))}</text>`
        : `<text class="chart-peak" x="0" y="${yTop + 38}">${escapeHtml(peakReading(p))}</text>`,
      `<line class="chart-base" x1="${x0}" x2="${x1}" y1="${yBottom}" y2="${yBottom}"/>`,
    );
    // L'échelle, à gauche dans le tracé : le seuil quand il y en a un, sinon le haut de l'axe.
    if (!p.threshold) scales.push(`<text class="chart-scale" x="${x0 + 3}" y="${yTop + 8}">${escapeHtml(format(p, p.top))}</text>`);
    if (p.threshold) {
      const ty = scale(p.threshold.value);
      parts.push(`<line class="chart-threshold" x1="${x0}" x2="${x1}" y1="${ty}" y2="${ty}"/>`);
      scales.push(`<text class="chart-threshold-label" x="${x0 + 3}" y="${ty - 3}">${escapeHtml(`${p.threshold.label} ${format(p, p.threshold.value)}`)}</text>`);
      // Au-dessus du seuil, la même courbe repasse en rouge : on voit d'un coup d'œil quand ça déborde.
      parts.push(
        `<clipPath id="${uid}-over-${k}"><rect x="${x0}" y="${yTop - 2}" width="${x1 - x0}" height="${ty - yTop + 2}"/></clipPath>`,
        `<polyline class="chart-line" points="${points}"/>`,
        `<polyline class="chart-line over" points="${points}" clip-path="url(#${uid}-over-${k})"/>`,
      );
    } else {
      parts.push(`<polyline class="chart-line" points="${points}"/>`);
    }
    y = yBottom;

    if (p.failed) {
      const max = Math.max(...p.failed);
      const sy = y + 2;
      if (max > 0) {
        p.failed.forEach((f, t) => {
          if (f <= 0) return;
          const h = Math.max(1.5, (f / max) * CHART.strip);
          parts.push(`<rect class="chart-failed" x="${(x0 + t * step + 0.5).toFixed(1)}" y="${(sy + CHART.strip - h).toFixed(1)}" width="${Math.max(1, step - 1).toFixed(1)}" height="${h.toFixed(1)}"/>`);
        });
      }
      parts.push(`<text class="chart-strip-label" x="${x0 - 4}" y="${sy + CHART.strip - 2}" text-anchor="end">échecs</text>`);
      y = sy + CHART.strip;
    }
    y += CHART.gap;
  });

  const axisY = H - CHART.axis + 12;
  for (let t = 0; t <= m.ticks; t += 10) {
    parts.push(`<text class="chart-axis" x="${x0 + t * step}" y="${axisY}" text-anchor="middle">${t === 0 ? 'tick 0' : t}</text>`);
  }
  if (opts.live) {
    parts.push(`<rect class="chart-veil" data-chart="veil" x="${x0}" y="${CHART.top - 20}" width="${x1 - x0 + CHART.right}" height="${H - CHART.top + 20 - CHART.axis}"/>`);
  }
  parts.push(...scales);
  parts.push(
    `<line class="chart-cursor" data-chart="cursor" x1="${x0}" x2="${x0}" y1="${CHART.top - 4}" y2="${H - CHART.axis}" visibility="hidden"/>`,
    `<line class="chart-hair" data-chart="hair" x1="${x0}" x2="${x0}" y1="${CHART.top - 4}" y2="${H - CHART.axis}" visibility="hidden"/>`,
    `<rect class="chart-hit" data-chart="hit" x="${x0}" y="0" width="${x1 - x0}" height="${H}"/>`,
  );

  return `<div class="chart" data-chart="root">
    <svg viewBox="0 0 ${CHART.width} ${H}" role="img" aria-label="Courbes de la vague, tick par tick">${parts.join('')}</svg>
    <div class="chart-tip" data-chart="tip" hidden></div>
  </div>`;
}

/** Les lignes de l'infobulle d'un tick : la valeur d'abord, puis le nom. */
export function tooltipRows(m: ChartModel, tick: number): { value: string; label: string; notes: string[] }[] {
  return m.panels.map((p) => ({ value: readingAt(p, tick), label: p.title, notes: p.notes[tick] ?? [] }));
}

/**
 * Réticule et infobulle au survol, clic pour aller à un tick, curseur piloté de
 * l'extérieur. Les textes passent par `textContent` : jamais de HTML venu des données.
 */
export function attachChart(root: HTMLElement, m: ChartModel, onSeek?: (tick: number) => void): { setCursor: (time: number) => void } {
  const svg = root.querySelector('svg')!;
  const hit = root.querySelector<SVGRectElement>('[data-chart="hit"]')!;
  const hair = root.querySelector<SVGLineElement>('[data-chart="hair"]')!;
  const cursor = root.querySelector<SVGLineElement>('[data-chart="cursor"]')!;
  const tip = root.querySelector<HTMLElement>('[data-chart="tip"]')!;
  const veil = root.querySelector<SVGRectElement>('[data-chart="veil"]');
  const now = [...root.querySelectorAll<SVGTextElement>('[data-chart="now"]')];
  // Sous un voile, on ne lit ni ne saute au-delà de ce qui a déjà été joué.
  let revealed = veil ? 0 : m.ticks - 1;

  const toSvgX = (e: PointerEvent) => {
    const box = svg.getBoundingClientRect();
    return ((e.clientX - box.left) / box.width) * CHART.width;
  };

  hit.addEventListener('pointermove', (e) => {
    const tick = Math.min(revealed, tickAt(m, toSvgX(e)));
    const x = tickX(m, tick);
    hair.setAttribute('x1', String(x));
    hair.setAttribute('x2', String(x));
    hair.setAttribute('visibility', 'visible');

    tip.replaceChildren();
    const head = document.createElement('b');
    head.textContent = `Tick ${tick + 1}`;
    tip.append(head);
    for (const row of tooltipRows(m, tick)) {
      const line = document.createElement('div');
      const value = document.createElement('strong');
      value.textContent = row.value;
      const label = document.createElement('span');
      label.textContent = ` ${row.label}${row.notes.length > 0 ? ` · ${row.notes.join(' · ')}` : ''}`;
      line.append(value, label);
      tip.append(line);
    }
    // Position fixe : le panneau qui défile ne coupe pas l'infobulle.
    tip.hidden = false;
    const left = e.clientX > window.innerWidth / 2 ? e.clientX - tip.offsetWidth - 14 : e.clientX + 14;
    const top = Math.min(e.clientY - 20, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, top)}px`;
  });
  hit.addEventListener('pointerleave', () => {
    hair.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
  if (onSeek) {
    hit.style.cursor = 'pointer';
    hit.addEventListener('click', (e) => onSeek(Math.min(revealed, tickAt(m, toSvgX(e as PointerEvent)))));
  }

  return {
    setCursor(time: number) {
      const w = CHART.width - CHART.left - CHART.right;
      const x = CHART.left + (Math.min(time, m.ticks) / Math.max(1, m.ticks)) * w;
      cursor.setAttribute('x1', String(x));
      cursor.setAttribute('x2', String(x));
      cursor.setAttribute('visibility', 'visible');
      if (veil) {
        revealed = Math.max(0, Math.min(m.ticks - 1, Math.floor(time)));
        veil.setAttribute('x', String(x));
        veil.setAttribute('width', String(Math.max(0, CHART.width - x)));
      }
      for (const el of now) el.textContent = readingAt(m.panels[Number(el.dataset.panel)]!, revealed);
    },
  };
}
