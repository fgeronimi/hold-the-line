import { bill, migrationCost } from '../engine/budget.ts';
import type { GameState } from '../engine/game.ts';
import type { Architecture, Catalog, Gauge, Scenario, SimEvent, Wave, WaveResult } from '../engine/types.ts';
import { linkFlows, type LinkFlows } from '../engine/routing.ts';
import { validateArchitecture } from '../engine/validate.ts';
import { fortifiedCity as theme } from '../data/themes/fortified-city.ts';
import { calibrationGroups, formatField, getAt } from './calibration.ts';
import { analyzeWave, type Finding } from './debrief.ts';
import { tutorialStep } from './tutorial.ts';
import type { Stars } from '../engine/score.ts';


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
export type Phase = 'briefing' | 'build' | 'wave' | 'debrief';

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
  /** Dernier refus ou conseil du plateau (case occupée, chemin impossible…). */
  boardMessage?: string | undefined;
  phase: Phase;
  /** Tentative jouée sur le plateau, puis montrée au debrief. */
  current?: number | undefined;
  /** Mode debug : essais, vue tableau, calibrage, détail chiffré. `?debug` ou la touche D. */
  debug: boolean;
  debugTab: 'attempts' | 'table' | 'calibrate';
  showMenu: boolean;
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

const starIcons = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);

/** La barre du haut : la vague, ce que coûte la cité en construction, le score, le menu. */
export function renderHud(s: ViewState): string {
  // Pendant la vague et son debrief, on montre la vague jouée : la partie, elle, a déjà avancé.
  const playing = s.phase === 'wave' || s.phase === 'debrief' ? s.attempts.find((x) => x.id === s.current) : undefined;
  const shownIndex = playing?.waveIndex ?? s.game.waveIndex;
  const wave = s.scenario.waves[shownIndex];
  const n = s.scenario.waves.length;
  let gauges = '';
  if (wave && s.phase !== 'wave' && s.phase !== 'debrief') {
    const lines = bill(s.draft, s.catalog);
    const cost = lines.reduce((a, l) => a + l.cost, 0) + migrationCost(s.game.committed, s.draft, s.catalog);
    const complexity = lines.reduce((a, l) => a + l.complexity, 0);
    const gauge = (icon: string, label: string, value: string, bad: boolean) =>
      `<span class="gauge${bad ? ' ko' : ''}" title="${esc(label)}">${icon} ${value}</span>`;
    gauges = [
      gauge('💰', 'Coût de la vague / budget', `${fmt(cost)} / ${wave.budget}`, cost > wave.budget),
      gauge('⚙️', 'Complexité / plafond', `${complexity} / ${wave.complexityCap}`, complexity > wave.complexityCap),
      gauge('🎯', 'SLA : échecs max, latence p95 max', `${(wave.sla.maxFailureRate * 100).toFixed(0)} % · ${wave.sla.maxP95LatencyMs} ms`, false),
    ].join('');
  }
  const menu = s.showMenu
    ? `<div class="menu panel">
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
  const guide = s.game.waveIndex === 0 ? tutorialStep(draft, catalog) : undefined;
  const hint = (on: boolean) => (on ? ' hint' : '');
  const tools = [
    { kind: 'select', icon: '👆', label: 'Sélection', hint: 'Cliquer un bâtiment pour ouvrir sa fiche' },
    { kind: 'link', icon: '🛤️', label: 'Relier', hint: 'Cliquer le départ, puis l’arrivée' },
    { kind: 'remove', icon: '🧨', label: 'Retirer', hint: 'Cliquer un bâtiment pour le démolir' },
  ]
    .map(
      (t) => `<button class="tool${active(tool.kind === t.kind)}${hint(guide?.highlight?.tool === t.kind)}" data-action="tool" data-tool="${t.kind}" title="${esc(t.hint)}">
        <span class="icon">${t.icon}</span><span>${t.label}</span></button>`,
    )
    .join('');
  const palette = Object.values(catalog.components)
    .filter((d) => d.behavior !== 'source')
    .map((d) => {
      const style = theme.buildings[d.id];
      const on = tool.kind === 'place' && tool.type === d.id;
      const guided = guide?.highlight?.tool === 'place' && guide.highlight.type === d.id;
      return `<button class="tool build${active(on)}${hint(guided)}" data-action="tool" data-tool="place" data-type="${esc(d.id)}"
        title="${esc(`${d.techName}${style ? ` — ${style.metaphor}` : ''}. Coût ${d.cost}, complexité ${d.complexity}`)}">
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

/** La fiche du bâtiment sélectionné, en panneau flottant. */
export function renderCard(s: ViewState): string {
  return s.phase === 'build' ? renderNodeCard(s) : '';
}

/** Les fenêtres : le briefing du chambellan, le debrief d'une vague. */
export function renderDialog(s: ViewState): string {
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
    ${finished ? `<p class="final">La cité a tenu toutes les vagues. <b>${totalStars(s)} / ${s.scenario.waves.length * 3}</b> ★, score final <b>${fmt(totalScore(s))}</b> 🏅</p>` : ''}
    ${r.lossReasons.length > 0 ? `<ul class="reasons">${r.lossReasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${attemptWave ? renderFindings(analyzeWave(r, a.arch, attemptWave, s.catalog, theme)) : ''}
    ${a.played && !r.won && s.game.replays > 0 ? `<p class="muted">Chaque nouvel essai coûte 20 % des points de la vague. Si un choix plus ancien bloque, le menu ☰ permet de revenir à une vague antérieure.</p>` : ''}
    <p class="actions">${actions}</p>
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
  const source = def?.behavior === 'source';
  function linkEnd(id: string): string {
    const n = s.draft.nodes.find((x) => x.id === id);
    return n ? `${s.catalog.components[n.type]?.techName ?? n.type} ${n.id}` : id;
  }
  return `
    <section class="card panel">
      <button class="close" data-action="deselect" title="Fermer">✕</button>
      <h3>${esc(def?.techName ?? node.type)} <small>${esc(theme.buildings[node.type]?.metaphor ?? '')} · ${esc(node.id)}</small></h3>
      ${def ? `<p class="muted">cap. ${def.capacity}, ${def.latencyMs} ms, coût ${def.cost}, complexité ${def.complexity}</p>` : ''}
      <p>${upgradeSelects(node, s.catalog) || '<span class="muted">aucune évolution</span>'}</p>
      ${links ? `<ul>${links}</ul>` : '<p class="muted">Aucun chemin.</p>'}
      <p>
        <button data-action="tool" data-tool="move" data-node="${esc(node.id)}">Déplacer</button>
        ${source ? '' : `<button data-action="remove-node" data-node="${esc(node.id)}">Retirer</button>`}
      </p>
    </section>`;
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
        ${s.game.replays > 0 ? ` · <b>${s.game.replays} rejeu(x)</b>, −${s.game.replays * 20} % au score` : ''}</p>
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
      const removable = def?.behavior !== 'source';
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
    .filter((d) => d.behavior !== 'source')
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
 * même chose en vrai, avec les termes d'entretien. La métaphore seule ne s'apprend pas.
 */
function speech(text: string, real?: string): string {
  return `<div class="speech"><span class="speaker">${theme.narrator.icon}</span>
    <div><p><b>${esc(theme.narrator.name)} :</b> « ${esc(text)} »</p>
    ${real ? `<p class="real">${esc(real)}</p>` : ''}</div></div>`;
}

/** L'analyse du narrateur : ce qu'il dit, l'explication d'entretien, la parade, la notion à réviser. */
function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) return '';
  return `<div class="findings">${findings
    .map(
      (f, i) => `<div class="finding ${f.tone}">
        ${i === 0 ? speech(f.says, f.tech) : `<p class="says">« ${esc(f.says)} »</p>${f.tech ? `<p class="real">${esc(f.tech)}</p>` : ''}`}
        ${f.remedy ? `<p><b>Parade :</b> ${esc(f.remedy)}</p>` : ''}
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
