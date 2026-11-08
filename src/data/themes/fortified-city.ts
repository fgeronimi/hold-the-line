import type { Theme } from '../../render/theme.ts';

/**
 * « Les portes de la cité » : l'architecture devient une cité fortifiée à tenir, les
 * requêtes des messagers et des charrettes venus des hameaux.
 */
export const fortifiedCity: Theme = {
  id: 'fortified-city',
  title: 'Les portes de la cité',
  ground: '#3f5a2c',
  road: '#c9a46c',
  alert: '#d62828',
  failed: 'Requête en échec',
  hostile: { metaphor: 'Pillards squelettes (scraper)', color: '#2b2d42', model: 'kaykit-chars/Skeleton_Warrior.glb' },
  buildings: {
    'traffic-source': { metaphor: 'Hameaux', shape: 'hamlet', color: '#e8d5a8', accent: '#9c6b3f' },
    cdn: { metaphor: 'Avant-poste', shape: 'watchtower', color: '#b9b2a4', accent: '#3f7cac' },
    'load-balancer': { metaphor: 'Porte de la cité', shape: 'gatehouse', color: '#b9b2a4', accent: '#5a4632' },
    'app-server': { metaphor: 'Tour des scribes', shape: 'tower', color: '#d6cfc0', accent: '#3d5a80' },
    cache: { metaphor: 'Carnet du scribe', shape: 'lectern', color: '#8d6a4f', accent: '#f4f1de' },
    database: { metaphor: 'Archives royales', shape: 'keep', color: '#c7bfae', accent: '#7a3b2e' },
    'message-queue': { metaphor: 'Relais de poste', shape: 'stables', color: '#9c6b3f', accent: '#6b4226' },
  },
  vehicles: {
    // La hauteur des personnages est la deuxième valeur de `size`.
    read: { metaphor: 'Messager (lecture)', color: '#3a86ff', size: [0.3, 0.55, 0.3], model: 'kaykit-chars/Rogue.glb' },
    write: { metaphor: 'Porteur (écriture)', color: '#fb8500', size: [0.3, 0.6, 0.3], model: 'kaykit-chars/Barbarian.glb' },
    async: { metaphor: 'Mage messager (async)', color: '#9b5de5', size: [0.3, 0.55, 0.3], model: 'kaykit-chars/Mage.glb' },
  },
};
