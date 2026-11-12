import type { Stars } from '../../engine/score.ts';
import type { Wave } from '../../engine/types.ts';
import { scoring } from '../../data/scoring.ts';
import { chartModel, renderChart } from '../../render/charts.ts';
import type { Finding } from '../debrief.ts';
import { draftInfo } from '../draft.ts';
import { minuteSpan } from '../time.ts';
import {
  activeClass,
  decimal as fmt,
  esc,
  findingsOf,
  hintsOf,
  nameOf,
  pct,
  renderHints,
  speech,
  starIcons,
  theme,
  totalScore,
  totalStars,
  type Attempt,
  type ViewState,
} from './common.ts';

/** Les fenêtres : le choix du scénario, le briefing du chambellan, le debrief d'une vague. */
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
  return a ? renderDebriefDialog(s, a) : '';
}

// ——— Le debrief ———

/** Revoir la vague, puis la suite : vague suivante, réessayer, retour à la construction ou nouvelle partie. */
function debriefActions(a: Attempt, finished: boolean): string {
  const won = a.result.won;
  return [
    `<button data-action="replay" data-attempt="${a.id}">🔁 Revoir la vague</button>`,
    a.played && won && !finished ? '<button class="primary" data-action="next">Vague suivante ➜</button>' : '',
    a.played && !won ? '<button class="primary" data-action="retry">Réessayer 🔨</button>' : '',
    !a.played ? '<button class="primary" data-action="retry">Retour à la construction</button>' : '',
    finished ? '<button class="primary" data-action="reset-game">Nouvelle partie</button>' : '',
  ].join('');
}

function debriefTitle(a: Attempt): string {
  const won = a.result.won;
  return `${won ? '🏆 Vague tenue' : '💥 Vague perdue'}${a.played && won ? ` — +${fmt(a.score)} 🏅` : ''}${a.played ? '' : ' (essai)'}`;
}

function debriefTabs(s: ViewState): string {
  return `<p class="tabs">
      <button data-action="debrief-tab" data-tab="analysis" ${activeClass(s.debriefTab === 'analysis')}>${theme.narrator.icon} Analyse</button>
      <button data-action="debrief-tab" data-tab="charts" ${activeClass(s.debriefTab === 'charts')}>📈 Courbes</button>
    </p>`;
}

/** L'onglet ouvert : l'analyse du chambellan, gardée sur la tentative, ou les courbes. */
function debriefBody(s: ViewState, a: Attempt, wave: Wave): string {
  if (s.debriefTab !== 'charts') return renderFindings(findingsOf(a, wave, s));
  const model = chartModel(a.result, a.arch, wave, s.catalog, theme, draftInfo(a.arch, s.catalog).order);
  return `${renderChart(model)}<p class="muted">Survoler pour lire chaque minute. La courbe d’un bâtiment passe en rouge au-delà de sa capacité ; les barres rouges sont les requêtes en échec, les bandes orange les incidents.</p>`;
}

function renderDebriefDialog(s: ViewState, a: Attempt): string {
  const r = a.result;
  const attemptWave = s.scenario.waves[a.waveIndex];
  const finished = s.game.finished && a.played && r.won;
  const lostHere = a.played && !r.won;
  const final = finished
    ? `<p class="final">La cité a tenu toutes les vagues. <b>${totalStars(s)} / ${s.scenario.waves.length * 3}</b> ★, score final <b>${fmt(totalScore(s))}</b> 🏅</p>`
    : '';
  const penalty =
    lostHere && s.game.replays > 0
      ? `<p class="muted">Chaque nouvel essai coûte ${Math.round(scoring.replayPenalty * 100)} % des points de la vague, jusqu’à ne plus en rapporter ; les étoiles restent à prendre. Si un choix plus ancien bloque, le menu ☰ permet de revenir à une vague antérieure.</p>`
      : '';
  return `<div class="dialog panel ${r.won ? 'won' : 'lost'}">
    <h2>${debriefTitle(a)}</h2>
    ${attemptWave ? renderStars(a.stars, attemptWave) : ''}
    ${debriefTabs(s)}
    ${final}
    ${attemptWave ? debriefBody(s, a, attemptWave) : ''}
    ${lostHere && a.waveIndex === s.game.waveIndex ? renderHints(hintsOf(s)) : ''}
    ${penalty}
    <p class="actions">${debriefActions(a, finished)}</p>
  </div>`;
}

const TONE_ICONS: Record<Finding['tone'], string> = { good: '✅', warn: '⚡', bad: '❌', tip: '💡' };

/** Le premier constat parle dans la bulle du narrateur, les suivants en dessous. */
function findingLine(f: Finding, first: boolean): string {
  if (first) return speech(f.says, f.tech);
  return `<p class="says">${TONE_ICONS[f.tone]} « ${esc(f.says)} »</p>${f.tech ? `<p class="real">${esc(f.tech)}</p>` : ''}`;
}

/** L'analyse du narrateur : ce qu'il dit, l'explication technique, la parade, la notion à réviser. */
export function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) return '';
  const items = findings.map(
    (f, i) => `<div class="finding ${f.tone}">
        ${findingLine(f, i === 0)}
        ${f.remedy ? `<p>💡 <b>Parade :</b> ${esc(f.remedy)}</p>` : ''}
        ${f.concept ? `<p class="muted">À réviser : ${esc(f.concept)}</p>` : ''}
      </div>`,
  );
  return `<div class="findings">${items.join('')}</div>`;
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

// ——— Le choix du scénario ———

const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function scenarioCard(c: ViewState['choices'][number]): string {
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
}

/** L'écran de choix du scénario, sans verrou (décision S2). */
function renderChoose(s: ViewState): string {
  return `<div class="dialog panel">
    <h2>Hold the Line</h2>
    ${speech(theme.choose.says, theme.choose.real)}
    <div class="scenario-cards">${s.choices.map(scenarioCard).join('')}</div>
  </div>`;
}

// ——— Le briefing ———

function incidentLine(i: NonNullable<Wave['incidents']>[number], s: ViewState): string {
  return `<p class="incident">⚡ <b>Incident annoncé :</b> ${esc(i.title)}, ${minuteSpan(i.from, i.until)}. <i>${esc(nameOf(i.component, s.catalog))}</i></p>`;
}

function trafficLine(src: Wave['sources'][number]): string {
  const traits = `${src.abusive ? ', abusif' : ''}${src.longTail ? ', longue traîne' : ''}`;
  const rates = Object.entries(src.rps)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  return `${esc(src.id)} (${src.clients} clients${traits}) : ${rates} req/s`;
}

function renderBriefing(wave: Wave, s: ViewState): string {
  const narrative = theme.narratives[wave.id];
  const replays = s.game.replays > 0 ? ` · <b>${s.game.replays} rejeu(x)</b>, ${replayCut(s.game.replays)}` : '';
  return `
    <section>
      ${narrative ? speech(narrative, wave.briefing) : `<p class="briefing">${esc(wave.briefing)}</p>`}
      ${s.scenario.waves[0]?.id === wave.id ? speech(theme.timeRule.says, theme.timeRule.real) : ''}
      ${(wave.incidents ?? []).map((i) => incidentLine(i, s)).join('')}
      <p>⭐ Objectifs : tenir · du premier coup · facture ≤ ${wave.thriftyCost ?? wave.budget}</p>
      <p>Budget ${wave.budget} · complexité max ${wave.complexityCap}
        · SLA : ${pct(wave.sla.maxFailureRate)} d'échecs, ${wave.sla.maxP95LatencyMs} ms p95
        ${replays}</p>
      <p class="muted">Trafic : ${wave.sources.map(trafficLine).join(' · ')}</p>
    </section>`;
}

/** Ce que les rejeux retirent au score de la vague : jamais plus que ses points (décision E5). */
export function replayCut(replays: number): string {
  const cut = Math.min(1, replays * scoring.replayPenalty);
  return cut >= 1 ? 'la vague ne rapporte plus de points' : `−${Math.round(cut * 100)} % au score`;
}
