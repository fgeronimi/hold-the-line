/**
 * Les calques de l'interface posés sur le plateau, un module par région de l'écran sous
 * `views/` : barre du haut (`hud.ts`), barre d'outils (`toolbar.ts`), main de cartes
 * (`hand.ts`), carte du bâtiment et pastilles (`card.ts`), fenêtres (`dialog.ts`), tiroir de debug (`debug.ts`),
 * et ce qu'ils partagent (`common.ts`). Ce point d'entrée garde les imports existants.
 */
export { esc, findingsOf, hintsOf, type Attempt, type Phase, type Tool, type ViewState } from './views/common.ts';
export { renderHud } from './views/hud.ts';
export { renderToolbar } from './views/toolbar.ts';
export { renderCard, upgradePips } from './views/card.ts';
export { renderHand } from './views/hand.ts';
export { renderDialog } from './views/dialog.ts';
export { renderDebug } from './views/debug.ts';
