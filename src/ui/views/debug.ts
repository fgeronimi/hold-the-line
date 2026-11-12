import { migrationCost } from '../../engine/budget.ts';
import type { LinkFlows } from '../../engine/routing.ts';
import type { Architecture, Gauge, SimEvent, Wave } from '../../engine/types.ts';
import { calibrationGroups, formatField, getAt, type FieldGroup } from '../calibration.ts';
import { draftInfo } from '../draft.ts';
import { upgradeSelects } from './card.ts';
import { activeClass, decimal as fmt, esc, findingsOf, pct, type Attempt, type ViewState } from './common.ts';
import { renderFindings } from './dialog.ts';

/** Le tiroir du mode debug : essais, vue tableau, calibrage, détail chiffré des tentatives. */
export function renderDebug(s: ViewState): string {
  if (!s.debug) return '';
  const tab = (id: ViewState['debugTab'], label: string) => `<button data-action="debug-tab" data-tab="${id}" ${activeClass(s.debugTab === id)}>${label}</button>`;
  return `<aside class="debug panel">
    <header><b>🔧 Debug</b> ${tab('attempts', 'Tentatives')} ${tab('table', 'Vue tableau')} ${tab('calibrate', 'Calibrage')}
      <button data-action="toggle-debug" title="Fermer (D)">✕</button></header>
    <div class="debug-body">${debugBody(s)}</div>
  </aside>`;
}

function debugBody(s: ViewState): string {
  const wave = s.scenario.waves[s.game.waveIndex];
  if (s.debugTab === 'calibrate') return renderCalibration(s);
  if (s.debugTab === 'table') return wave ? renderBuild(s, wave) : '';
  const tools =
    wave && s.phase === 'build'
      ? '<p><button data-action="try">Essai hors partie</button> <button data-action="revert">Revenir à l’architecture validée</button></p>'
      : '';
  return `${tools}${renderAttempts(s) || '<p class="muted">Aucune tentative pour l’instant.</p>'}`;
}

// ——— La vue tableau ———

function nodeRow(s: ViewState, n: Architecture['nodes'][number]): string {
  const def = s.catalog.components[n.type];
  const removable = def?.behavior !== 'source' && !n.fixed;
  const figures = def ? `cap. ${def.capacity}, ${def.latencyMs} ms, coût ${def.cost}, cx ${def.complexity}${def.hitRate !== undefined ? `, hit ${def.hitRate}` : ''}` : '';
  return `<tr>
        <td><code>${esc(n.id)}</code></td>
        <td>${esc(def?.techName ?? n.type)}</td>
        <td class="muted">${figures}</td>
        <td>${upgradeSelects(n, s.catalog)}</td>
        <td>${removable ? `<button data-action="remove-node" data-node="${esc(n.id)}">retirer</button>` : ''}</td>
      </tr>`;
}

function linkRow(l: Architecture['links'][number], i: number, flows: LinkFlows): string {
  return `<tr>
        <td><code>${esc(l.from)}</code> → <code>${esc(l.to)}</code></td>
        <td class="muted">${describeKinds(flows.get(`${l.from}→${l.to}`) ?? [])}</td>
        <td><button data-action="remove-link" data-link="${i}">retirer</button></td>
      </tr>`;
}

function renderBuild(s: ViewState, wave: Wave): string {
  const { catalog, draft } = s;
  const info = draftInfo(draft, catalog);
  const { validation, flows, complexity } = info;
  const fixed = info.cost;
  const migration = migrationCost(s.game.committed, draft, catalog);

  const nodeRows = draft.nodes.map((n) => nodeRow(s, n)).join('');
  const addable = Object.values(catalog.components)
    .filter((d) => d.behavior !== 'source' && !d.prePlaced)
    .map((d) => `<option value="${esc(d.id)}">${esc(d.techName)} — coût ${d.cost}</option>`)
    .join('');
  const nodeOptions = draft.nodes.map((n) => `<option value="${esc(n.id)}">${esc(n.id)}</option>`).join('');
  const linkRows = draft.links.map((l, i) => linkRow(l, i, flows)).join('');

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
        <pre>${esc(renderSchema(draft, flows, info.order))}</pre>
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

// ——— Le calibrage ———

function calibrationGroup(s: ViewState, g: FieldGroup): string {
  const root = g.root === 'catalog' ? s.catalog : s.scenario;
  const fields = g.fields
    .map(
      (f) =>
        `<label>${esc(f.label)} <input data-action="calibrate" data-root="${g.root}" data-path="${esc(f.path)}" ${f.list ? 'data-list="1"' : ''} value="${esc(formatField(getAt(root, f.path)))}" size="12"></label>`,
    )
    .join('');
  return `<fieldset><legend>${esc(g.title)}</legend>${fields}</fieldset>`;
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
        ${groups.map((g) => calibrationGroup(s, g)).join('')}
      </div>
    </section>`;
}

// ——— Les tentatives ———

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

function nodeLoadRow([id, n]: [string, Attempt['result']['nodes'][string]]): string {
  return `<tr${n.peakUtilization > 1 ? ' class="ko"' : ''}><td><code>${esc(id)}</code></td><td>${pct(n.peakUtilization)}</td><td>${n.saturatedTicks}</td><td>${fmt(n.failed)}</td></tr>`;
}

function renderDebrief(a: Attempt, s: ViewState): string {
  const r = a.result;
  const wave = s.scenario.waves[a.waveIndex];
  const nodes = Object.entries(r.nodes)
    .filter(([, n]) => n.peakUtilization > 0 || n.failed > 0)
    .sort(([, x], [, y]) => y.peakUtilization - x.peakUtilization);
  const reasons = Object.entries(r.failuresByReason).filter(([, v]) => v > 0);
  const replay = r.ticks.length > 0 ? `<p><button data-action="replay" data-attempt="${a.id}"><b>Voir la vague</b></button></p>` : '';
  const losses = r.lossReasons.length > 0 ? `<ul>${r.lossReasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const rewindNote =
    a.played && !r.won
      ? '<p>La vague se rejoue depuis l’architecture validée à la vague précédente. Si un choix plus ancien la rend impossible, revenir à une vague antérieure (en haut) : ça compte comme un rejeu.</p>'
      : '';
  return `
    <section class="${r.won ? 'won' : 'lost'}">
      <h2>${esc(a.label)} : ${r.won ? 'tenue' : 'perdue'}${a.played && r.won ? ` — ${fmt(a.score)} points` : ''}</h2>
      ${replay}
      ${losses}
      ${rewindNote}
      ${wave ? renderFindings(findingsOf(a, wave, s)) : ''}
      <div class="cols">
        <div>
          <h3>Jauges</h3>
          <table>
            <tr><th></th><th>valeur</th><th>limite</th><th>marge</th></tr>
            ${gaugeRow('coût', r.gauges.cost, fmt)}
            ${gaugeRow('complexité', r.gauges.complexity, fmt)}
            ${gaugeRow("taux d'échec", r.gauges.failureRate, pct)}
            ${gaugeRow('latence p95', r.gauges.latency, (v) => `${fmt(v)} ms`)}
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
            ${nodes.map(nodeLoadRow).join('')}
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
  const row = (label: string, f: (a: Attempt) => string) => `<tr><th>${label}</th>${attempts.map((a) => `<td>${f(a)}</td>`).join('')}</tr>`;
  const heads = attempts.map((a) => `<th><button data-action="select" data-attempt="${a.id}">${esc(a.label)}</button></th>`).join('');
  const settings = (a: Attempt) => (a.settings.length > 0 ? a.settings.map(esc).join('<br>') : '<span class="muted">aucun</span>');
  return `<table class="compare">
    <tr><th></th>${heads}</tr>
    ${row('résultat', (a) => (a.result.won ? 'tenue' : '<span class="ko">perdue</span>'))}
    ${row('coût', (a) => `${fmt(a.result.gauges.cost.value)} / ${a.result.gauges.cost.limit}`)}
    ${row('complexité', (a) => `${a.result.gauges.complexity.value} / ${a.result.gauges.complexity.limit}`)}
    ${row("taux d'échec", (a) => pct(a.result.gauges.failureRate.value))}
    ${row('latence p95', (a) => `${fmt(a.result.gauges.latency.value)} ms`)}
    ${row('score', (a) => (a.played ? fmt(a.score) : '—'))}
    ${row('réglages modifiés', (a) => settings(a))}
  </table>`;
}
