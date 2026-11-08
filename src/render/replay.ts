import type { Architecture, Catalog, WaveResult } from '../engine/types.ts';
import { escapeHtml } from './html.ts';
import { layoutArchitecture } from './layout.ts';
import { CityScene } from './scene.ts';
import type { Theme } from './theme.ts';
import { failuresForTick, trafficScale, vehiclesForTick, type Vehicle } from './traffic.ts';

export interface ReplayOptions {
  title: string;
  arch: Architecture;
  result: WaveResult;
  catalog: Catalog;
  theme: Theme;
  /** Racine du site, d'où sont servis les modèles (`public/models/`). */
  baseUrl: string;
}

/** Ticks affichés par seconde à la vitesse ×1 : assez lent pour suivre un véhicule. */
const TICKS_PER_SECOND = 1.5;

/**
 * Ouvre le rejeu d'une vague dans un calque plein écran et renvoie de quoi le fermer.
 * Le rejeu ne recalcule rien : il relit `result.ticks`.
 */
export function openReplay(host: HTMLElement, o: ReplayOptions): () => void {
  const overlay = document.createElement('div');
  overlay.className = 'replay';
  overlay.innerHTML = `
    <div class="replay-bar">
      <b>${escapeHtml(o.title)}</b>
      <button data-r="play">⏸</button>
      <select data-r="speed"><option value="1">×1</option><option value="2">×2</option><option value="4">×4</option></select>
      <input data-r="seek" type="range" min="0" max="${o.result.ticks.length}" step="0.01" value="0">
      <span data-r="readout"></span>
      <span class="replay-legend">${Object.values(o.theme.vehicles)
        .map((v) => `<i style="background:${v.color}"></i>${escapeHtml(v.metaphor)}`)
        .join(' ')}<i style="background:${o.theme.alert}"></i>${escapeHtml(o.theme.failed)}<i style="background:${o.theme.hostile.color}"></i>${escapeHtml(o.theme.hostile.metaphor)}</span>
      <button data-r="close">Fermer</button>
    </div>
    <div class="replay-stage"><p class="replay-loading">Chargement de la cité…</p></div>`;
  host.appendChild(overlay);

  const $ = <T extends HTMLElement>(name: string) => overlay.querySelector<T>(`[data-r="${name}"]`)!;
  const stage = overlay.querySelector<HTMLElement>('.replay-stage')!;
  let scene: CityScene | undefined;
  let closed = false;

  const roundTrips = new Set(
    o.arch.links
      .filter((l) => {
        const type = o.arch.nodes.find((n) => n.id === l.to)?.type;
        return type !== undefined && o.catalog.components[type]?.lookaside === true;
      })
      .map((l) => `${l.from}→${l.to}`),
  );
  const scale = trafficScale(o.result.ticks);
  const vehicles: Vehicle[] = o.result.ticks.flatMap((t, i) => [
    ...vehiclesForTick(t, i, scale, roundTrips),
    ...failuresForTick(t, i, scale),
  ]);

  let time = 0;
  let playing = true;
  let speed = 1;
  let last = performance.now();
  let frame = 0;

  const end = o.result.ticks.length;
  const readout = $('readout');
  const seek = $<HTMLInputElement>('seek');
  const play = $<HTMLButtonElement>('play');

  const loop = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
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
    // Les véhicules partis jusqu'à 7 ticks plus tôt peuvent encore rouler (aller-retour lent).
    const nearby = vehicles.filter((v) => v.start <= time && v.start > time - 7);
    scene?.update(time, tick, nearby);
    if (tick) {
      readout.textContent =
        `tick ${Math.floor(Math.min(time, end - 1)) + 1}/${end} · ${Math.round(tick.offered)} req/s` +
        ` · ${Math.round(tick.failed)} en échec · ${Math.round(tick.avgLatencyMs)} ms`;
    }
    frame = requestAnimationFrame(loop);
  };
  // Les modèles se chargent pendant que le calque est déjà ouvert ; la lecture démarre ensuite.
  CityScene.create(stage, o.arch, o.catalog, o.theme, layoutArchitecture(o.arch), o.baseUrl)
    .then((s) => {
      if (closed) return s.dispose();
      stage.querySelector('.replay-loading')?.remove();
      scene = s;
      last = performance.now();
      frame = requestAnimationFrame(loop);
    })
    .catch((e: unknown) => {
      stage.querySelector('.replay-loading')!.textContent = `Impossible de charger la cité : ${String(e)}`;
    });

  const close = () => {
    closed = true;
    cancelAnimationFrame(frame);
    window.removeEventListener('keydown', onKey);
    scene?.dispose();
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    }
  };
  const togglePlay = () => {
    if (!playing && time >= end) time = 0;
    playing = !playing;
    play.textContent = playing ? '⏸' : '▶';
  };

  play.addEventListener('click', togglePlay);
  $<HTMLSelectElement>('speed').addEventListener('change', (e) => (speed = Number((e.target as HTMLSelectElement).value)));
  seek.addEventListener('input', () => {
    time = Number(seek.value);
    playing = false;
    play.textContent = '▶';
  });
  $('close').addEventListener('click', close);
  window.addEventListener('keydown', onKey);
  return close;
}
