import { starCount, type Stars } from '../../engine/score.ts';
import type { Wave } from '../../engine/types.ts';
import { chartModel, renderChart } from '../../render/charts.ts';
import type { Finding } from '../debrief.ts';
import { draftInfo } from '../draft.ts';
import { minuteSpan } from '../time.ts';
import {
  activeClass,
  bubble,
  narratorFace,
  decimal as fmt,
  esc,
  findingsOf,
  hintsOf,
  nameOf,
  pct,
  realGame,
  repositoryLink,
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
import { scenarioReview, type WaveReview } from '../review.ts';

/** Les fenêtres : le choix du scénario, le briefing du chambellan, le debrief d'une vague, les succès. */
export function renderDialog(s: ViewState): string {
  if (s.showWelcome) return renderWelcome();
  if (s.showAchievements) return renderAchievements(s);
  if (s.showReview && realGame(s).finished) return renderReview(s);
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
    !practice && finished ? '<button data-action="reset-game">Nouvelle partie</button>' : '',
    !practice && finished ? `<button class="primary" data-action="show-review">${icon('ledger')} Voir le bilan</button>` : '',
  ].join('');
}

function debriefTitle(a: Attempt): string {
  return `${a.result.won ? 'Vague tenue' : 'Vague perdue'}${a.played ? '' : ' (essai)'}`;
}

function debriefTabs(s: ViewState): string {
  return `<p class="tabs">
      <button data-action="debrief-tab" data-tab="analysis" ${activeClass(s.debriefTab === 'analysis')}>${narratorFace()} Analyse</button>
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
  // Une étoile manquée se reprend en rejouant la vague : le dire là où on la voit manquer.
  const missing = a.played && r.won && starCount(a.stars) < 3 ? `<p class="muted">${esc(theme.debrief.replayHint)}</p>` : '';
  return `<div class="dialog panel ${r.won ? 'won' : 'lost'}">
    <h2>${debriefTitle(a)}</h2>
    ${attemptWave ? renderStars(a.stars, attemptWave) : ''}
    ${renderUnlocked(s, a.unlocked ?? [])}
    ${debriefTabs(s)}
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
  return bubble(`${TONE_ICONS[f.tone]} « ${esc(f.says)} »`, f.tech);
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

/** Les trois objectifs d'une vague (décision E7), comme le debrief, l'accueil et le bilan les nomment. */
const STAR_LABELS = {
  held: 'Tenir la vague : SLA, budget et complexité respectés',
  lean: 'Juste ce qu’il faut : rien qu’on puisse retirer en tenant la vague',
  thrifty: 'Économe',
} as const;

/** Les trois objectifs de la vague, chacun une étoile (décision E7). */
function renderStars(stars: Stars, wave: Wave): string {
  const line = (ok: boolean, label: string) => `<li class="${ok ? 'ok' : 'missed'}">${ok ? '★' : '☆'} ${esc(label)}</li>`;
  return `<div class="stars-box"><span class="star-row">${starIcons(starCount(stars))}</span><ul>
    ${line(stars.held, STAR_LABELS.held)}
    ${line(stars.lean, STAR_LABELS.lean)}
    ${line(stars.thrifty, `${STAR_LABELS.thrifty} : facture ≤ ${wave.thriftyCost ?? wave.budget}`)}
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
    <p class="actions"><button data-action="show-welcome">${icon('bulb')} Comment jouer</button><button data-action="show-achievements">${icon('medal')} Succès ${got} / ${all.length}</button></p>
  </div>`;
}

// ——— L'accueil (P4) ———

/** Le premier écran : le chambellan en pied, ce qu'est le jeu, comment se joue une vague. */
function renderWelcome(): string {
  const w = theme.welcome;
  const steps = w.steps.map((st, i) => `<li>${icon(st.icon as IconName)}<span><b>${i + 1}. ${esc(st.title)}</b>${esc(st.text)}</span></li>`).join('');
  return `<div class="dialog panel welcome">
    <div class="welcome-head">
      <img class="narrator-full" src="${esc(theme.narrator.full)}" alt="${esc(theme.narrator.name)}" draggable="false">
      <div class="welcome-text">
        <h2>${esc(w.title)}</h2>
        ${bubble(`<b>${esc(theme.narrator.name)} :</b> « ${esc(w.says)} »`, w.real)}
      </div>
    </div>
    <ol class="welcome-steps">${steps}</ol>
    <ul class="welcome-stars"><li>★ ${esc(STAR_LABELS.held)}</li><li>★ ${esc(STAR_LABELS.lean)}</li><li>★ ${esc(STAR_LABELS.thrifty)} : la facture sous un seuil</li></ul>
    <p class="actions"><span class="welcome-source">${repositoryLink('Code source et explications sur GitHub')}</span><button class="primary" data-action="show-welcome">${esc(w.start)}</button></p>
  </div>`;
}

// ——— Le bilan (P4) ———

const MISSING: Record<keyof Stars, string> = { held: 'tenir la vague', lean: 'rien de superflu', thrifty: 'économe' };

function conceptChips(list: Achievement[]): string {
  return list.length === 0 ? '<span class="muted">—</span>' : list.map((a) => `<span class="chip" data-tip="${esc(a.real)}">${icon(a.icon as IconName)} ${esc(a.tech)}</span>`).join('');
}

/** Sur un téléphone, l'en-tête du tableau disparaît : chaque cellule redit sa colonne (`data-label`). */
function reviewRow(w: WaveReview): string {
  const r = theme.review;
  return `<tr>
      <th>${w.index + 1}. ${esc(w.title)}</th>
      <td class="star-row">${starIcons(starCount(w.stars))}</td>
      <td data-label="${esc(r.applied)}">${conceptChips(w.fresh)}</td>
      <td data-label="${esc(r.alternatives)}"${w.alternatives.length === 0 ? ' class="empty"' : ''}>${conceptChips(w.alternatives)}</td>
    </tr>`;
}

/** Le bilan d'un scénario terminé : vague par vague, les notions appliquées, les autres parades, ce qui reste à revoir. */
function renderReview(s: ViewState): string {
  const game = realGame(s);
  const review = scenarioReview(game, s.scenario, s.catalog);
  const r = theme.review;
  const missing = (w: WaveReview) =>
    (Object.keys(MISSING) as (keyof Stars)[])
      .filter((k) => !w.stars[k])
      .map((k) => MISSING[k])
      .join(', ');
  const todo =
    review.incomplete.length === 0
      ? `<p class="muted">${esc(r.done)}</p>`
      : `<ul class="review-todo">${review.incomplete
          .map((w) => `<li>Vague ${w.index + 1}, ${esc(w.title)} : ${esc(missing(w))} <button data-action="replay-wave" data-wave="${w.index}">Rejouer la vague</button></li>`)
          .join('')}</ul>`;
  return `<div class="dialog panel review-dialog">
    <h2>${icon('ledger')} ${esc(r.title)} · ${esc(s.scenario.title)} · ${review.stars} / ${review.maxStars} ★</h2>
    ${speech(r.says, r.real)}
    <table class="review"><thead><tr><th>Vague</th><th>Étoiles</th><th>${esc(r.applied)}</th><th>${esc(r.alternatives)}</th></tr></thead>
      <tbody>${review.waves.map(reviewRow).join('')}</tbody></table>
    <h3>${esc(r.toReview)}</h3>
    ${todo}
    <p class="actions"><button data-action="choose-scenario">Choisir un autre scénario</button><button data-action="reset-game">Nouvelle partie</button><button class="primary" data-action="show-review">Fermer</button></p>
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
  return `<p class="incident">${icon('bolt')} <b>Incident annoncé :</b> ${esc(i.title)}, ${minuteSpan(i.from, i.until)}. <i>${esc(nameOf(i.component, s.catalog))}</i></p>`;
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

