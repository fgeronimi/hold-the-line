import type { Wave } from '../../engine/types.ts';
import { starCount } from '../../engine/score.ts';
import { draftInfo } from '../draft.ts';
import { icon, type IconName } from '../icons.ts';
import { decimal as fmt, esc, narratorFace, realGame, totalStars, type ViewState } from './common.ts';

const KINDS: { k: 'read' | 'write' | 'async'; icon: IconName; short: string; tip: string }[] = [
  { k: 'read', icon: 'read', short: 'lectures/s', tip: 'Lectures par seconde au plus fort de la vague' },
  { k: 'write', icon: 'write', short: 'écritures/s', tip: 'Écritures par seconde au plus fort de la vague' },
  { k: 'async', icon: 'async', short: 'événements/s', tip: 'Événements par seconde au plus fort de la vague' },
];

/**
 * Une jauge, au format des ressources de la planche (I18) : un pictogramme, la valeur, et ce
 * qu'elle mesure en petit dessous ; le détail au survol ou au clavier.
 */
const gauge = (name: IconName, short: string, tip: string, value: string, bad: boolean, extra = '') =>
  `<span class="gauge${bad ? ' ko' : ''}${extra}" data-tip="${esc(tip)}" tabindex="0">${icon(name)}<b>${value}</b><small>${esc(short)}</small></span>`;

/** Le trafic de la vague à son plus fort, une jauge par type : ce que le joueur doit dimensionner. */
function trafficPeak(wave: Wave): string {
  const peak = Math.max(...wave.profile.map((p) => p.factor));
  return KINDS.map((x) => ({ ...x, rps: wave.sources.reduce((a, src) => a + (src.rps[x.k] ?? 0), 0) * peak }))
    .filter((x) => x.rps > 0)
    .map((x) => gauge(x.icon, x.short, x.tip, fmt(x.rps), false))
    .join('');
}

/** Les étoiles des vagues d'avant `k` : la partie a déjà compté celles de la vague jouée. */
const starsBefore = (s: ViewState, k: number) => s.game.stars.slice(0, k).reduce((a, x) => a + starCount(x), 0);

/** Les losanges de la progression : vagues tenues en or, la vague en cours en rouge. */
const pips = (current: number, total: number) =>
  `<span class="wave-pips" aria-hidden="true">${Array.from({ length: total }, (_, k) => `<i class="${k < current ? 'done' : k === current ? 'now' : ''}"></i>`).join('')}</span>`;

/** Les jauges de la construction : facture et complexité prévues face aux plafonds, trafic, SLA. */
function buildGauges(s: ViewState, wave: Wave): string {
  const info = draftInfo(s.draft, s.catalog);
  const cost = info.cost;
  const complexity = info.complexity;
  const sla = `${(wave.sla.maxFailureRate * 100).toFixed(0)} % <em>· ${wave.sla.maxP95LatencyMs} ms</em>`;
  return [
    gauge('coin', 'budget', 'Coût de la vague / budget', `${fmt(cost)} <em>/ ${wave.budget}</em>`, cost > wave.budget),
    gauge('cog', 'complexité', 'Complexité / plafond', `${complexity} <em>/ ${wave.complexityCap}</em>`, complexity > wave.complexityCap),
    trafficPeak(wave),
    gauge('target', 'SLA', 'SLA : échecs max, latence p95 max', sla, false),
  ].join('');
}

function renderMenu(s: ViewState): string {
  // Chaque vague tenue se rejoue sans rien effacer (E10), partie finie comprise.
  const won = realGame(s).waveIndex;
  const replays = s.practice
    ? '<button data-action="leave-practice">Quitter le rejeu</button>'
    : Array.from({ length: won }, (_, i) => `<button data-action="replay-wave" data-wave="${i}">Rejouer la vague ${i + 1}</button>`).join('');
  return `<div class="menu panel">
        <button data-action="choose-scenario">Changer de scénario</button>
        <button data-action="reset-game">Nouvelle partie</button>
        ${replays}
        ${realGame(s).finished ? '<button data-action="show-review">Bilan du scénario</button>' : ''}
        <button data-action="show-achievements">Succès</button>
        <button data-action="show-welcome">Comment jouer</button>
        <button data-action="toggle-debug">${s.debug ? 'Quitter' : 'Ouvrir'} le mode debug</button>
      </div>`;
}

/** La barre du haut : la vague, ce que coûte la cité en construction, les étoiles, le menu. */
export function renderHud(s: ViewState): string {
  // Avant le choix du scénario, aucune vague n'est encore la nôtre.
  if (s.phase === 'choose') return '';
  // Pendant la vague et son debrief, on montre la vague jouée : la partie, elle, a déjà avancé.
  const playing = s.phase === 'wave' || s.phase === 'debrief' ? s.attempts.find((x) => x.id === s.current) : undefined;
  const shownIndex = playing?.waveIndex ?? s.game.waveIndex;
  const wave = s.scenario.waves[shownIndex];
  const n = s.scenario.waves.length;
  const building = s.phase !== 'wave' && s.phase !== 'debrief';
  const gauges = wave && building ? buildGauges(s, wave) : '';
  const menu = s.showMenu ? renderMenu(s) : '';
  const title = wave ? `${s.practice ? 'Rejeu · ' : ''}Vague ${shownIndex + 1} / ${n}` : 'Partie terminée';
  const subtitle = wave ? esc(wave.title) : esc(s.scenario.subtitle);
  // Pendant la vague, les étoiles d'avant : le résultat se découvre au debrief.
  const stars = s.phase !== 'wave' || !playing ? totalStars(s) : s.practice ? (s.practice.before ?? totalStars(s)) : starsBefore(s, playing.waveIndex);
  const briefing = wave ? `<button class="round" data-action="show-briefing" data-tip="Revoir le briefing" aria-label="Revoir le briefing">${narratorFace()}</button>` : '';
  return `
    <div class="hud-bar">
      <div class="wave-badge" data-tip="${esc(s.scenario.subtitle)}">
        <span class="wave-skull">${icon('skull')}</span>
        <div class="plaque hud-title"><b>${title}</b><span>${subtitle}</span>${wave ? pips(shownIndex, n) : ''}</div>
      </div>
      ${gauges ? `<div class="plaque hud-gauges">${gauges}</div>` : ''}
      <div class="plaque hud-actions">
        ${gauge('star', 'étoiles', 'Étoiles gagnées', `${stars} <em>/ ${n * 3}</em>`, false, ' stars')}
        ${briefing}
        <button class="round" data-action="show-achievements" data-tip="Succès" aria-label="Succès">${icon('medal')}</button>
        <button class="round" data-action="menu" data-tip="Menu" aria-label="Menu">${icon('menu')}</button>
      </div>
    </div>
    ${menu}`;
}
