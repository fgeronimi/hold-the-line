import { attachChart, chartModel, renderChart } from './charts.ts';
import { nodeNames } from './theme.ts';
import type { Architecture, Catalog, Wave, WaveResult } from '../engine/types.ts';
import { KIND_NAMES } from '../engine/messages.ts';
import { escapeHtml } from './html.ts';
import { firstSaturations, replayStats } from './hud.ts';
import type { CityScene } from './scene.ts';
import type { Theme } from './theme.ts';
import { minuteSpan } from './time.ts';
import { JourneyWindow, OutcomeTally, RecentOutcomes, journeyDuration, journeysForTick, outcomeOf, trafficScale, type Outcome } from './traffic.ts';

export interface ReplayOptions {
  title: string;
  arch: Architecture;
  result: WaveResult;
  /** Pour les seuils du tableau de bord (SLA, budget). */
  wave: Wave;
  catalog: Catalog;
  theme: Theme;
  /** Appelé une fois, quand la vague arrive à son terme ou que le joueur la passe. */
  onEnd: () => void;
}

/** Ticks affichés par seconde à la vitesse ×1 : assez lent pour suivre un voyageur. */
const TICKS_PER_SECOND = 1.5;
/** À la première saturation d'un bâtiment, le rejeu ralentit pendant ces quelques secondes. */
const SLOW_MOTION = { seconds: 3, factor: 0.35 };

/**
 * Joue une vague sur le plateau : pose l'architecture jouée, ajoute la barre de la vague
 * en bas de l'écran et fait avancer le temps à chaque image. Ne recalcule rien : relit
 * `result.ticks`. Prévient par `onEnd` quand la vague est finie ; renvoie de quoi l'arrêter
 * et rendre le plateau à la construction.
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
    <span class="hud" data-r="hud"></span>
    <button data-r="recenter" title="Revoir tout le plateau">Recentrer</button>
    <button data-r="charts" title="Courbes minute par minute, bâtiment par bâtiment">📈 Courbes</button>
    <span class="replay-legend">${Object.values(o.theme.vehicles)
      .map((v) => `<i style="background:${v.color}"></i>${escapeHtml(v.metaphor)}`)
      .join(' ')}<i style="background:${o.theme.alert}"></i>${escapeHtml(o.theme.failed)}<i style="background:${o.theme.hostile.color}"></i>${escapeHtml(o.theme.hostile.metaphor)}</span>
    <button data-r="skip" title="Aller à la fin de la vague">Passer ⏭</button>`;
  barHost.appendChild(bar);
  const alert = document.createElement('div');
  alert.className = 'replay-alert';
  alert.hidden = true;
  barHost.appendChild(alert);

  const model = chartModel(o.result, o.arch, o.wave, o.catalog, o.theme);
  const panel = document.createElement('div');
  panel.className = 'replay-charts';
  panel.hidden = true;
  panel.innerHTML = renderChart(model, { live: true });
  barHost.appendChild(panel);
  const chart = attachChart(panel.querySelector('[data-chart="root"]')!, model, (tick) => {
    time = tick;
    seek.value = String(time);
    playing = false;
    play.textContent = '▶';
  });

  const $ = <T extends HTMLElement>(name: string) => bar.querySelector<T>(`[data-r="${name}"]`)!;
  const readout = $('readout');
  const hud = $('hud');
  const seek = $<HTMLInputElement>('seek');
  const play = $<HTMLButtonElement>('play');

  const scale = trafficScale(o.result.ticks);
  const timed = o.result.ticks.flatMap((t, i) => journeysForTick(t, i, scale)).map((j) => ({ j, end: j.start + journeyDuration(j) }));
  const outcomes: Outcome[] = timed
    .map(({ j }) => outcomeOf(j))
    .filter((o): o is Outcome => o !== undefined)
    .sort((a, b) => a.at - b.at);
  // Les trajets et les issues sont connus d'avance : des index évitent de tout refiltrer à chaque image.
  const journeys = new JourneyWindow(timed);
  const recent = new RecentOutcomes(outcomes);
  const tally = new OutcomeTally(outcomes);

  scene.setArchitecture(o.arch, o.catalog);
  scene.setMode('replay');
  scene.slaLatencyMs = o.wave.sla.maxP95LatencyMs;
  scene.slaLatencyByKind = o.wave.sla.maxP95LatencyMsByKind ?? {};

  // L'instant où la vague est perdue : la cloche sonne, les bords rougissent, la bannière tombe.
  const alarm = document.createElement('div');
  alarm.className = 'sla-alarm';
  alarm.hidden = true;
  barHost.appendChild(alarm);
  const latencyBreach = o.result.latencyBreachTick;
  // L'objectif rompu peut être propre à un type de requête (M4) : la bannière dit lequel.
  const brokenLatency = o.result.losses.find((l) => l.kind === 'latency');
  const latencyLabel = brokenLatency?.kind === 'latency' && brokenLatency.requestKind ? ` ${KIND_NAMES[brokenLatency.requestKind]}` : '';
  const latencyLimit = brokenLatency?.kind === 'latency' ? brokenLatency.limitMs : o.wave.sla.maxP95LatencyMs;
  const alarmText = {
    failures: `SLA rompu : plus de ${(o.wave.sla.maxFailureRate * 100).toFixed(0)} % d’échecs`,
    latency: `SLA rompu : latence p95${latencyLabel} au-delà de ${latencyLimit} ms`,
  };

  const typeOf = new Map(o.arch.nodes.map((n) => [n.id, n.type]));
  const nameOf = (id: string) => {
    const node = o.arch.nodes.find((n) => n.id === id);
    if (!node) return id;
    const { tech, metaphor } = nodeNames(node, o.catalog, o.theme);
    return `${tech}${metaphor ? ` (${metaphor})` : ''}`;
  };
  const alerts = firstSaturations(o.result.events);
  const incidents = o.result.events.flatMap((e) => {
    if (e.type !== 'incident-start') return [];
    const incident = o.wave.incidents?.find((i) => i.id === e.incident);
    const node = incident && o.arch.nodes.find((n) => n.type === incident.component)?.id;
    return incident ? [{ tick: e.tick, title: incident.title, node }] : [];
  });
  const shownIncidents = new Set<number>();
  const shown = new Set<string>();
  let slowFor = 0;
  let hudHtml = '';
  let readoutText = '';

  let time = 0;
  let playing = true;
  let speed = 1;
  let ended = false;
  const end = o.result.ticks.length;
  const finish = () => {
    if (ended) return;
    ended = true;
    alert.hidden = true;
    panel.hidden = true;
    o.onEnd();
  };

  /** Le premier goulot : bandeau, caméra sur le bâtiment, ralenti. Une fois par bâtiment. */
  // Un incident et le goulot qu'il provoque tombent souvent au même tick : un seul bandeau.
  const raiseAlerts = () => {
    const messages: string[] = [];
    let focus: string | undefined;
    incidents.forEach((i, k) => {
      if (i.tick > time || shownIncidents.has(k)) return;
      shownIncidents.add(k);
      messages.push(`⚡ Incident ${minuteSpan(i.tick, i.tick)} : ${i.title}.`);
      focus ??= i.node;
    });
    for (const a of alerts) {
      if (a.tick > time || shown.has(a.node)) continue;
      shown.add(a.node);
      messages.push(`⚠ ${nameOf(a.node)} sature ${minuteSpan(a.tick, a.tick)}.`);
      focus ??= a.node;
    }
    if (messages.length === 0) return;
    alert.textContent = messages.join(' ');
    alert.hidden = false;
    if (focus) scene.focusOn(focus);
    slowFor = SLOW_MOTION.seconds;
  };

  const renderHud = () => {
    const st = replayStats(o.result, tally, time);
    // Se cacher puis réapparaître rejoue l'animation : revenir avant le seuil la réarme.
    const breach = st.failureRate > o.wave.sla.maxFailureRate ? 'failures' : latencyBreach !== undefined && time >= latencyBreach ? 'latency' : undefined;
    alarm.hidden = breach === undefined;
    if (breach && alarm.dataset.breach !== breach) {
      alarm.dataset.breach = breach;
      alarm.innerHTML = `<div class="sla-banner"><span class="bell">🔔</span> ${alarmText[breach]}</div>`;
    }
    const { sla, budget } = o.wave;
    const cost = o.result.gauges.cost.value;
    const gauge = (label: string, value: string, bad: boolean) => `<span class="${bad ? 'ko' : ''}">${label} <b>${value}</b></span>`;
    const html = [
      gauge('échecs', `${(st.failureRate * 100).toFixed(2)} % / ${(sla.maxFailureRate * 100).toFixed(0)} %`, st.failureRate > sla.maxFailureRate),
      gauge('latence', `${Math.round(st.latencyMs)} / ${sla.maxP95LatencyMs} ms`, st.latencyMs > sla.maxP95LatencyMs),
      gauge('coût', `${Math.round(cost)} / ${budget}`, cost > budget),
      `<span class="ok">+${st.served} 👍</span> <span class="ko">−${st.refused} 👎</span>${st.repelled > 0 ? ` <span>🛡 ${st.repelled}</span>` : ''}`,
    ].join(' · ');
    // Le tableau de bord ne change qu'une fois par minute ou par issue : inutile de le réécrire à chaque image.
    if (html !== hudHtml) {
      hudHtml = html;
      hud.innerHTML = html;
    }
  };

  scene.onFrame = (dt) => {
    if (playing) {
      const slow = slowFor > 0 ? SLOW_MOTION.factor : 1;
      slowFor = Math.max(0, slowFor - dt);
      if (slowFor === 0) alert.hidden = true;
      time += dt * speed * slow * TICKS_PER_SECOND;
      if (time >= end) {
        time = end;
        playing = false;
        play.textContent = '▶';
        finish();
      }
      seek.value = String(time);
    }
    const tick = o.result.ticks[Math.min(Math.floor(time), end - 1)];
    scene.showTick(
      time,
      tick,
      journeys.at(time),
      recent.at(time),
    );
    if (tick) {
      const text = `minute ${Math.floor(Math.min(time, end - 1)) + 1}/${end} · ${Math.round(tick.offered)} req/s`;
      if (text !== readoutText) {
        readoutText = text;
        readout.textContent = text;
      }
    }
    // Une fois la vague finie, le debrief prend la place : plus de bandeau.
    if (!ended) raiseAlerts();
    renderHud();
    if (!panel.hidden) chart.setCursor(time);
  };

  const togglePlay = () => {
    if (!playing && time >= end) time = 0;
    playing = !playing;
    play.textContent = playing ? '⏸' : '▶';
  };
  const stop = () => {
    scene.onFrame = undefined;
    scene.focusOn(undefined);
    alert.remove();
    alarm.remove();
    panel.remove();
    scene.slaLatencyMs = undefined;
    scene.slaLatencyByKind = {};
    scene.showTick(0, undefined, []);
    scene.setMode('build');
    window.removeEventListener('keydown', onKey);
    bar.remove();
  };
  const onKey = (e: KeyboardEvent) => {
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
    // Revenir en arrière réarme les alertes des goulots pas encore atteints.
    for (const a of alerts) if (a.tick > time) shown.delete(a.node);
  });
  $('charts').addEventListener('click', () => (panel.hidden = !panel.hidden));
  $('recenter').addEventListener('click', () => {
    scene.focusOn(undefined);
    alert.hidden = true;
  });
  $('skip').addEventListener('click', () => {
    time = end;
    seek.value = String(end);
    finish();
  });
  window.addEventListener('keydown', onKey);
  return stop;
}
