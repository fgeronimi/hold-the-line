import type { ComponentDef } from '../../engine/types.ts';
import { SCENARIOS } from '../../data/scenarios/index.ts';
import { draftInfo } from '../draft.ts';
import { guideStep, type TutorialStep } from '../tutorial.ts';
import { esc, hintClass as hint, hintsOf, nameOf, renderHints, speech, theme, type Tool, type ViewState } from './common.ts';

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

/** Un bâtiment de la palette : cliquer puis poser, ou glisser sur le plateau. */
function paletteButton(d: ComponentDef, tool: Tool, blink: Blink): string {
  const style = theme.buildings[d.id];
  const on = tool.kind === 'place' && tool.type === d.id;
  const guided = blink?.tool === 'place' && blink.type === d.id;
  const title = `${d.techName}${style ? ` — ${style.metaphor}` : ''}. ${style?.role.real ?? ''} Coût ${d.cost}, complexité ${d.complexity}. Cliquer puis poser, ou glisser sur le plateau.`;
  return `<button class="tool build${active(on)}${hint(guided)}" data-action="tool" data-tool="place" data-type="${esc(d.id)}"
        title="${esc(title)}">
        <span class="icon">${style?.icon ?? '🏠'}</span><span>${esc(d.techName)}</span><small>${esc(style?.metaphor ?? '')}</small><small>💰 ${d.cost}</small></button>`;
}

/** Le refus du plateau, ou à défaut le départ du lien en cours de tracé. */
function toast(s: ViewState): string {
  if (s.boardMessage) return `<div class="toast panel ko">${esc(s.boardMessage)}</div>`;
  const { tool, draft } = s;
  const from = tool.kind === 'link' && tool.from ? draft.nodes.find((n) => n.id === tool.from) : undefined;
  return from ? `<div class="toast panel">Départ : ${esc(nameOf(from.type, s.catalog))} — cliquer l’arrivée</div>` : '';
}

/** La barre du bas : outils, bâtiments à poser, et le lancement de la vague. */
export function renderToolbar(s: ViewState): string {
  const wave = s.scenario.waves[s.game.waveIndex];
  if (s.phase !== 'build' || !wave) return '';
  const { catalog, draft, tool } = s;
  const firstWaveOfGame = s.game.waveIndex === 0 && s.scenario.id === SCENARIOS[0]!.scenario.id;
  const guide = guideStep(draft, catalog, wave, s.game.waveIndex, s.game.committed, firstWaveOfGame);
  const help = hintsOf(s);
  // Le dernier indice demandé, tant qu'il reste à faire, passe avant le pas-à-pas.
  const blink: Blink = help.highlight ?? guide.highlight;
  const palette = Object.values(catalog.components)
    .filter((d) => d.behavior !== 'source' && !d.prePlaced)
    .map((d) => paletteButton(d, tool, blink))
    .join('');
  const validation = draftInfo(draft, catalog).validation;
  const why = validation.ok ? 'Lancer la vague' : validation.errors.join('\n');
  const tutorial = `<div class="tutorial panel">${speech(guide.says, guide.real)}${renderHints(help)}</div>`;
  const errors = validation.ok ? '' : `<div class="errors panel">${validation.errors.map((e) => `<p>⚠ ${esc(e)}</p>`).join('')}</div>`;
  return `
    ${tutorial}
    ${toast(s)}
    <div class="toolbar panel">
      <div class="group">${toolButtons(s, tool, blink)}</div>
      <div class="group palette">${palette}</div>
      <button class="launch${hint(blink?.tool === 'launch')}" data-action="play" ${validation.ok ? '' : 'disabled'} title="${esc(why)}">⚔️ Lancer la vague</button>
    </div>
    ${errors}`;
}
