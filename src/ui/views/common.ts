import type { GameState } from '../../engine/game.ts';
import { starCount, type Stars } from '../../engine/score.ts';
import type { Architecture, BoardCell, Catalog, Scenario, Wave, WaveResult } from '../../engine/types.ts';
import { fortifiedCity as theme } from '../../data/themes/fortified-city.ts';
import { escapeHtml, percentPrecise } from '../../render/html.ts';
import { analysisOf, type Analysis, type Finding } from '../debrief.ts';
import { SCENARIOS } from '../../data/scenarios/index.ts';
import { hintPanel, type HintPanel } from '../hints.ts';
import { icon } from '../icons.ts';
import { guideStep, type TutorialStep } from '../tutorial.ts';
import type { Unlocked } from '../session.ts';

/**
 * Ce que partagent les calques de l'interface : l'état qu'ils rendent, l'échappement, les
 * formats, la bulle du narrateur. Chaque calque vit dans son module, à côté de celui-ci.
 */

export interface Attempt {
  id: number;
  label: string;
  waveIndex: number;
  result: WaveResult;
  /** Une tentative jouée compte dans la partie ; un essai sert seulement à comparer. */
  played: boolean;
  /** Réglages de calibrage différents du code au moment de la tentative. */
  settings: string[];
  /** Architecture jouée, pour la rejouer en 3D. */
  arch: Architecture;
  /** Objectifs atteints par cette tentative (E7). */
  stars: Stars;
  /** L'analyse du chambellan, calculée à l'enregistrement (`analysisOf`). */
  analysis?: Analysis | undefined;
  /** Les succès que cette tentative a débloqués, montrés à son debrief (I20). */
  unlocked?: string[] | undefined;
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
  /**
   * Un rejeu de vague tenue en cours (E10) : `game` est alors la partie de travail, et la vraie
   * partie attend ici avec son brouillon. `before` : les étoiles de la vraie partie avant le
   * dernier rejeu joué, que la barre du haut montre pendant la vague.
   */
  practice?: { game: GameState; draft: Architecture; before?: number } | undefined;
  attempts: Attempt[];
  /** Les succès débloqués, toutes parties confondues (I20) ; gardés dans le magasin. */
  achievements: Unlocked;
  /** La fenêtre des succès est ouverte, par-dessus le reste. */
  showAchievements?: boolean | undefined;
  /** L'accueil (P4) : au premier lancement, puis à la demande. */
  showWelcome?: boolean | undefined;
  /** Le bilan d'un scénario terminé, par-dessus le reste. */
  showReview?: boolean | undefined;
  /** Tentative mise en avant dans le détail du mode debug. */
  selected?: number | undefined;
  tool: Tool;
  /** Bâtiment dont la fiche est ouverte. */
  selectedNode?: string | undefined;
  /** Case vide cliquée : les fiches des bâtiments qu'on peut y construire sont ouvertes. */
  buildAt?: BoardCell | undefined;
  /** La main ouverte par « Bâtir », sans case : la carte choisie arme l'outil qui pose. */
  showHand?: boolean | undefined;
  /** Au toucher, la carte soulevée par un premier contact : le second la joue. */
  liftedCard?: string | undefined;
  /** Les miniatures des bâtiments, rendues par le plateau une fois chargé ; sans elles, l'icône du thème. */
  thumbnails?: Record<string, string> | undefined;
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

export { theme };

/** Le dépôt : le code, le README et les décisions, pour qui arrive par le jeu. */
export const REPOSITORY = 'https://github.com/fgeronimi/hold-the-line';
export const repositoryLink = (label: string, className = '') =>
  `<a class="${className}" href="${REPOSITORY}" target="_blank" rel="noopener">${label}</a>`;

/** L'échappement du rendu, pour tout ce qui vient de l'état (nombres compris). */
export const esc = (s: unknown) => escapeHtml(String(s));

/** Un entier tel quel, sinon une décimale : « 12 », « 12.5 ». */
export const decimal = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
/** Les taux du détail chiffré, à deux décimales. */
export const pct = percentPrecise;

/** Les étoiles de la vraie partie, même pendant un rejeu : c'est elle qu'on remplit. */
export const realGame = (s: ViewState) => s.practice?.game ?? s.game;
export const totalStars = (s: ViewState) => realGame(s).stars.reduce((a, x) => a + starCount(x), 0);
export const starIcons = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);
/** La classe `active` d'un bouton ou d'un onglet, ou rien. */
export const activeClass = (on: boolean) => (on ? 'class="active"' : '');
/** La classe qui fait clignoter ce que désigne le guide ou l'aide. */
export const hintClass = (on: boolean) => (on ? ' hint' : '');

/** Nom technique d'abord, la métaphore entre parenthèses. */
export function nameOf(type: string, catalog: Catalog): string {
  const tech = catalog.components[type]?.techName ?? type;
  const metaphor = theme.buildings[type]?.metaphor;
  return metaphor ? `${tech} (${metaphor})` : tech;
}

/** L'aide de la vague en cours (décision I14) : indices donnés, bouton, ce qui clignote. */
export const hintsOf = (s: ViewState): HintPanel => hintPanel({ game: s.game, scenario: s.scenario, catalog: s.catalog, draft: s.draft }, theme);

/** Le pas-à-pas de la vague en cours, ou rien hors de la construction. */
export function guideOf(s: ViewState): TutorialStep | undefined {
  const wave = s.scenario.waves[s.game.waveIndex];
  if (s.phase !== 'build' || !wave) return undefined;
  // Le pas-à-pas ne guide que la toute première vague du jeu, pas son rejeu.
  const firstWaveOfGame = s.game.waveIndex === 0 && s.scenario.id === SCENARIOS[0]!.scenario.id && !s.practice;
  return guideStep(s.draft, s.catalog, wave, s.game.waveIndex, s.game.committed, firstWaveOfGame);
}

/** Ce qui clignote : le dernier indice demandé, tant qu'il reste à faire, passe avant le pas-à-pas. */
export const blinkOf = (s: ViewState): TutorialStep['highlight'] => hintsOf(s).highlight ?? guideOf(s)?.highlight;

/** Les bâtiments que le joueur peut construire : ni la source, ni les services déjà en place. */
export const buildable = (catalog: Catalog) => Object.values(catalog.components).filter((d) => d.behavior !== 'source' && !d.prePlaced);

/**
 * Refaites après un calibrage du mode debug, les analyses sont gardées à côté de la
 * tentative, le temps qu'elle vit : un rendu suivant ne les recalcule pas.
 */
const recalibrated = new WeakMap<Attempt, Analysis>();

/** Les constats d'une tentative : ceux gardés sur elle, sauf si le calibrage les a rendus caducs. */
export function findingsOf(a: Attempt, wave: Wave, s: ViewState): Finding[] {
  const analysis = analysisOf(recalibrated.get(a) ?? a.analysis, a, wave, s.catalog, theme);
  if (analysis !== a.analysis) recalibrated.set(a, analysis);
  return analysis.findings;
}

/** Le visage du narrateur : son portrait, chemin relatif au site (`base: './'`). */
export const narratorFace = () => `<img class="face" src="${esc(theme.narrator.portrait)}" alt="" draggable="false">`;

/** Une bulle : ce qui est dit, puis, sous un filet, la même chose en vrai (décision I6, présentation I22). */
export const bubble = (said: string, real?: string) =>
  `<div class="bubble"><p class="line">${said}</p>${real ? `<p class="real">${esc(real)}</p>` : ''}</div>`;

/**
 * Double narration : le chambellan parle dans la métaphore ; sous un filet, dans la même
 * bulle, la même chose en vrai, avec les termes techniques. La métaphore seule ne s'apprend pas.
 */
export function speech(text: string, real?: string): string {
  return `<div class="speech"><span class="speaker">${narratorFace()}</span>
    ${bubble(`<b>${esc(theme.narrator.name)} :</b> « ${esc(text)} »`, real)}</div>`;
}

/**
 * Les indices déjà donnés, puis le bouton qui en demande un de plus : un par essai perdu.
 * Grisé, il dit pourquoi. Sous la bulle de la fenêtre « que faire », et au debrief d'une
 * vague perdue.
 */
export function renderHints(panel: HintPanel): string {
  const items = panel.given.map(givenHint).join('');
  const note = panel.button.why ?? `${panel.left} indice${panel.left > 1 ? 's' : ''} disponible${panel.left > 1 ? 's' : ''}`;
  return `<div class="hints">
    ${items ? `<ol>${items}</ol>` : ''}
    <p class="hint-ask"><button data-action="hint" ${panel.button.enabled ? '' : 'disabled'} title="${esc(note)}">${icon('bulb')} Un indice</button>
      <small class="muted">${esc(note)}</small></p>
  </div>`;
}

function givenHint({ text, done }: HintPanel['given'][number]): string {
  return `<li class="${done ? 'done' : 'todo'}">${bubble(`${icon(done ? 'check' : 'bulb')} « ${esc(text.says)} »${done ? ' <small>fait</small>' : ''}`, text.real)}</li>`;
}
