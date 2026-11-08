import type { Architecture, Catalog, WaveResult } from '../engine/types.ts';
import { escapeHtml } from './html.ts';
import type { CityScene } from './scene.ts';
import type { Theme } from './theme.ts';
import { journeyDuration, journeysForTick, outcomeOf, trafficScale, type Journey, type Outcome } from './traffic.ts';

export interface ReplayOptions {
  title: string;
  arch: Architecture;
  result: WaveResult;
  catalog: Catalog;
  theme: Theme;
  /** Appelé quand le joueur revient à la construction. */
  onClose: () => void;
}

/** Ticks affichés par seconde à la vitesse ×1 : assez lent pour suivre un voyageur. */
const TICKS_PER_SECOND = 1.5;

/**
 * Rejoue une vague sur le plateau de construction : pose l'architecture jouée, ajoute une
 * barre de lecture au-dessus du plateau et fait avancer le temps à chaque image. Ne
 * recalcule rien : relit `result.ticks`. Renvoie de quoi l'arrêter.
 */
export function startReplay(scene: CityScene, barHost: HTMLElement, o: ReplayOptions): () => void {
  const bar = document.createElement('div');
  bar.className = 'replay-bar';
  bar.innerHTML = `
    <b>${escapeHtml(o.title)}</b>
    <button data-r="play">⏸</button>
    <select data-r="speed"><option value="1">×1</option><option value="2">×2</option><option value="4">×4</option></select>
    <input data-r="seek" type="range" min="0" max="${o.result.ticks.length}" step="0.01" value="0">
    <span data-r="readout"></span>
    <span class="replay-legend">${Object.values(o.theme.vehicles)
      .map((v) => `<i style="background:${v.color}"></i>${escapeHtml(v.metaphor)}`)
      .join(' ')}<i style="background:${o.theme.alert}"></i>${escapeHtml(o.theme.failed)}<i style="background:${o.theme.hostile.color}"></i>${escapeHtml(o.theme.hostile.metaphor)}</span>
    <button data-r="close">Retour à la construction</button>`;
  barHost.appendChild(bar);

  const $ = <T extends HTMLElement>(name: string) => bar.querySelector<T>(`[data-r="${name}"]`)!;
  const readout = $('readout');
  const seek = $<HTMLInputElement>('seek');
  const play = $<HTMLButtonElement>('play');

  const scale = trafficScale(o.result.ticks);
  const journeys: { j: Journey; end: number }[] = o.result.ticks
    .flatMap((t, i) => journeysForTick(t, i, scale))
    .map((j) => ({ j, end: j.start + journeyDuration(j) }));
  const outcomes: Outcome[] = journeys
    .map(({ j }) => outcomeOf(j))
    .filter((o): o is Outcome => o !== undefined)
    .sort((a, b) => a.at - b.at);

  scene.setArchitecture(o.arch, o.catalog);
  scene.setMode('replay');

  let time = 0;
  let playing = true;
  let speed = 1;
  const end = o.result.ticks.length;

  scene.onFrame = (dt) => {
    if (playing) {
      time += dt * speed * TICKS_PER_SECOND;
      if (time >= end) {
        time = end;
        playing = false;
        play.textContent = '▶';
      }
      seek.value = String(time);
    }
    const tick = o.result.ticks[Math.min(Math.floor(time), end - 1)];
    scene.showTick(
      time,
      tick,
      journeys.filter(({ j, end }) => j.start <= time && end > time).map(({ j }) => j),
      outcomes.filter((o) => o.at <= time && o.at > time - 1),
    );
    if (tick) {
      readout.textContent =
        `tick ${Math.floor(Math.min(time, end - 1)) + 1}/${end} · ${Math.round(tick.offered)} req/s` +
        ` · ${Math.round(tick.failed)} en échec · ${Math.round(tick.avgLatencyMs)} ms`;
    }
  };

  const togglePlay = () => {
    if (!playing && time >= end) time = 0;
    playing = !playing;
    play.textContent = playing ? '⏸' : '▶';
  };
  const stop = () => {
    scene.onFrame = undefined;
    scene.showTick(0, undefined, []);
    scene.setMode('build');
    window.removeEventListener('keydown', onKey);
    bar.remove();
    o.onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') stop();
    if (e.key === ' ' && (e.target as HTMLElement).tagName !== 'INPUT') {
      e.preventDefault();
      togglePlay();
    }
  };

  play.addEventListener('click', togglePlay);
  $<HTMLSelectElement>('speed').addEventListener('change', (e) => (speed = Number((e.target as HTMLSelectElement).value)));
  seek.addEventListener('input', () => {
    time = Number(seek.value);
    playing = false;
    play.textContent = '▶';
  });
  $('close').addEventListener('click', stop);
  window.addEventListener('keydown', onKey);
  return stop;
}
