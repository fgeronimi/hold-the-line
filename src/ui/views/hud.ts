import { migrationCost } from '../../engine/budget.ts';
import type { Wave } from '../../engine/types.ts';
import { draftInfo } from '../draft.ts';
import { decimal as fmt, esc, theme, totalScore, totalStars, type ViewState } from './common.ts';

const KIND_ICONS: Record<string, string> = { read: '📖', write: '✍️', async: '✉️' };

/** Le trafic de la vague à son plus fort, par type : ce que le joueur doit dimensionner. */
function trafficPeak(wave: Wave): string {
  const peak = Math.max(...wave.profile.map((p) => p.factor));
  return (['read', 'write', 'async'] as const)
    .map((k) => ({ k, rps: wave.sources.reduce((a, src) => a + (src.rps[k] ?? 0), 0) * peak }))
    .filter((x) => x.rps > 0)
    .map((x) => `${KIND_ICONS[x.k]} ${fmt(x.rps)}`)
    .join(' · ');
}

const gauge = (icon: string, label: string, value: string, bad: boolean) =>
  `<span class="gauge${bad ? ' ko' : ''}" title="${esc(label)}">${icon} ${value}</span>`;

/** Les jauges de la construction : facture et complexité prévues face aux plafonds, trafic, SLA. */
function buildGauges(s: ViewState, wave: Wave): string {
  const info = draftInfo(s.draft, s.catalog);
  const cost = info.cost + migrationCost(s.game.committed, s.draft, s.catalog);
  const complexity = info.complexity;
  const sla = `${(wave.sla.maxFailureRate * 100).toFixed(0)} % · ${wave.sla.maxP95LatencyMs} ms`;
  return [
    gauge('💰', 'Coût de la vague / budget', `${fmt(cost)} / ${wave.budget}`, cost > wave.budget),
    gauge('⚙️', 'Complexité / plafond', `${complexity} / ${wave.complexityCap}`, complexity > wave.complexityCap),
    gauge('🧍', 'Trafic au plus fort de la vague, en requêtes par seconde : lectures, écritures, événements', trafficPeak(wave), false),
    gauge('🎯', 'SLA : échecs max, latence p95 max', sla, false),
  ].join('');
}

function renderMenu(s: ViewState): string {
  const rewinds = s.game.history
    .slice(0, s.game.waveIndex)
    .map((_, i) => `<button data-action="rewind" data-wave="${i}">Revenir à la vague ${i + 1}</button>`)
    .join('');
  return `<div class="menu panel">
        <button data-action="choose-scenario">Changer de scénario</button>
        <button data-action="reset-game">Nouvelle partie</button>
        ${rewinds}
        <button data-action="toggle-debug">${s.debug ? 'Quitter' : 'Ouvrir'} le mode debug</button>
      </div>`;
}

/** La barre du haut : la vague, ce que coûte la cité en construction, le score, le menu. */
export function renderHud(s: ViewState): string {
  // Pendant la vague et son debrief, on montre la vague jouée : la partie, elle, a déjà avancé.
  const playing = s.phase === 'wave' || s.phase === 'debrief' ? s.attempts.find((x) => x.id === s.current) : undefined;
  const shownIndex = playing?.waveIndex ?? s.game.waveIndex;
  const wave = s.scenario.waves[shownIndex];
  const n = s.scenario.waves.length;
  const building = s.phase !== 'wave' && s.phase !== 'debrief' && s.phase !== 'choose';
  const gauges = wave && building ? buildGauges(s, wave) : '';
  const menu = s.showMenu ? renderMenu(s) : '';
  const title = wave ? `Vague ${shownIndex + 1}/${n} — ${esc(wave.title)}` : 'Partie terminée';
  const briefing = wave ? `<button data-action="show-briefing" title="Revoir le briefing">${theme.narrator.icon}</button>` : '';
  return `
    <div class="hud-bar panel">
      <div class="hud-title"><b>${esc(s.scenario.subtitle)}</b>
        <span>${title}</span></div>
      <div class="hud-gauges">${gauges}</div>
      <div class="hud-actions">
        <span class="gauge stars" title="Étoiles gagnées">★ ${totalStars(s)} / ${n * 3}</span>
        <span class="gauge" title="Score">🏅 ${fmt(totalScore(s))}</span>
        ${briefing}
        <button data-action="menu" title="Menu">☰</button>
      </div>
    </div>
    ${menu}`;
}
