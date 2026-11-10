import { bill, migrationCost, totals } from '../engine/budget.ts';
import type { GameState } from '../engine/game.ts';
import type { Architecture, BoardCell, Catalog, Gauge, Scenario, SimEvent, Wave, WaveResult } from '../engine/types.ts';
import { linkFlows, type LinkFlows } from '../engine/routing.ts';
import { validateArchitecture } from '../engine/validate.ts';
import { fortifiedCity as theme } from '../data/themes/fortified-city.ts';
import { calibrationGroups, formatField, getAt } from './calibration.ts';
import { analyzeWave, type Finding } from './debrief.ts';
import { guideStep } from './tutorial.ts';
import { SCENARIOS } from '../data/scenarios/index.ts';
import { chartModel, renderChart } from '../render/charts.ts';
import { nodeNames } from '../render/theme.ts';
import type { Stars } from '../engine/score.ts';
import { scoring } from '../data/scoring.ts';


export interface Attempt {
  id: number;
  label: string;
  waveIndex: number;
  result: WaveResult;
  score: number;
  /** Une tentative jouée compte dans la partie ; un essai sert seulement à comparer. */
  played: boolean;
  /** Réglages de calibrage différents du code au moment de la tentative. */
  settings: string[];
  /** Architecture jouée, pour la rejouer en 3D. */
  arch: Architecture;
  /** Objectifs atteints, comptés au moment de la tentative (les rejeux d'avant comptent). */
  stars: Stars;
}

/** Outil actif sur le plateau. */
export type Tool =
  | { kind: 'select' }
  | { kind: 'place'; type: string }
  | { kind: 'link'; from?: string | undefined }
  | { kind: 'move'; id: string }
  | { kind: 'remove' };

/** Où en est la partie : le chambellan parle, on construit, la vague se joue, on en tire la leçon. */
export type Phase = 'choose' | 'briefing' | 'build' | 'wave' | 'debrief';

export interface ViewState {
  catalog: Catalog;
  scenario: Scenario;
  game: GameState;
  draft: Architecture;
  attempts: Attempt[];
  /** Tentative mise en avant dans le détail du mode debug. */
  selected?: number | undefined;
  tool: Tool;
  /** Bâtiment dont la fiche est ouverte. */
  selectedNode?: string | undefined;
  /** Case vide cliquée : les fiches des bâtiments qu'on peut y construire sont ouvertes. */
  buildAt?: BoardCell | undefined;
  /** Dernier refus ou conseil du plateau (case occupée, chemin impossible…). */
  boardMessage?: string | undefined;
  phase: Phase;
  /** Tentative jouée sur le plateau, puis montrée au debrief. */
  current?: number | undefined;
  /** Mode debug : essais, vue tableau, calibrage, détail chiffré. `?debug` ou la touche D. */
  debug: boolean;
  /** Combien de pas de construction on peut annuler, ou rétablir. */
  history: { undo: number; redo: number };
  debugTab: 'attempts' | 'table' | 'calibrate';
  /** Le debrief montre l'analyse du chambellan ou les courbes tick par tick. */
  debriefTab: 'analysis' | 'charts';
  showMenu: boolean;
  /** L'écran de choix : chaque scénario et où en est sa partie. */
  choices: {
    id: string;
    title: string;
    subtitle: string;
    level: string;
    pitch: string;
    waves: number;
    reached: number;
    stars: number;
    finished: boolean;
  }[];
}

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const pct = (n: number) => `${(n * 100).toFixed(2)} %`;

const totalScore = (s: ViewState) => s.game.scores.reduce((a, x) => a + x, 0);
const totalStars = (s: ViewState) => s.game.stars.reduce((a, x) => a + x, 0);

/** Nom technique d'abord, la métaphore entre parenthèses. */
function nameOf(type: string, catalog: Catalog): string {
  const tech = catalog.components[type]?.techName ?? type;
  const metaphor = theme.buildings[type]?.metaphor;
  return metaphor ? `${tech} (${metaphor})` : tech;
}

const KIND_ICONS: Record<string, string> = { read: '📖', write: '✍️', async: '✉️' };
const KIND_NAMES: Record<string, string> = { read: 'une lecture', write: 'une écriture', async: 'un événement' };

/** Le trafic de la vague à son plus fort, par type : ce que le joueur doit dimensionner. */
function trafficPeak(wave: Wave): string {
  const peak = Math.max(...wave.profile.map((p) => p.factor));
  return (['read', 'write', 'async'] as const)
    .map((k) => ({ k, rps: wave.sources.reduce((a, src) => a + (src.rps[k] ?? 0), 0) * peak }))
    .filter((x) => x.rps > 0)
    .map((x) => `${KIND_ICONS[x.k]} ${fmt(x.rps)}`)
    .join(' · ');
}

/** La capacité d'un bâtiment dans l'unité où se fait le calcul : le travail par seconde. */
function capacityText(node: Architecture['nodes'][number], def: Catalog['components'][string], catalog: Catalog): string {
  const level = (effect: string) =>
    Object.values(catalog.upgrades)
      .filter((u) => u.appliesTo === node.type && u.effect.type === effect)
      .reduce((a, u) => a + (node.upgrades?.[u.id] ?? 0), 0);
  const instances = 1 + level('instances');
  const costs = Object.entries(def.workPerRequest)
    .map(([k, v]) => `${KIND_NAMES[k] ?? k} ${fmt(v)}`)
    .join(', ');
  const replica = Object.values(catalog.upgrades).find((u) => u.appliesTo === node.type && u.effect.type === 'readReplicas');
  const replicas = level('readReplicas');
  return [
    `Capacité : ${fmt(def.capacity)} unités de travail par seconde${instances > 1 ? ` × ${instances} instances = ${fmt(def.capacity * instances)}` : ''}.`,
    costs ? `Coût en travail : ${costs}.` : '',
    replica && replica.effect.type === 'readReplicas'
      ? `Chaque réplica ajoute ${fmt(replica.effect.capacityPerReplica)} unités pour les lectures${replicas > 0 ? ` (ici ${replicas}, soit +${fmt(replica.effect.capacityPerReplica * replicas)})` : ''}.`
      : '',
    `Latence ${def.latencyMs} ms · prix ${def.cost} · complexité ${def.complexity}.`,
  ]
    .filter(Boolean)
    .join('<br>');
}

const starIcons = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);

/** La barre du haut : la vague, ce que coûte la cité en construction, le score, le menu. */
export function renderHud(s: ViewState): string {
  // Pendant la vague et son debrief, on montre la vague jouée : la partie, elle, a déjà avancé.
  const playing = s.phase === 'wave' || s.phase === 'debrief' ? s.attempts.find((x) => x.id === s.current) : undefined;
  const shownIndex = playing?.waveIndex ?? s.game.waveIndex;
  const wave = s.scenario.waves[shownIndex];
  const n = s.scenario.waves.length;
  let gauges = '';
  if (wave && s.phase !== 'wave' && s.phase !== 'debrief' && s.phase !== 'choose') {
    const lines = bill(s.draft, s.catalog);
    const cost = lines.reduce((a, l) => a + l.cost, 0) + migrationCost(s.game.committed, s.draft, s.catalog);
    const complexity = lines.reduce((a, l) => a + l.complexity, 0);
    const gauge = (icon: string, label: string, value: string, bad: boolean) =>
      `<span class="gauge${bad ? ' ko' : ''}" title="${esc(label)}">${icon} ${value}</span>`;
    gauges = [
      gauge('💰', 'Coût de la vague / budget', `${fmt(cost)} / ${wave.budget}`, cost > wave.budget),
      gauge('⚙️', 'Complexité / plafond', `${complexity} / ${wave.complexityCap}`, complexity > wave.complexityCap),
      gauge('🧍', 'Trafic au plus fort de la vague, en requêtes par seconde : lectures, écritures, événements', trafficPeak(wave), false),
      gauge('🎯', 'SLA : échecs max, latence p95 max', `${(wave.sla.maxFailureRate * 100).toFixed(0)} % · ${wave.sla.maxP95LatencyMs} ms`, false),
    ].join('');
  }
  const menu = s.showMenu
    ? `<div class="menu panel">
        <button data-action="choose-scenario">Changer de scénario</button>
        <button data-action="reset-game">Nouvelle partie</button>
        ${s.game.history
          .slice(0, s.game.waveIndex)
          .map((_, i) => `<button data-action="rewind" data-wave="${i}">Revenir à la vague ${i + 1}</button>`)
          .join('')}
        <button data-action="toggle-debug">${s.debug ? 'Quitter' : 'Ouvrir'} le mode debug</button>
      </div>`
    : '';
  return `
    <div class="hud-bar panel">
      <div class="hud-title"><b>${esc(s.scenario.subtitle)}</b>
        <span>${wave ? `Vague ${shownIndex + 1}/${n} — ${esc(wave.title)}` : 'Partie terminée'}</span></div>
      <div class="hud-gauges">${gauges}</div>
      <div class="hud-actions">
        <span class="gauge stars" title="Étoiles gagnées">★ ${totalStars(s)} / ${n * 3}</span>
        <span class="gauge" title="Score">🏅 ${fmt(totalScore(s))}</span>
        ${wave ? `<button data-action="show-briefing" title="Revoir le briefing">${theme.narrator.icon}</button>` : ''}
        <button data-action="menu" title="Menu">☰</button>
      </div>
    </div>
    ${menu}`;
}

/** La barre du bas : outils, bâtiments à poser, et le lancement de la vague. */
export function renderToolbar(s: ViewState): string {
  const wave = s.scenario.waves[s.game.waveIndex];
  if (s.phase !== 'build' || !wave) return '';
  const { catalog, draft, tool } = s;
  const active = (on: boolean) => (on ? ' active' : '');
  const guide = guideStep(draft, catalog, wave, s.game.waveIndex, s.game.committed, s.game.waveIndex === 0 && s.scenario.id === SCENARIOS[0]!.scenario.id);
  const hint = (on: boolean) => (on ? ' hint' : '');
  const tools = [
    { kind: 'select', icon: '👆', label: 'Sélection', hint: 'Cliquer un bâtiment pour ouvrir sa fiche, le glisser pour le déplacer' },
    { kind: 'link', icon: '🛤️', label: 'Relier', hint: 'Cliquer le départ, puis l’arrivée' },
    { kind: 'remove', icon: '🧨', label: 'Retirer', hint: 'Cliquer un bâtiment pour le démolir' },
  ]
    .map(
      (t) => `<button class="tool${active(tool.kind === t.kind)}${hint(guide?.highlight?.tool === t.kind)}" data-action="tool" data-tool="${t.kind}" title="${esc(t.hint)}">
        <span class="icon">${t.icon}</span><span>${t.label}</span></button>`,
    )
    .join('') +
    `<button class="tool" data-action="undo" ${s.history.undo ? '' : 'disabled'} title="Annuler (⌘Z)"><span class="icon">↶</span><span>Annuler</span></button>` +
    `<button class="tool" data-action="redo" ${s.history.redo ? '' : 'disabled'} title="Rétablir (⇧⌘Z)"><span class="icon">↷</span><span>Rétablir</span></button>`;
  const palette = Object.values(catalog.components)
    .filter((d) => d.behavior !== 'source' && !d.prePlaced)
    .map((d) => {
      const style = theme.buildings[d.id];
      const on = tool.kind === 'place' && tool.type === d.id;
      const guided = guide?.highlight?.tool === 'place' && guide.highlight.type === d.id;
      return `<button class="tool build${active(on)}${hint(guided)}" data-action="tool" data-tool="place" data-type="${esc(d.id)}"
        title="${esc(`${d.techName}${style ? ` — ${style.metaphor}` : ''}. ${style?.role.real ?? ''} Coût ${d.cost}, complexité ${d.complexity}. Cliquer puis poser, ou glisser sur le plateau.`)}">
        <span class="icon">${style?.icon ?? '🏠'}</span><span>${esc(d.techName)}</span><small>${esc(style?.metaphor ?? '')}</small><small>💰 ${d.cost}</small></button>`;
    })
    .join('');
  const validation = validateArchitecture(draft, catalog);
  const why = validation.ok ? 'Lancer la vague' : validation.errors.join('\n');
  const from = tool.kind === 'link' && tool.from ? draft.nodes.find((n) => n.id === tool.from) : undefined;
  const linkHint = from ? `<div class="toast panel">Départ : ${esc(nameOf(from.type, catalog))} — cliquer l’arrivée</div>` : '';
  const message = s.boardMessage ? `<div class="toast panel ko">${esc(s.boardMessage)}</div>` : linkHint;
  const tutorial = guide
    ? `<div class="tutorial panel">${speech(guide.says, guide.real)}</div>`
    : '';
  return `
    ${tutorial}
    ${message}
    <div class="toolbar panel">
      <div class="group">${tools}</div>
      <div class="group palette">${palette}</div>
      <button class="launch${hint(guide?.highlight?.tool === 'launch')}" data-action="play" ${validation.ok ? '' : 'disabled'} title="${esc(why)}">⚔️ Lancer la vague</button>
    </div>
    ${validation.ok ? '' : `<div class="errors panel">${validation.errors.map((e) => `<p>⚠ ${esc(e)}</p>`).join('')}</div>`}`;
}

/** La fiche du bâtiment sélectionné, ou les fiches de ce qu'on peut bâtir sur la case cliquée. */
export function renderCard(s: ViewState): string {
  if (s.phase !== 'build') return '';
  return s.buildAt ? renderBuildMenu(s, s.buildAt) : renderNodeCard(s);
}

const KINDS_TEXT: Record<string, string> = { read: 'lectures', write: 'écritures', async: 'événements' };

/**
 * Les fiches des bâtiments à construire sur une case vide : ce que fait chacun, dans la
 * métaphore et en vrai, ses chiffres, et un bouton pour le poser là. Sur un chemin, le
 * bâtiment s'insère dans le lien quand c'est sensé (I11) : la fiche le dit.
 */
export function renderBuildMenu(s: ViewState, cell: BoardCell): string {
  const road = s.draft.links.find((l) => l.path?.some((c) => c.q === cell.q && c.r === cell.r));
  const ends = road ? [road.from, road.to].map((id) => nameOf(s.draft.nodes.find((n) => n.id === id)?.type ?? id, s.catalog)) : undefined;
  const cards = Object.values(s.catalog.components)
    .filter((d) => d.behavior !== 'source' && !d.prePlaced)
    .map((d) => {
      const style = theme.buildings[d.id];
      const accepts = d.accepts.map((k) => KINDS_TEXT[k] ?? k).join(', ');
      const ups = Object.values(s.catalog.upgrades)
        .filter((u) => u.appliesTo === d.id)
        .map((u) => `${theme.upgradeIcons[u.id] ?? '✦'} ${esc(u.techName)}`)
        .join(' · ');
      const affordable = d.cost <= Math.max(0, (s.scenario.waves[s.game.waveIndex]?.budget ?? Infinity) - totals(s.draft, s.catalog).cost);
      return `<article class="build-card">
        <header><span class="icon">${style?.icon ?? '🏠'}</span><div><b>${esc(d.techName)}</b><small>${esc(style?.metaphor ?? '')}</small></div></header>
        ${style ? `<p>${esc(style.role.real)}</p>` : ''}
        <p class="figures">${fmt(d.capacity)} unités de travail/s · ${d.latencyMs} ms${accepts ? ` · reçoit ${accepts}` : ''}</p>
        ${ups ? `<p class="ups">Évolutions : ${ups}</p>` : ''}
        <footer><span>💰 ${d.cost} · ⚙ ${d.complexity}</span>
          <button data-action="build-at" data-type="${esc(d.id)}" ${affordable ? '' : 'title="Au-delà du budget restant de la vague"'}>Construire ici</button></footer>
      </article>`;
    })
    .join('');
  return `
    <section class="card panel build-menu">
      <button class="close" data-action="close-build" title="Fermer (Échap)">✕</button>
      <h3>Construire ici</h3>
      ${road && ends ? `<p class="muted">Sur le chemin ${esc(ends[0]!)} → ${esc(ends[1]!)} : le bâtiment s’insère dans le lien quand c’est sensé.</p>` : '<p class="muted">Choisir un bâtiment pour cette case.</p>'}
      <div class="build-cards">${cards}</div>
    </section>`;
}

/** Les fenêtres : le briefing du chambellan, le debrief d'une vague. */
export function renderDialog(s: ViewState): string {
  if (s.phase === 'choose') return renderChoose(s);
  const wave = s.scenario.waves[s.game.waveIndex];
  if (s.phase === 'briefing' && wave) {
    return `<div class="dialog panel">
      <h2>Vague ${s.game.waveIndex + 1} — ${esc(wave.title)}</h2>
      ${renderBriefing(wave, s)}
      <p class="actions"><button class="primary" data-action="start-build">Construire 🔨</button></p>
    </div>`;
  }
  if (s.phase !== 'debrief') return '';
  const a = s.attempts.find((x) => x.id === s.current);
  if (!a) return '';
  const r = a.result;
  const attemptWave = s.scenario.waves[a.waveIndex];
  const finished = s.game.finished && a.played && r.won;
  const actions = [
    `<button data-action="replay" data-attempt="${a.id}">🔁 Revoir la vague</button>`,
    a.played && r.won && !finished ? '<button class="primary" data-action="next">Vague suivante ➜</button>' : '',
    a.played && !r.won ? '<button class="primary" data-action="retry">Réessayer 🔨</button>' : '',
    !a.played ? '<button class="primary" data-action="retry">Retour à la construction</button>' : '',
    finished ? '<button class="primary" data-action="reset-game">Nouvelle partie</button>' : '',
  ].join('');
  return `<div class="dialog panel ${r.won ? 'won' : 'lost'}">
    <h2>${r.won ? '🏆 Vague tenue' : '💥 Vague perdue'}${a.played && r.won ? ` — +${fmt(a.score)} 🏅` : ''}${a.played ? '' : ' (essai)'}</h2>
    ${attemptWave ? renderStars(a.stars, attemptWave) : ''}
    <p class="tabs">
      <button data-action="debrief-tab" data-tab="analysis" ${s.debriefTab === 'analysis' ? 'class="active"' : ''}>${theme.narrator.icon} Analyse</button>
      <button data-action="debrief-tab" data-tab="charts" ${s.debriefTab === 'charts' ? 'class="active"' : ''}>📈 Courbes</button>
    </p>
    ${finished ? `<p class="final">La cité a tenu toutes les vagues. <b>${totalStars(s)} / ${s.scenario.waves.length * 3}</b> ★, score final <b>${fmt(totalScore(s))}</b> 🏅</p>` : ''}
    ${attemptWave
      ? s.debriefTab === 'charts'
        ? `${renderChart(chartModel(r, a.arch, attemptWave, s.catalog, theme))}<p class="muted">Survoler pour lire chaque tick. La courbe d’un bâtiment passe en rouge au-delà de sa capacité ; les barres rouges sont les requêtes en échec, les bandes orange les incidents.</p>`
        : renderFindings(analyzeWave(r, a.arch, attemptWave, s.catalog, theme))
      : ''}
    ${a.played && !r.won && s.game.replays > 0 ? `<p class="muted">Chaque nouvel essai coûte ${Math.round(scoring.replayPenalty * 100)} % des points de la vague, jusqu’à ne plus en rapporter ; les étoiles restent à prendre. Si un choix plus ancien bloque, le menu ☰ permet de revenir à une vague antérieure.</p>` : ''}
    <p class="actions">${actions}</p>
  </div>`;
}

const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** L'écran de choix du scénario, sans verrou (décision S2). */
function renderChoose(s: ViewState): string {
  const cards = s.choices
    .map((c) => {
      const progress = c.finished
        ? `Terminé · ★ ${c.stars} / ${c.waves * 3}`
        : c.reached > 0
          ? `Vague ${c.reached + 1} / ${c.waves} · ★ ${c.stars}`
          : `${c.waves} vagues`;
      return `<button class="scenario-card" data-action="pick-scenario" data-scenario="${esc(c.id)}">
        <small>${esc(c.level)}</small>
        <b>${esc(capitalize(c.subtitle.replace(/^Hold the Line : /, '')))}</b>
        <span>${esc(c.title)}</span>
        <p>${esc(c.pitch)}</p>
        <em>${esc(progress)}</em>
      </button>`;
    })
    .join('');
  return `<div class="dialog panel">
    <h2>Hold the Line</h2>
    ${speech('Sire, quelle partie de la cité voulez-vous défendre ?', 'Choisissez un scénario. Chacun a sa propre partie, vous pouvez passer de l’un à l’autre sans rien perdre.')}
    <div class="scenario-cards">${cards}</div>
  </div>`;
}

/** Les trois objectifs de la vague, chacun une étoile (décision E7). */
function renderStars(stars: Stars, wave: Wave): string {
  const n = Number(stars.held) + Number(stars.firstTry) + Number(stars.thrifty);
  const line = (ok: boolean, label: string) => `<li class="${ok ? 'ok' : 'missed'}">${ok ? '★' : '☆'} ${esc(label)}</li>`;
  return `<div class="stars-box"><span class="star-row">${starIcons(n)}</span><ul>
    ${line(stars.held, 'Tenir la vague : SLA, budget et complexité respectés')}
    ${line(stars.firstTry, 'Du premier coup, sans rejeu')}
    ${line(stars.thrifty, `Économe : facture ≤ ${wave.thriftyCost ?? wave.budget}`)}
  </ul></div>`;
}

/** Le tiroir du mode debug : essais, vue tableau, calibrage, détail chiffré des tentatives. */
export function renderDebug(s: ViewState): string {
  if (!s.debug) return '';
  const wave = s.scenario.waves[s.game.waveIndex];
  const tab = (id: ViewState['debugTab'], label: string) =>
    `<button data-action="debug-tab" data-tab="${id}" ${s.debugTab === id ? 'class="active"' : ''}>${label}</button>`;
  const body =
    s.debugTab === 'calibrate'
      ? renderCalibration(s)
      : s.debugTab === 'table'
        ? wave
          ? renderBuild(s, wave)
          : ''
        : `${wave && s.phase === 'build' ? '<p><button data-action="try">Essai hors partie</button> <button data-action="revert">Revenir à l’architecture validée</button></p>' : ''}${renderAttempts(s) || '<p class="muted">Aucune tentative pour l’instant.</p>'}`;
  return `<aside class="debug panel">
    <header><b>🔧 Debug</b> ${tab('attempts', 'Tentatives')} ${tab('table', 'Vue tableau')} ${tab('calibrate', 'Calibrage')}
      <button data-action="toggle-debug" title="Fermer (D)">✕</button></header>
    <div class="debug-body">${body}</div>
  </aside>`;
}

function renderNodeCard(s: ViewState): string {
  const node = s.draft.nodes.find((n) => n.id === s.selectedNode);
  if (!node) return '';
  const def = s.catalog.components[node.type];
  const links = s.draft.links
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.from === node.id || l.to === node.id)
    .map(({ l, i }) => `<li>${esc(linkEnd(l.from))} → ${esc(linkEnd(l.to))} <button data-action="remove-link" data-link="${i}">retirer</button></li>`)
    .join('');
  const permanent = def?.behavior === 'source' || !!node.fixed;
  const own = nodeNames(node, s.catalog, theme);
  function linkEnd(id: string): string {
    const n = s.draft.nodes.find((x) => x.id === id);
    if (!n) return id;
    const { tech } = nodeNames(n, s.catalog, theme);
    // L'identifiant ne sert qu'à distinguer deux bâtiments du même nom.
    return s.draft.nodes.filter((x) => nodeNames(x, s.catalog, theme).tech === tech).length > 1 ? `${tech} (${n.id})` : tech;
  }
  return `
    <section class="card panel">
      <button class="close" data-action="deselect" title="Fermer">✕</button>
      <h3>${esc(own.tech)} <small>${esc(own.metaphor)}</small></h3>
      ${node.fixed ? '<p class="muted">Service déjà en place, tenu par une autre équipe : il ne se démolit pas, mais ses évolutions sont à vous.</p>' : ''}
      ${theme.buildings[node.type] ? speech(theme.buildings[node.type]!.role.says, theme.buildings[node.type]!.role.real) : ''}
      ${def && def.behavior !== 'source' ? `<p class="figures">${capacityText(node, def, s.catalog)}</p>` : ''}
      <p>${upgradeSelects(node, s.catalog) || '<span class="muted">aucune évolution</span>'}</p>
      ${links ? `<ul>${links}</ul>` : '<p class="muted">Aucun chemin.</p>'}
      <p>
        <button data-action="tool" data-tool="move" data-node="${esc(node.id)}">Déplacer</button>
        ${permanent ? '' : `<button data-action="remove-node" data-node="${esc(node.id)}">Retirer</button>`}
      </p>
    </section>`;
}

/**
 * Les pastilles au pied du bâtiment sélectionné sur le plateau : déplacer et retirer en
 * tête, puis une par évolution du catalogue qui s'y applique. Tout-ou-rien, la pastille se
 * bascule ; à niveaux, deux boutons − et + l'encadrent. Le prix et la complexité au survol.
 */
export function upgradePips(
  node: Architecture['nodes'][number],
  catalog: Catalog,
  can: { move: boolean; remove: boolean } = { move: false, remove: false },
): string {
  const id = esc(node.id);
  const actions = [
    can.move &&
      `<button class="pip act" data-action="tool" data-tool="move" data-node="${id}" aria-label="Déplacer"><span class="icon">✥</span><i><em>Déplacer</em>Cliquer la case d’arrivée, ou glisser le bâtiment</i></button>`,
    can.remove &&
      `<button class="pip act ko" data-action="remove-node" data-node="${id}" aria-label="Retirer"><span class="icon">🧨</span><i><em>Retirer</em>Démolir le bâtiment et ses chemins. S’il était déjà là à la vague précédente, sa valeur d’achat entre dans la facture (migration)</i></button>`,
  ].filter(Boolean);
  const pips = Object.values(catalog.upgrades)
    .filter((u) => u.appliesTo === node.type)
    .map((u) => {
      const level = node.upgrades?.[u.id] ?? 0;
      const leveled = u.maxLevel > 1;
      const icon = theme.upgradeIcons[u.id] ?? '✦';
      const badge =
        level === 0 || !leveled
          ? ''
          : u.effect.type === 'rateLimit'
            ? `${u.effect.tiersPerClientRps[level - 1]}/s`
            : u.effect.type === 'autoscaling'
              ? `≤${level}`
              : `+${level}`;
      const price = u.cost.perLevel > 0 ? `${u.cost.base > 0 ? `${u.cost.base} + ` : ''}${u.cost.perLevel} par niveau` : `${u.cost.base}`;
      const tiers = u.effect.type === 'rateLimit' ? `<br>paliers : ${u.effect.tiersPerClientRps.join(', ')} req/s par client` : '';
      const tip = `<em>${esc(u.techName)}</em>${esc(u.label)}<br>${price} · +${u.complexity.base + u.complexity.perLevel} complexité${tiers}`;
      const data = `data-action="upgrade-step" data-node="${esc(node.id)}" data-upgrade="${esc(u.id)}"`;
      const face = `<span class="icon">${icon}<b>${esc(badge)}</b></span>`;
      return leveled
        ? `<div class="pip leveled${level > 0 ? ' on' : ''}">
            <button class="step" ${data} data-delta="-1" ${level === 0 ? 'disabled' : ''} aria-label="${esc(u.techName)} : un niveau de moins">−</button>${face}<button class="step" ${data} data-delta="1" ${level === u.maxLevel ? 'disabled' : ''} aria-label="${esc(u.techName)} : un niveau de plus">+</button><i>${tip}</i></div>`
        : `<button class="pip${level > 0 ? ' on' : ''}" ${data} data-delta="toggle" aria-pressed="${level > 0}" aria-label="${esc(u.techName)}">${face}<i>${tip}</i></button>`;
    });
  if (pips.length === 0 && actions.length === 0) return '';
  return `<div class="pips">${actions.length > 0 ? `<div class="pip-actions">${actions.join('')}</div>` : ''}${pips.join('')}</div>`;
}

/** Les sélecteurs d'évolutions d'un bâtiment : partagés par la fiche et la vue tableau. */
function upgradeSelects(n: Architecture['nodes'][number], catalog: Catalog): string {
  return Object.values(catalog.upgrades)
    .filter((u) => u.appliesTo === n.type)
    .map((u) => {
      const level = n.upgrades?.[u.id] ?? 0;
      const options = Array.from({ length: u.maxLevel + 1 }, (_, i) => {
        const label =
          u.effect.type === 'rateLimit'
            ? i === 0 ? 'off' : `${u.effect.tiersPerClientRps[i - 1]} req/s/client`
            : u.effect.type === 'autoscaling'
              ? i === 0 ? 'off' : `≤ +${i}`
              : u.maxLevel === 1
                ? i === 0 ? 'non' : 'oui'
                : String(i);
        return `<option value="${i}" ${i === level ? 'selected' : ''}>${esc(label)}</option>`;
      }).join('');
      return `<label>${esc(u.techName)} <select data-action="upgrade" data-node="${esc(n.id)}" data-upgrade="${esc(u.id)}">${options}</select></label>`;
    })
    .join(' ');
}

function renderBriefing(wave: Wave, s: ViewState): string {
  return `
    <section>
      ${theme.narratives[wave.id] ? speech(theme.narratives[wave.id]!, wave.briefing) : `<p class="briefing">${esc(wave.briefing)}</p>`}
      ${(wave.incidents ?? [])
        .map((i) => `<p class="incident">⚡ <b>Incident annoncé :</b> ${esc(i.title)}, ticks ${i.from + 1} à ${i.until}. <i>${esc(nameOf(i.component, s.catalog))}</i></p>`)
        .join('')}
      <p>⭐ Objectifs : tenir · du premier coup · facture ≤ ${wave.thriftyCost ?? wave.budget}</p>
      <p>Budget ${wave.budget} · complexité max ${wave.complexityCap}
        · SLA : ${pct(wave.sla.maxFailureRate)} d'échecs, ${wave.sla.maxP95LatencyMs} ms p95 (approx.)
        ${s.game.replays > 0 ? ` · <b>${s.game.replays} rejeu(x)</b>, ${replayCut(s.game.replays)}` : ''}</p>
      <p class="muted">Trafic : ${wave.sources
        .map((src) => `${esc(src.id)} (${src.clients} clients${src.abusive ? ', abusif' : ''}${src.longTail ? ', longue traîne' : ''}) : ${Object.entries(src.rps).map(([k, v]) => `${k} ${v}`).join(', ')} req/s`)
        .join(' · ')}</p>
    </section>`;
}

function renderBuild(s: ViewState, wave: Wave): string {
  const { catalog, draft } = s;
  const validation = validateArchitecture(draft, catalog);
  const lines = bill(draft, catalog);
  const fixed = lines.reduce((a, l) => a + l.cost, 0);
  const complexity = lines.reduce((a, l) => a + l.complexity, 0);
  const migration = migrationCost(s.game.committed, draft, catalog);
  const flows = linkFlows(draft, catalog);

  const nodeRows = draft.nodes
    .map((n) => {
      const def = catalog.components[n.type];
      const upgrades = upgradeSelects(n, catalog);
      const removable = def?.behavior !== 'source' && !n.fixed;
      return `<tr>
        <td><code>${esc(n.id)}</code></td>
        <td>${esc(def?.techName ?? n.type)}</td>
        <td class="muted">${def ? `cap. ${def.capacity}, ${def.latencyMs} ms, coût ${def.cost}, cx ${def.complexity}${def.hitRate !== undefined ? `, hit ${def.hitRate}` : ''}` : ''}</td>
        <td>${upgrades}</td>
        <td>${removable ? `<button data-action="remove-node" data-node="${esc(n.id)}">retirer</button>` : ''}</td>
      </tr>`;
    })
    .join('');

  const addable = Object.values(catalog.components)
    .filter((d) => d.behavior !== 'source' && !d.prePlaced)
    .map((d) => `<option value="${esc(d.id)}">${esc(d.techName)} — coût ${d.cost}</option>`)
    .join('');

  const nodeOptions = draft.nodes.map((n) => `<option value="${esc(n.id)}">${esc(n.id)}</option>`).join('');
  const linkRows = draft.links
    .map(
      (l, i) => `<tr>
        <td><code>${esc(l.from)}</code> → <code>${esc(l.to)}</code></td>
        <td class="muted">${describeKinds(flows.get(`${l.from}→${l.to}`) ?? [])}</td>
        <td><button data-action="remove-link" data-link="${i}">retirer</button></td>
      </tr>`,
    )
    .join('');

  const over = (v: number, max: number) => (v > max ? ' class="ko"' : '');
  return `
    <section class="cols">
      <div>
        <h3>Composants</h3>
        <table><tbody>${nodeRows}</tbody></table>
        <p><select id="new-node">${addable}</select> <button data-action="add-node">Poser</button></p>

        <h3>Liens</h3>
        <table><tbody>${linkRows || '<tr><td class="muted">aucun lien</td></tr>'}</tbody></table>
        <p>
          <select id="link-from">${nodeOptions}</select> →
          <select id="link-to">${nodeOptions}</select>
          <button data-action="add-link">Relier</button>
        </p>
        <p class="muted">Ce qui circule sur un lien est déduit. Un serveur relié à un cache le consulte
          pour chaque lecture, puis lit lui-même la base en cas d'absence : relier serveur → cache et
          serveur → base. L'async va à la file si elle est reliée, sinon à la base.</p>
      </div>
      <div>
        <h3>Schéma</h3>
        <pre>${esc(renderSchema(draft, flows, validation.ok ? validation.order : draft.nodes.map((n) => n.id)))}</pre>
        <h3>Facture prévue</h3>
        <p><span${over(fixed + migration, wave.budget)}>coût ${fmt(fixed)}${migration > 0 ? ` + ${fmt(migration)} de migration` : ''} / ${wave.budget}</span>
          (hors autoscaling, connu après la vague) ·
          <span${over(complexity, wave.complexityCap)}>complexité ${complexity} / ${wave.complexityCap}</span></p>
        ${validation.ok ? '' : `<ul class="ko">${validation.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`}
      </div>
    </section>`;
}

/** Schéma minimal : chaque nœud dans l'ordre du trafic, avec ce qu'il envoie à qui. */
function renderSchema(arch: Architecture, flows: LinkFlows, order: string[]): string {
  return order
    .map((id) => {
      const out = arch.links
        .filter((l) => l.from === id)
        .map((l) => `${l.to} [${(flows.get(`${l.from}→${l.to}`) ?? []).join(',') || 'rien'}]`);
      return out.length > 0 ? `${id} → ${out.join('  ')}` : id;
    })
    .join('\n');
}

function describeKinds(kinds: string[]): string {
  return kinds.length > 0 ? kinds.join(', ') : 'rien ne passe par ce lien';
}

function renderCalibration(s: ViewState): string {
  const groups = calibrationGroups(s.catalog, s.scenario, Math.min(s.game.waveIndex, s.scenario.waves.length - 1));
  return `
    <section>
      <p>Les valeurs s'appliquent tout de suite au prochain lancement. Elles sont gardées dans ce navigateur ;
        pour les reporter dans le code, copier l'export.
        <button data-action="reset-calibration">Revenir aux valeurs du code</button>
        <button data-action="export">Exporter</button></p>
      <textarea id="export" readonly hidden></textarea>
      <div class="grid">
        ${groups
          .map(
            (g) => `<fieldset><legend>${esc(g.title)}</legend>${g.fields
              .map((f) => {
                const root = g.root === 'catalog' ? s.catalog : s.scenario;
                return `<label>${esc(f.label)} <input data-action="calibrate" data-root="${g.root}" data-path="${esc(f.path)}" ${f.list ? 'data-list="1"' : ''} value="${esc(formatField(getAt(root, f.path)))}" size="12"></label>`;
              })
              .join('')}</fieldset>`,
          )
          .join('')}
      </div>
    </section>`;
}

function renderAttempts(s: ViewState): string {
  if (s.attempts.length === 0) return '';
  const selected = s.attempts.find((a) => a.id === s.selected) ?? s.attempts.at(-1)!;
  return `
    ${renderDebrief(selected, s)}
    <section>
      <h3>Comparaison des tentatives</h3>
      ${renderComparison(s.attempts.slice(-6))}
    </section>`;
}

/**
 * Double narration : le chambellan parle dans la métaphore, la ligne en italique dit la
 * même chose en vrai, avec les termes techniques. La métaphore seule ne s'apprend pas.
 */
function speech(text: string, real?: string): string {
  return `<div class="speech"><span class="speaker">${theme.narrator.icon}</span>
    <div><p><b>${esc(theme.narrator.name)} :</b> « ${esc(text)} »</p>
    ${real ? `<p class="real">${esc(real)}</p>` : ''}</div></div>`;
}

const TONE_ICONS: Record<Finding['tone'], string> = { good: '✅', warn: '⚡', bad: '❌', tip: '💡' };

/** L'analyse du narrateur : ce qu'il dit, l'explication technique, la parade, la notion à réviser. */
function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) return '';
  return `<div class="findings">${findings
    .map(
      (f, i) => `<div class="finding ${f.tone}">
        ${i === 0 ? speech(f.says, f.tech) : `<p class="says">${TONE_ICONS[f.tone]} « ${esc(f.says)} »</p>${f.tech ? `<p class="real">${esc(f.tech)}</p>` : ''}`}
        ${f.remedy ? `<p>💡 <b>Parade :</b> ${esc(f.remedy)}</p>` : ''}
        ${f.concept ? `<p class="muted">À réviser : ${esc(f.concept)}</p>` : ''}
      </div>`,
    )
    .join('')}</div>`;
}

function renderDebrief(a: Attempt, s: ViewState): string {
  const r = a.result;
  const wave = s.scenario.waves[a.waveIndex];
  const nodes = Object.entries(r.nodes)
    .filter(([, n]) => n.peakUtilization > 0 || n.failed > 0)
    .sort(([, x], [, y]) => y.peakUtilization - x.peakUtilization);
  const reasons = Object.entries(r.failuresByReason).filter(([, v]) => v > 0);
  return `
    <section class="${r.won ? 'won' : 'lost'}">
      <h2>${esc(a.label)} : ${r.won ? 'tenue' : 'perdue'}${a.played && r.won ? ` — ${fmt(a.score)} points` : ''}</h2>
      ${r.ticks.length > 0 ? `<p><button data-action="replay" data-attempt="${a.id}"><b>Voir la vague</b></button></p>` : ''}
      ${r.lossReasons.length > 0 ? `<ul>${r.lossReasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${a.played && !r.won ? '<p>La vague se rejoue depuis l’architecture validée à la vague précédente. Si un choix plus ancien la rend impossible, revenir à une vague antérieure (en haut) : ça compte comme un rejeu.</p>' : ''}
      ${wave ? renderFindings(analyzeWave(r, a.arch, wave, s.catalog, theme)) : ''}
      <div class="cols">
        <div>
          <h3>Jauges</h3>
          <table>
            <tr><th></th><th>valeur</th><th>limite</th><th>marge</th></tr>
            ${gaugeRow('coût', r.gauges.cost, fmt)}
            ${gaugeRow('complexité', r.gauges.complexity, fmt)}
            ${gaugeRow("taux d'échec", r.gauges.failureRate, pct)}
            ${gaugeRow('latence p95 (approx.)', r.gauges.latency, (v) => `${fmt(v)} ms`)}
          </table>
          <p class="muted">Facture : fixe ${fmt(r.bill.fixed)} · autoscaling ${fmt(r.bill.autoscaling)} · migration ${fmt(r.bill.migration)}
            · latence moyenne ${fmt(r.avgLatencyMs)} ms</p>
          <h3>Échecs</h3>
          <p>${reasons.length > 0 ? reasons.map(([k, v]) => `${esc(k)} : ${fmt(v)}`).join(' · ') : 'aucun'}
            ${r.shed > 0 ? ` · trafic abusif écarté : ${fmt(r.shed)}` : ''}</p>
        </div>
        <div>
          <h3>Composants</h3>
          <table>
            <tr><th></th><th>charge max</th><th>ticks saturés</th><th>échecs</th></tr>
            ${nodes.map(([id, n]) => `<tr${n.peakUtilization > 1 ? ' class="ko"' : ''}><td><code>${esc(id)}</code></td><td>${pct(n.peakUtilization)}</td><td>${n.saturatedTicks}</td><td>${fmt(n.failed)}</td></tr>`).join('')}
          </table>
        </div>
      </div>
      <details>
        <summary>Journal (${r.events.length} événements)</summary>
        <pre>${esc(r.events.map(describeEvent).join('\n'))}</pre>
      </details>
    </section>`;
}

function gaugeRow(label: string, g: Gauge, f: (n: number) => string): string {
  return `<tr${g.margin < 0 ? ' class="ko"' : ''}><td>${label}</td><td>${f(g.value)}</td><td>${f(g.limit)}</td><td>${pct(g.margin)}</td></tr>`;
}

function describeEvent(e: SimEvent): string {
  switch (e.type) {
    case 'invalid':
      return `invalide : ${e.message}`;
    case 'saturation-start':
      return `t${e.tick} ${e.node} sature (${pct(e.utilization)})`;
    case 'saturation-end':
      return `t${e.tick} ${e.node} ne sature plus`;
    case 'no-route':
      return `t${e.tick} ${e.node} n'a pas de route pour ${e.kind}`;
    case 'rate-limited':
      return `t${e.tick} ${e.node} limite ${e.source} : ${fmt(e.rejectedRps)} req/s rejetées`;
    case 'queue-overflow':
      return `t${e.tick} ${e.node} déborde : ${fmt(e.lostRps)} messages perdus`;
    case 'incident-start':
      return `t${e.tick} incident ${e.incident}`;
    case 'incident-end':
      return `t${e.tick} fin de l'incident ${e.incident}`;
    case 'threads-exhausted':
      return `t${e.tick} ${e.node} n'a plus de fil libre : il attend ${e.dependency}`;
  }
}

function renderComparison(attempts: Attempt[]): string {
  const row = (label: string, f: (a: Attempt) => string) =>
    `<tr><th>${label}</th>${attempts.map((a) => `<td>${f(a)}</td>`).join('')}</tr>`;
  return `<table class="compare">
    <tr><th></th>${attempts.map((a) => `<th><button data-action="select" data-attempt="${a.id}">${esc(a.label)}</button></th>`).join('')}</tr>
    ${row('résultat', (a) => (a.result.won ? 'tenue' : '<span class="ko">perdue</span>'))}
    ${row('coût', (a) => `${fmt(a.result.gauges.cost.value)} / ${a.result.gauges.cost.limit}`)}
    ${row('complexité', (a) => `${a.result.gauges.complexity.value} / ${a.result.gauges.complexity.limit}`)}
    ${row("taux d'échec", (a) => pct(a.result.gauges.failureRate.value))}
    ${row('latence p95', (a) => `${fmt(a.result.gauges.latency.value)} ms`)}
    ${row('score', (a) => (a.played ? fmt(a.score) : '—'))}
    ${row('réglages modifiés', (a) => (a.settings.length > 0 ? a.settings.map(esc).join('<br>') : '<span class="muted">aucun</span>'))}
  </table>`;
}

/** Ce que les rejeux retirent au score de la vague : jamais plus que ses points (décision E5). */
export function replayCut(replays: number): string {
  const cut = Math.min(1, replays * scoring.replayPenalty);
  return cut >= 1 ? 'la vague ne rapporte plus de points' : `−${Math.round(cut * 100)} % au score`;
}
