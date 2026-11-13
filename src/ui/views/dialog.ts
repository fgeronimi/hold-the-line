import { starCount, type Stars } from '../../engine/score.ts';
import type { Wave } from '../../engine/types.ts';
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
  totalStars,
  type Attempt,
  type ViewState,
} from './common.ts';
import { icon, type IconName } from '../icons.ts';
import { CONCEPT_ACHIEVEMENTS, noHintId, type Achievement } from '../../data/achievements.ts';

/** Les fenêtres : le choix du scénario, le briefing du chambellan, le debrief d'une vague, les succès. */
export function renderDialog(s: ViewState): string {
  if (s.showAchievements) return renderAchievements(s);
  if (s.phase === 'choose') return renderChoose(s);
  const wave = s.scenario.waves[s.game.waveIndex];
  if (s.phase === 'briefing' && wave) {
    return `<div class="dialog panel">
      <h2>${s.practice ? 'Rejeu de la vague' : 'Vague'} ${s.game.waveIndex + 1} — ${esc(wave.title)}</h2>
      ${renderBriefing(wave, s)}
      <p class="actions"><button class="primary" data-action="start-build">Construire</button></p>
    </div>`;
  }
  if (s.phase !== 'debrief') return '';
  const a = s.attempts.find((x) => x.id === s.current);
  return a ? renderDebriefDialog(s, a) : '';
}

// ——— Le debrief ———

/**
 * Revoir la vague, puis la suite : vague suivante, réessayer, retour à la construction ou
 * nouvelle partie. Une vague tenue sans ses trois étoiles se rejoue sur place (E10).
 */
function debriefActions(s: ViewState, a: Attempt, finished: boolean): string {
  const won = a.result.won;
  const practice = !!s.practice;
  const back = practice ? (s.practice!.game.finished ? 'Retour à la partie' : `Retour à la vague ${s.practice!.game.waveIndex + 1}`) : '';
  const again = a.played && won && starCount(a.stars) < 3 ? `<button data-action="replay-wave" data-wave="${a.waveIndex}">Rejouer cette vague</button>` : '';
  return [
    `<button data-action="replay" data-attempt="${a.id}">Revoir la vague</button>`,
    again,
    a.played && !won ? '<button class="primary" data-action="retry">Réessayer</button>' : '',
    practice ? `<button class="${a.played && won ? 'primary' : ''}" data-action="leave-practice">${back}</button>` : '',
    !practice && a.played && won && !finished ? '<button class="primary" data-action="next">Vague suivante ➜</button>' : '',
    !a.played ? '<button class="primary" data-action="retry">Retour à la construction</button>' : '',
    !practice && finished ? '<button class="primary" data-action="reset-game">Nouvelle partie</button>' : '',
  ].join('');
}

function debriefTitle(a: Attempt): string {
  return `${a.result.won ? 'Vague tenue' : 'Vague perdue'}${a.played ? '' : ' (essai)'}`;
}

function debriefTabs(s: ViewState): string {
  return `<p class="tabs">
      <button data-action="debrief-tab" data-tab="analysis" ${activeClass(s.debriefTab === 'analysis')}>${icon('hat')} Analyse</button>
      <button data-action="debrief-tab" data-tab="charts" ${activeClass(s.debriefTab === 'charts')}>${icon('chart')} Courbes</button>
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
  const finished = s.game.finished && a.played && r.won && !s.practice;
  const lostHere = a.played && !r.won;
  const final = finished ? `<p class="final">${esc(theme.finale)} <b>${totalStars(s)} / ${s.scenario.waves.length * 3}</b> ★</p>` : '';
  // Une étoile manquée se reprend en rejouant la vague : le dire là où on la voit manquer.
  const missing = a.played && r.won && starCount(a.stars) < 3 ? `<p class="muted">${esc(theme.debrief.replayHint)}</p>` : '';
  return `<div class="dialog panel ${r.won ? 'won' : 'lost'}">
    <h2>${debriefTitle(a)}</h2>
    ${attemptWave ? renderStars(a.stars, attemptWave) : ''}
    ${renderUnlocked(s, a.unlocked ?? [])}
    ${debriefTabs(s)}
    ${final}
    ${attemptWave ? debriefBody(s, a, attemptWave) : ''}
    ${lostHere && a.waveIndex === s.game.waveIndex ? renderHints(hintsOf(s)) : ''}
    ${missing}
    <p class="actions">${debriefActions(s, a, finished)}</p>
  </div>`;
}

const TONE_ICONS: Record<Finding['tone'], string> = { good: icon('check'), warn: icon('warn'), bad: icon('close'), tip: icon('bulb') };

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
        ${f.remedy ? `<p>${icon('bulb')} <b>Parade :</b> ${esc(f.remedy)}</p>` : ''}
        ${f.signal ? `<p>${icon('target')} <b>Ce qui vous aurait prévenu :</b> ${esc(f.signal)}</p>` : ''}
        ${f.concept ? `<p class="muted">À réviser : ${esc(f.concept)}</p>` : ''}
      </div>`,
  );
  return `<div class="findings">${items.join('')}</div>`;
}

/** Les trois objectifs de la vague, chacun une étoile (décision E7). */
function renderStars(stars: Stars, wave: Wave): string {
  const line = (ok: boolean, label: string) => `<li class="${ok ? 'ok' : 'missed'}">${ok ? '★' : '☆'} ${esc(label)}</li>`;
  return `<div class="stars-box"><span class="star-row">${starIcons(starCount(stars))}</span><ul>
    ${line(stars.held, 'Tenir la vague : SLA, budget et complexité respectés')}
    ${line(stars.lean, 'Juste ce qu’il faut : rien qu’on puisse retirer en tenant la vague')}
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
  const all = allAchievements(s);
  const got = all.filter((a) => s.achievements[a.id]).length;
  return `<div class="dialog panel">
    <h2>Hold the Line</h2>
    ${speech(theme.choose.says, theme.choose.real)}
    <div class="scenario-cards">${s.choices.map(scenarioCard).join('')}</div>
    <p class="actions"><button data-action="show-achievements">${icon('medal')} Succès ${got} / ${all.length}</button></p>
  </div>`;
}

// ——— Les succès (I20) ———

/** Tous les succès : les concepts, puis « sans indice » pour chaque scénario. */
function allAchievements(s: ViewState): Achievement[] {
  const noHint = s.choices.map(
    (c): Achievement => ({
      id: noHintId(c.id),
      concept: 'Trouver par soi-même',
      tech: `Sans indice : ${capitalize(c.subtitle.replace(/^Hold the Line : /, ''))}`,
      metaphor: theme.achievements.noHint,
      real: theme.achievements.noHintReal,
      icon: 'bulb',
    }),
  );
  return [...CONCEPT_ACHIEVEMENTS, ...noHint];
}

function achievementCard(a: Achievement, got: boolean): string {
  return `<li class="ach${got ? '' : ' locked'}">
      ${icon(a.icon as IconName)}
      <span><b>${esc(a.tech)}</b> <em>(${esc(a.metaphor)})</em>
      <small>${got ? esc(a.real) : `À découvrir · ${esc(a.concept)}`}</small></span>
    </li>`;
}

/** La fenêtre des succès : ce que la cité sait faire, acquis en couleur, à découvrir grisés. */
function renderAchievements(s: ViewState): string {
  const all = allAchievements(s);
  const got = all.filter((a) => s.achievements[a.id]).length;
  return `<div class="dialog panel achievements-dialog">
    <h2>${icon('medal')} Succès · ${got} / ${all.length}</h2>
    ${speech(theme.achievements.says, theme.achievements.real)}
    <ul class="achievements">${all.map((a) => achievementCard(a, !!s.achievements[a.id])).join('')}</ul>
    <p class="actions"><button class="primary" data-action="show-achievements">Fermer</button></p>
  </div>`;
}

/** Au debrief, les succès que la vague vient de débloquer. */
function renderUnlocked(s: ViewState, ids: string[]): string {
  if (ids.length === 0) return '';
  const all = allAchievements(s);
  const items = ids.map((id) => all.find((a) => a.id === id)).filter((a): a is Achievement => !!a);
  return `<div class="unlocked"><p>${icon('medal')} <b>${esc(theme.achievements.unlocked)}</b></p>
    <ul class="achievements">${items.map((a) => achievementCard(a, true)).join('')}</ul></div>`;
}

// ——— Le briefing ———

function incidentLine(i: NonNullable<Wave['incidents']>[number], s: ViewState): string {
  return `<p class="incident">⚡ <b>Incident annoncé :</b> ${esc(i.title)}, ${minuteSpan(i.from, i.until)}. <i>${esc(nameOf(i.component, s.catalog))}</i></p>`;
}

const RATE_NAMES: Record<string, string> = { read: 'lectures', write: 'écritures', async: 'événements' };

/** Une source de trafic dite au joueur : qui, combien, et ce qu'elle demande par seconde. */
function trafficLine(src: Wave['sources'][number]): string {
  const who = `${fmt(src.clients)} clients${src.class === 'partner' ? ' partenaires' : ''}`;
  const traits = [src.abusive && 'abusifs', src.longTail && 'longue traîne', src.retries && 'qui relancent'].filter(Boolean).join(', ');
  const rates = Object.entries(src.rps)
    .filter(([, v]) => (v ?? 0) > 0)
    .map(([k, v]) => `${fmt(v ?? 0)} ${RATE_NAMES[k] ?? k}/s`)
    .join(', ');
  return `${who}${traits ? ` (${traits})` : ''} : ${rates}`;
}

function renderBriefing(wave: Wave, s: ViewState): string {
  const narrative = theme.narratives[wave.id];
  return `
    <section>
      ${narrative ? speech(narrative, wave.briefing) : `<p class="briefing">${esc(wave.briefing)}</p>`}
      ${s.scenario.waves[0]?.id === wave.id ? speech(theme.timeRule.says, theme.timeRule.real) : ''}
      ${(wave.incidents ?? []).map((i) => incidentLine(i, s)).join('')}
      <p>${icon('star')} Objectifs : tenir · rien de superflu · facture ≤ ${wave.thriftyCost ?? wave.budget}</p>
      <p>Budget ${wave.budget} · complexité max ${wave.complexityCap}
        · SLA : ${pct(wave.sla.maxFailureRate)} d'échecs, ${wave.sla.maxP95LatencyMs} ms p95</p>
      <p class="muted">Trafic : ${wave.sources.map(trafficLine).join(' · ')}</p>
    </section>`;
}

