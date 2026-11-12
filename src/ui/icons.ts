/**
 * Les pictogrammes de l'interface, dessinés pour elle : plats, épais, aux teintes du plateau.
 * Un emoji change de dessin d'un système à l'autre et jure avec le low-poly ; ceux-ci sont
 * les mêmes partout. Le trait prend la couleur du texte (`currentColor`), les aplats ont la
 * leur. Les icônes des bâtiments et des évolutions restent dans le thème.
 */

const GOLD = '#e2b53e';
const GOLD_DARK = '#9a7420';
const STEEL = '#c9d1d6';
const RED = '#c0392b';
const PAPER = '#fbf3dc';

/** Le trait d'un pictogramme : son épaisseur se règle dans la feuille de style (`--ico-w`). */
const line = 'fill="none" stroke="currentColor" style="stroke-width:var(--ico-w,2.4px)" stroke-linecap="round" stroke-linejoin="round"';

const SHAPES = {
  /** Le prix : un écu. */
  coin: `<circle cx="12" cy="12" r="9" fill="${GOLD}" stroke="${GOLD_DARK}" stroke-width="2"/><circle cx="12" cy="12" r="5" fill="none" stroke="${GOLD_DARK}" stroke-width="1.6"/>`,
  /** La complexité : un rouage. */
  cog: `<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="3.6" stroke-dasharray="3.3 3.3"/><circle cx="12" cy="12" r="5.2" fill="none" stroke="currentColor" stroke-width="3"/>`,
  /** Une lecture : un livre ouvert. */
  read: `<path d="M12 6.5C9.5 4.8 6.5 4.6 3.5 5.4v12.2c3-.8 6-.6 8.5 1.1 2.5-1.7 5.5-1.9 8.5-1.1V5.4c-3-.8-6-.6-8.5 1.1z" fill="${PAPER}" stroke="currentColor" style="stroke-width:var(--ico-o,2px)" stroke-linejoin="round"/><path d="M12 6.5v12.2" ${line}/>`,
  /** Une écriture : une plume. */
  write: `<path d="M19.5 3.5c-6 .5-10.5 4-12 10.5l3 3c6.5-1.5 9.5-6.5 9-13.5z" fill="${PAPER}" stroke="currentColor" style="stroke-width:var(--ico-o,2px)" stroke-linejoin="round"/><path d="M4 20.5l6.5-6.5" ${line}/>`,
  /** Un événement asynchrone : un pli cacheté. */
  async: `<rect x="3" y="6" width="18" height="13" rx="2" fill="${PAPER}" stroke="currentColor" style="stroke-width:var(--ico-o,2px)"/><path d="M3.8 7.5l8.2 6 8.2-6" ${line}/>`,
  /** Le SLA : une cible. */
  target: `<circle cx="12" cy="12" r="9" fill="${PAPER}" stroke="currentColor" style="stroke-width:var(--ico-o,2px)"/><circle cx="12" cy="12" r="5" fill="none" stroke="${RED}" stroke-width="2.4"/><circle cx="12" cy="12" r="1.8" fill="${RED}"/>`,
  star: `<path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.3L12 17.1l-5.7 3.1 1.2-6.3L2.8 9.5l6.4-.8z" fill="${GOLD}" stroke="${GOLD_DARK}" stroke-width="1.6" stroke-linejoin="round"/>`,
  /** Le score : une médaille. */
  medal: `<path d="M8 3l4 7 4-7" fill="none" stroke="${RED}" stroke-width="3.2" stroke-linejoin="round"/><circle cx="12" cy="15" r="6" fill="${GOLD}" stroke="${GOLD_DARK}" stroke-width="2"/>`,
  menu: `<path d="M4.5 7h15M4.5 12h15M4.5 17h15" ${line}/>`,
  close: `<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" ${line}/>`,
  /** L'outil de sélection : une flèche. */
  select: `<path d="M6 3.5l12 9.5-5.6.9 3.1 6.1-2.7 1.3-3.1-6.1L6 19z" fill="${PAPER}" stroke="currentColor" style="stroke-width:var(--ico-o,2px)" stroke-linejoin="round"/>`,
  /** Relier : un chemin entre deux bâtiments. */
  link: `<path d="M6 17.5c5 0 2.5-11 12-11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="1 4.2"/><circle cx="5.5" cy="17.5" r="3" fill="${PAPER}" stroke="currentColor" style="stroke-width:var(--ico-o,2px)"/><circle cx="18.5" cy="6.5" r="3" fill="${PAPER}" stroke="currentColor" style="stroke-width:var(--ico-o,2px)"/>`,
  /** Retirer : un bâton de dynamite, mèche allumée. */
  remove: `<g transform="rotate(35 12 13)"><rect x="8.4" y="7" width="7.2" height="14" rx="1.8" fill="${RED}" stroke="currentColor" style="stroke-width:var(--ico-o,2px)"/><path d="M8.4 11.2h7.2M8.4 16.8h7.2" stroke="currentColor" stroke-width="1.5"/></g><path d="M15.4 8c.4-2.2 1.6-3.4 3.4-3.6" ${line}/><path d="M20.6 1.6v4M18.6 3.6h4M19.2 2.2l2.8 2.8M22 2.2l-2.8 2.8" stroke="${GOLD}" stroke-width="1.5" stroke-linecap="round"/>`,
  undo: `<path d="M9 14.5L4.5 10 9 5.5" ${line}/><path d="M4.5 10h9a6 6 0 0 1 0 12h-3" ${line} transform="translate(0 -3)"/>`,
  redo: `<path d="M15 14.5l4.5-4.5L15 5.5" ${line}/><path d="M19.5 10h-9a6 6 0 0 0 0 12h3" ${line} transform="translate(0 -3)"/>`,
  /** Bâtir : la main de cartes. */
  cards: `<rect x="3.5" y="6.5" width="10" height="14" rx="2" fill="${PAPER}" stroke="currentColor" style="stroke-width:var(--ico-o,2px)" transform="rotate(-12 8.5 13.5)"/><rect x="10.5" y="4.5" width="10" height="14" rx="2" fill="${GOLD}" stroke="currentColor" style="stroke-width:var(--ico-o,2px)" transform="rotate(10 15.5 11.5)"/>`,
  /** Lancer la vague : deux épées croisées. */
  swords: `<path d="M4 4l11.5 11.5M20 4L8.5 15.5" fill="none" stroke="${STEEL}" stroke-width="3" stroke-linecap="round"/><path d="M4 4l11.5 11.5M20 4L8.5 15.5" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity=".35"/><path d="M12.5 17.5l4.5-4.5M11.5 17.5L7 13M17.5 17.5l2.5 2.5M6.5 17.5L4 20" ${line}/>`,
  /** Le chambellan : son chapeau. */
  hat: `<path d="M7 16V6.5c0-1.5 10-1.5 10 0V16z" fill="#2b2420" stroke="#2b2420" stroke-width="2" stroke-linejoin="round"/><path d="M7 13h10" stroke="${RED}" stroke-width="2.6"/><path d="M3 17c3 2.5 15 2.5 18 0" fill="none" stroke="#2b2420" stroke-width="3.2" stroke-linecap="round"/>`,
  /** Un indice : une lanterne allumée. */
  bulb: `<path d="M12 3a6.5 6.5 0 0 0-3.5 12v2h7v-2A6.5 6.5 0 0 0 12 3z" fill="${GOLD}" stroke="currentColor" style="stroke-width:var(--ico-o,2px)" stroke-linejoin="round"/><path d="M9.5 20.5h5" ${line}/>`,
  move: `<path d="M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" ${line}/>`,
  warn: `<path d="M12 3.5l9.5 16.5h-19z" fill="${GOLD}" stroke="currentColor" style="stroke-width:var(--ico-o,2px)" stroke-linejoin="round"/><path d="M12 9.5v5M12 17.2v.3" ${line}/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7" ${line}/>`,
} as const;

export type IconName = keyof typeof SHAPES;

/** Un pictogramme en ligne, à la taille du texte qui l'entoure ; décoratif, le libellé est porté par l'élément. */
export function icon(name: IconName): string {
  return `<svg class="ico ico-${name}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${SHAPES[name]}</svg>`;
}
