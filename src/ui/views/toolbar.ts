import { draftInfo } from '../draft.ts';
import type { TutorialStep } from '../tutorial.ts';
import { icon, type IconName } from '../icons.ts';
import { esc, guideOf, hintClass as hint, hintsOf, nameOf, renderHints, speech, type Tool, type ViewState } from './common.ts';

type Blink = TutorialStep['highlight'];

const active = (on: boolean) => (on ? ' active' : '');

const TOOLS: { kind: 'select' | 'link' | 'remove'; icon: IconName; label: string; hint: string }[] = [
  { kind: 'select', icon: 'select', label: 'Sélection', hint: 'cliquer un bâtiment pour ouvrir sa carte, le glisser pour le déplacer' },
  { kind: 'link', icon: 'link', label: 'Relier', hint: 'cliquer le départ, puis l’arrivée' },
  { kind: 'remove', icon: 'remove', label: 'Retirer', hint: 'cliquer un bâtiment pour le démolir' },
];

/** Un médaillon de la barre : une icône seule, son nom et son mode d'emploi au survol. */
const medal = (classes: string, attrs: string, name: IconName, label: string, tip: string) =>
  `<button class="${classes}" ${attrs} data-tip="${esc(tip)}" aria-label="${esc(label)}">${icon(name)}</button>`;

/** Sélection, Relier, Retirer : l'outil en main reste enfoncé. */
function toolButtons(tool: Tool, blink: Blink): string {
  return TOOLS.map((t) =>
    medal(`tool${active(tool.kind === t.kind)}${hint(blink?.tool === t.kind)}`, `data-action="tool" data-tool="${t.kind}"`, t.icon, t.label, `${t.label} : ${t.hint}`),
  ).join('');
}

/** Annuler et rétablir : plus petits, on y revient moins souvent. */
function historyButtons(s: ViewState): string {
  const undo = medal('tool small', `data-action="undo" ${s.history.undo ? '' : 'disabled'}`, 'undo', 'Annuler', 'Annuler (⌘Z)');
  const redo = medal('tool small', `data-action="redo" ${s.history.redo ? '' : 'disabled'}`, 'redo', 'Rétablir', 'Rétablir (⇧⌘Z)');
  return undo + redo;
}

/** Ouvre la main de cartes ; reste enfoncé tant qu'une carte choisie attend sa case. */
function buildButton(s: ViewState, blink: Blink): string {
  const on = !!s.showHand || s.tool.kind === 'place';
  return `<button class="tool build${active(on)}${hint(blink?.tool === 'place' && !s.showHand && !s.buildAt)}" data-action="open-hand" aria-label="Bâtir" data-tip="Choisir un bâtiment, puis cliquer sa case. On peut aussi cliquer une case vide d’abord.">
        ${icon('hammer')}<span>Bâtir</span></button>`;
}

/** Le refus du plateau, ou à défaut le départ du lien en cours de tracé. */
function toast(s: ViewState): string {
  if (s.boardMessage) return `<div class="toast ko">${icon('warn')} ${esc(s.boardMessage)}</div>`;
  const { tool, draft } = s;
  if (tool.kind === 'place') return `<div class="toast">${esc(nameOf(tool.type, s.catalog))} — cliquer la case où bâtir (Échap pour renoncer)</div>`;
  const from = tool.kind === 'link' && tool.from ? draft.nodes.find((n) => n.id === tool.from) : undefined;
  return from ? `<div class="toast">Départ : ${esc(nameOf(from.type, s.catalog))} — cliquer l’arrivée</div>` : '';
}

/** La barre du bas : outils, la main de cartes, et le lancement de la vague. */
export function renderToolbar(s: ViewState): string {
  const guide = guideOf(s);
  if (!guide) return '';
  const { catalog, draft, tool } = s;
  const help = hintsOf(s);
  // Le dernier indice demandé, tant qu'il reste à faire, passe avant le pas-à-pas.
  const blink: Blink = help.highlight ?? guide.highlight;
  const validation = draftInfo(draft, catalog).validation;
  const why = validation.ok ? 'Lancer la vague' : validation.errors.join('\n');
  // La main ouverte, la bulle se retire : la carte que désigne le guide clignote à sa place.
  const handOpen = !!s.showHand || !!s.buildAt;
  const tutorial = handOpen ? '' : `<div class="tutorial panel">${speech(guide.says, guide.real)}${renderHints(help)}</div>`;
  const errors = validation.ok ? '' : `<div class="errors panel">${validation.errors.map((e) => `<p>${icon('warn')} ${esc(e)}</p>`).join('')}</div>`;
  return `
    ${tutorial}
    ${toast(s)}
    <div class="toolbar">
      <div class="group">${toolButtons(tool, blink)}</div>
      <div class="group">${historyButtons(s)}</div>
      ${buildButton(s, blink)}
      <button class="launch${hint(blink?.tool === 'launch')}" data-action="play" aria-label="Lancer la vague" ${validation.ok ? '' : 'disabled'} data-tip="${esc(why)}">${icon('swords')}<span>Lancer la vague</span></button>
    </div>
    ${errors}`;
}
