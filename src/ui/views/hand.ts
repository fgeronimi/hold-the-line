import type { BoardCell, ComponentDef } from '../../engine/types.ts';
import { draftInfo } from '../draft.ts';
import { fan, type FanSlot } from '../hand.ts';
import { blinkOf, buildable, decimal as fmt, esc, hintClass as blink, nameOf, theme, type ViewState } from './common.ts';

const KINDS_TEXT: Record<string, string> = { read: 'lectures', write: 'écritures', async: 'événements' };

/** L'illustration d'une carte : la miniature rendue par le plateau, ou l'icône du thème en attendant. */
export function cardArt(s: ViewState, type: string): string {
  const src = s.thumbnails?.[type];
  return src ? `<img src="${esc(src)}" alt="" draggable="false">` : `<span class="emoji">${theme.buildings[type]?.icon ?? '🏠'}</span>`;
}

/**
 * Une carte de la main. Sa face tient l'essentiel (nom, illustration, rôle, prix) ; soulevée,
 * elle montre ses chiffres et ses évolutions. Un bâtiment au-delà du budget reste jouable :
 * la vague dira ce qu'il en coûte, la carte prévient seulement.
 */
function handCard(s: ViewState, d: ComponentDef, slot: FanSlot, index: number, hinted: boolean): string {
  const style = theme.buildings[d.id];
  const accepts = d.accepts.map((k) => KINDS_TEXT[k] ?? k).join(', ');
  const ups = Object.values(s.catalog.upgrades)
    .filter((u) => u.appliesTo === d.id)
    .map((u) => `${theme.upgradeIcons[u.id] ?? '✦'} ${esc(u.techName)}`)
    .join(' · ');
  const budget = s.scenario.waves[s.game.waveIndex]?.budget ?? Infinity;
  const affordable = d.cost <= Math.max(0, budget - draftInfo(s.draft, s.catalog).cost);
  const lifted = s.liftedCard === d.id;
  const again = s.buildAt ? 'Toucher encore pour bâtir' : 'Toucher encore pour choisir';
  const ribbon = lifted ? again : affordable ? '✓ Constructible' : 'Au-delà du budget';
  const place = `--k:${slot.offset};--tilt:${slot.tilt.toFixed(2)}deg;--drop:${slot.drop.toFixed(3)};--i:${index}`;
  return `<button class="hcard${lifted ? ' lifted' : ''}${blink(hinted)}" data-action="pick-card" data-type="${esc(d.id)}" style="${place}"
        aria-label="${esc(nameOf(d.id, s.catalog))}, prix ${d.cost}, complexité ${d.complexity}${affordable ? '' : ', au-delà du budget restant'}">
        <span class="hcard-face">
          <span class="hcard-title"><b>${esc(d.techName)}</b><small>${esc(style?.metaphor ?? '')}</small></span>
          <span class="hcard-art">${cardArt(s, d.id)}</span>
          ${style ? `<span class="hcard-text">${esc(style.role.real)}</span>` : ''}
          <span class="hcard-more">
            <span>${fmt(d.capacity)} unités de travail/s · ${d.latencyMs} ms${accepts ? ` · reçoit ${accepts}` : ''}</span>
            ${ups ? `<span>Évolutions : ${ups}</span>` : ''}
          </span>
          <span class="hcard-cost"><span title="Prix">💰 ${d.cost}</span><span title="Complexité">⚙ ${d.complexity}</span></span>
          <span class="hcard-ribbon${affordable || lifted ? '' : ' dear'}">${ribbon}</span>
        </span>
      </button>`;
}

/** Où la carte choisie ira : sur la case cliquée, dans un lien qui y passe, ou sur une case encore à désigner. */
function destination(s: ViewState, cell: BoardCell | undefined): string {
  if (!cell) return 'Choisir un bâtiment, puis cliquer sa case.';
  const road = s.draft.links.find((l) => l.path?.some((c) => c.q === cell.q && c.r === cell.r));
  if (!road) return 'Choisir un bâtiment pour cette case.';
  const [from, to] = [road.from, road.to].map((id) => nameOf(s.draft.nodes.find((n) => n.id === id)?.type ?? id, s.catalog));
  // Sur un chemin, le bâtiment s'insère dans le lien quand c'est sensé (I11).
  return `Sur le chemin ${esc(from!)} → ${esc(to!)} : le bâtiment s’insère dans le lien quand c’est sensé.`;
}

/**
 * La main de cartes : un bâtiment constructible par carte, en éventail au centre de l'écran.
 * Ouverte par une case vide cliquée (la carte y bâtit) ou par « Bâtir » (la carte arme l'outil
 * qui pose). Le plateau reste cliquable autour d'elle.
 */
export function renderHand(s: ViewState): string {
  if (s.phase !== 'build' || (!s.buildAt && !s.showHand)) return '';
  const defs = buildable(s.catalog);
  const slots = fan(defs.length);
  const hinted = blinkOf(s);
  const cards = defs.map((d, i) => handCard(s, d, slots[i]!, i, hinted?.tool === 'place' && hinted.type === d.id)).join('');
  return `
    <section class="hand" style="--n:${defs.length}" aria-label="Bâtiments à construire">
      <p class="hand-head"><span>${destination(s, s.buildAt)}</span>
        <button class="close" data-action="close-build" title="Fermer (Échap)" aria-label="Fermer">✕</button></p>
      <div class="hand-cards">${cards}</div>
    </section>`;
}
