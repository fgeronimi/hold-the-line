/**
 * Les pictogrammes de l'interface (I18) : des renvois vers le sprite de `sprite.ts`, injecté
 * une fois dans la page par `installSprite()`. Un emoji change de dessin d'un système à
 * l'autre et jure avec le low-poly ; ceux-ci sont les mêmes partout. Les icônes des
 * bâtiments et des évolutions restent dans le thème.
 */
import { SPRITE, SPRITE_NAMES } from './sprite.ts';

export type IconName = (typeof SPRITE_NAMES)[number] | 'redo';

/**
 * Un pictogramme en ligne, à la taille que lui donne la feuille de style ; décoratif, le
 * libellé est porté par l'élément. « Rétablir » est « Annuler » en miroir.
 */
export function icon(name: IconName): string {
  const use = name === 'redo' ? '<use href="#hl-undo" transform="translate(48 0) scale(-1 1)"/>' : `<use href="#hl-${name}"/>`;
  return `<svg class="ico ico-${name}" viewBox="0 0 48 48" aria-hidden="true" focusable="false">${use}</svg>`;
}

/** Pose le sprite dans la page, une seule fois : sans lui, chaque `<use>` reste vide. */
export function installSprite(doc: Document = document): void {
  if (doc.getElementById('hl-sprite')) return;
  doc.body.insertAdjacentHTML('afterbegin', SPRITE.replace('<svg ', '<svg id="hl-sprite" '));
}
