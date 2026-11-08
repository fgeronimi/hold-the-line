import { bill, migrationCost } from '../engine/budget.ts';
import type { GameState } from '../engine/game.ts';
import type { Architecture, Catalog, Gauge, Scenario, SimEvent, Wave, WaveResult } from '../engine/types.ts';
import { linkFlows, type LinkFlows } from '../engine/routing.ts';
import { validateArchitecture } from '../engine/validate.ts';
import { fortifiedCity as theme } from '../data/themes/fortified-city.ts';
import { calibrationGroups, formatField, getAt } from './calibration.ts';
import { analyzeWave, type Finding } from './debrief.ts';


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
}

/** Outil actif sur le plateau. */
export type Tool =
  | { kind: 'select' }
  | { kind: 'place'; type: string }
  | { kind: 'link'; from?: string | undefined }
  | { kind: 'move'; id: string }
  | { kind: 'remove' };

export interface ViewState {
  catalog: Catalog;
  scenario: Scenario;
  game: GameState;
  draft: Architecture;
  attempts: Attempt[];
  selected?: number | undefined;
  tab: 'build' | 'calibrate';
  tool: Tool;
  /** Bâtiment dont la fiche est ouverte dans le panneau. */
  selectedNode?: string | undefined;
  /** Dernier refus ou conseil du plateau (case occupée, chemin impossible…). */
  boardMessage?: string | undefined;
  /** Les tableaux de composants et de liens, repliés par défaut. */
  showTable: boolean;
  /** Tentative en cours de rejeu sur le plateau. */
  replaying?: number | undefined;
}

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const pct = (n: number) => `${(n * 100).toFixed(2)} %`;

/** En-tête et briefing, au-dessus du plateau. */
export function renderTop(s: ViewState): string {
  const wave = s.scenario.waves[s.game.waveIndex];
  return `
    <header>
      <h1>${esc(s.scenario.subtitle)} <small>${esc(s.scenario.title)}</small></h1>
      <p>Score : <b>${fmt(s.game.scores.reduce((a, x) => a + x, 0))}</b>
        · vagues gagnées : ${s.game.scores.length} / ${s.scenario.waves.length}
        · <button data-action="reset-game">Nouvelle partie</button>
        ${s.game.history
          .slice(0, s.game.waveIndex)
          .map((_, i) => `<button data-action="rewind" data-wave="${i}">Revenir à la vague ${i + 1}</button>`)
          .join(' ')}</p>
      <nav>
        <button data-action="tab" data-tab="build" ${s.tab === 'build' ? 'disabled' : ''}>Construction</button>
        <button data-action="tab" data-tab="calibrate" ${s.tab === 'calibrate' ? 'disabled' : ''}>Calibrage</button>
      </nav>
    </header>
    ${wave ? renderBriefing(wave, s) : '<section><h2>Partie terminée</h2></section>'}`;
}

/** Sous le plateau : debrief, vue tableau, calibrage. */
export function renderBottom(s: ViewState): string {
  const wave = s.scenario.waves[s.game.waveIndex];
  return `
    ${renderAttempts(s)}
    ${s.tab === 'calibrate' ? renderCalibration(s) : ''}
    ${s.tab === 'build' && wave ? `<section><button data-action="toggle-table">${s.showTable ? 'Masquer' : 'Afficher'} la vue tableau</button></section>${s.showTable ? renderBuild(s, wave) : ''}` : ''}`;
}

/** Le panneau à côté du plateau : outils, palette, fiche du bâtiment, facture, lancement. */
export function renderSide(s: ViewState): string {
  const wave = s.scenario.waves[s.game.waveIndex];
  if (s.replaying !== undefined) return '<p class="muted">Rejeu en cours sur le plateau. « Retour à la construction » pour reprendre.</p>';
  if (!wave) return '<p>Partie terminée : revenir à une vague, ou nouvelle partie.</p>';
  const { catalog, draft, tool } = s;
  const active = (t: Tool['kind'], type?: string) =>
    tool.kind === t && (type === undefined || (tool.kind === 'place' && tool.type === type)) ? ' class="active"' : '';

  const palette = Object.values(catalog.components)
    .filter((d) => d.behavior !== 'source')
    .map(
      (d) => `<button data-action="tool" data-tool="place" data-type="${esc(d.id)}"${active('place', d.id)}>
        <b>${esc(theme.buildings[d.id]?.metaphor ?? d.techName)}</b><span>${esc(d.techName)} · coût ${d.cost}</span></button>`,
    )
    .join('');

  const hint: Record<Tool['kind'], string> = {
    select: 'Cliquer un bâtiment pour ouvrir sa fiche. Glisser pour déplacer la vue, molette pour zoomer.',
    place: 'Cliquer une case libre pour bâtir. Échap pour arrêter.',
    link: tool.kind === 'link' && tool.from ? `Départ : ${tool.from}. Cliquer le bâtiment d'arrivée.` : 'Cliquer le bâtiment de départ, puis celui d’arrivée.',
    move: 'Cliquer la case où déplacer le bâtiment.',
    remove: 'Cliquer un bâtiment pour le retirer, avec ses chemins.',
  };

  return `
    <h3>Outils</h3>
    <p class="tools">
      <button data-action="tool" data-tool="select"${active('select')}>Sélection</button>
      <button data-action="tool" data-tool="link"${active('link')}>Relier</button>
      <button data-action="tool" data-tool="remove"${active('remove')}>Retirer</button>
    </p>
    <p class="muted">${esc(hint[tool.kind])}</p>
    ${s.boardMessage ? `<p class="ko">${esc(s.boardMessage)}</p>` : ''}
    <h3>Bâtir</h3>
    <div class="palette">${palette}</div>
    ${renderNodeCard(s)}
    ${renderLaunch(s, wave)}`;
}

function renderNodeCard(s: ViewState): string {
  const node = s.draft.nodes.find((n) => n.id === s.selectedNode);
  if (!node) return '';
  const def = s.catalog.components[node.type];
  const links = s.draft.links
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.from === node.id || l.to === node.id)
    .map(({ l, i }) => `<li><code>${esc(l.from)}</code> → <code>${esc(l.to)}</code> <button data-action="remove-link" data-link="${i}">retirer</button></li>`)
    .join('');
  const source = def?.behavior === 'source';
  return `
    <section class="card">
      <h3>${esc(theme.buildings[node.type]?.metaphor ?? node.type)} <small>${esc(def?.techName ?? '')} · ${esc(node.id)}</small></h3>
      ${def ? `<p class="muted">cap. ${def.capacity}, ${def.latencyMs} ms, coût ${def.cost}, complexité ${def.complexity}</p>` : ''}
      <p>${upgradeSelects(node, s.catalog) || '<span class="muted">aucune évolution</span>'}</p>
      ${links ? `<ul>${links}</ul>` : '<p class="muted">Aucun chemin.</p>'}
      <p>
        <button data-action="tool" data-tool="move" data-node="${esc(node.id)}">Déplacer</button>
        ${source ? '' : `<button data-action="remove-node" data-node="${esc(node.id)}">Retirer</button>`}
      </p>
    </section>`;
}

function renderLaunch(s: ViewState, wave: Wave): string {
  const { catalog, draft } = s;
  const validation = validateArchitecture(draft, catalog);
  const lines = bill(draft, catalog);
  const fixed = lines.reduce((a, l) => a + l.cost, 0);
  const complexity = lines.reduce((a, l) => a + l.complexity, 0);
  const migration = migrationCost(s.game.committed, draft, catalog);
  const over = (v: number, max: number) => (v > max ? ' class="ko"' : '');
  return `
    <h3>Facture prévue</h3>
    <p><span${over(fixed + migration, wave.budget)}>coût ${fmt(fixed)}${migration > 0 ? ` + ${fmt(migration)} de migration` : ''} / ${wave.budget}</span><br>
      <span${over(complexity, wave.complexityCap)}>complexité ${complexity} / ${wave.complexityCap}</span></p>
    ${validation.ok ? '' : `<ul class="ko">${validation.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`}
    <p class="launch">
      <button data-action="play" ${validation.ok ? '' : 'disabled'}><b>Lancer la vague</b></button>
      <button data-action="try" ${validation.ok ? '' : 'disabled'}>Essai (hors partie)</button>
      <button data-action="revert">Revenir à l'architecture validée</button>
    </p>`;
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
      <h2>Vague ${s.game.waveIndex + 1} — ${esc(wave.title)}</h2>
      ${theme.narratives[wave.id] ? speech(theme.narratives[wave.id]!) : ''}
      <p class="briefing">${esc(wave.briefing)}</p>
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

/** Une réplique du narrateur, avec son portrait. */
function speech(text: string): string {
  return `<div class="speech"><span class="speaker">${theme.narrator.icon}</span>
    <p><b>${esc(theme.narrator.name)} :</b> « ${esc(text)} »</p></div>`;
}

/** L'analyse du narrateur : ce qu'il dit, l'explication d'entretien, la parade, la notion à réviser. */
function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) return '';
  return `<div class="findings">${findings
    .map(
      (f, i) => `<div class="finding ${f.tone}">
        ${i === 0 ? speech(f.says) : `<p class="says">« ${esc(f.says)} »</p>`}
        ${f.tech ? `<p>${esc(f.tech)}</p>` : ''}
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
