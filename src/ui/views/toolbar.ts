import { draftInfo } from '../draft.ts';
import type { TutorialStep } from '../tutorial.ts';
import { esc, guideOf, hintClass as hint, hintsOf, nameOf, renderHints, speech, type Tool, type ViewState } from './common.ts';

type Blink = TutorialStep['highlight'];

const active = (on: boolean) => (on ? ' active' : '');

const TOOLS = [
  { kind: 'select', icon: '👆', label: 'Sélection', hint: 'Cliquer un bâtiment pour ouvrir sa fiche, le glisser pour le déplacer' },
  { kind: 'link', icon: '🛤️', label: 'Relier', hint: 'Cliquer le départ, puis l’arrivée' },
  { kind: 'remove', icon: '🧨', label: 'Retirer', hint: 'Cliquer un bâtiment pour le démolir' },
] as const;

/** Sélection, Relier, Retirer, puis annuler et rétablir. */
function toolButtons(s: ViewState, tool: Tool, blink: Blink): string {
  const tools = TOOLS.map(
    (t) => `<button class="tool${active(tool.kind === t.kind)}${hint(blink?.tool === t.kind)}" data-action="tool" data-tool="${t.kind}" title="${esc(t.hint)}">
        <span class="icon">${t.icon}</span><span>${t.label}</span></button>`,
  ).join('');
  const undo = `<button class="tool" data-action="undo" ${s.history.undo ? '' : 'disabled'} title="Annuler (⌘Z)"><span class="icon">↶</span><span>Annuler</span></button>`;
  const redo = `<button class="tool" data-action="redo" ${s.history.redo ? '' : 'disabled'} title="Rétablir (⇧⌘Z)"><span class="icon">↷</span><span>Rétablir</span></button>`;
  return tools + undo + redo;
}

/** Ouvre la main de cartes ; reste enfoncé tant qu'une carte choisie attend sa case. */
function buildButton(s: ViewState, blink: Blink): string {
  const on = !!s.showHand || s.tool.kind === 'place';
  return `<button class="tool build${active(on)}${hint(blink?.tool === 'place' && !s.showHand && !s.buildAt)}" data-action="open-hand" title="Choisir un bâtiment, puis cliquer sa case. On peut aussi cliquer une case vide d’abord.">
        <span class="icon">🔨</span><span>Bâtir</span></button>`;
}

/** Le refus du plateau, ou à défaut le départ du lien en cours de tracé. */
function toast(s: ViewState): string {
  if (s.boardMessage) return `<div class="toast panel ko">${esc(s.boardMessage)}</div>`;
  const { tool, draft } = s;
  if (tool.kind === 'place') return `<div class="toast panel">${esc(nameOf(tool.type, s.catalog))} — cliquer la case où bâtir (Échap pour renoncer)</div>`;
  const from = tool.kind === 'link' && tool.from ? draft.nodes.find((n) => n.id === tool.from) : undefined;
  return from ? `<div class="toast panel">Départ : ${esc(nameOf(from.type, s.catalog))} — cliquer l’arrivée</div>` : '';
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
  const errors = validation.ok ? '' : `<div class="errors panel">${validation.errors.map((e) => `<p>⚠ ${esc(e)}</p>`).join('')}</div>`;
  return `
    ${tutorial}
    ${toast(s)}
    <div class="toolbar panel">
      <div class="group">${toolButtons(s, tool, blink)}</div>
      <div class="group">${buildButton(s, blink)}</div>
      <button class="launch${hint(blink?.tool === 'launch')}" data-action="play" ${validation.ok ? '' : 'disabled'} title="${esc(why)}">⚔️ Lancer la vague</button>
    </div>
    ${errors}`;
}
