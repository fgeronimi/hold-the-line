/**
 * Un pictogramme du sprite de l'interface (I18), pour le rendu : le sprite est posé une fois
 * dans la page par `installSprite`, ses `<use>` y renvoient. Décoratif, le texte voisin dit la chose.
 */
export const pict = (name: string) => `<svg class="ico" viewBox="0 0 48 48" aria-hidden="true"><use href="#hl-${name}"/></svg>`;

/** Lecture et pause du rejeu : deux formes simples, sans emoji (le rendu varie d'un système à l'autre). */
export const PLAY = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>';
export const PAUSE = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="currentColor"/></svg>';
