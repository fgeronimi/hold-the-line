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
    'traffic-source': { metaphor: 'Hameaux', icon: '🏘️', shape: 'hamlet', color: '#e8d5a8', accent: '#9c6b3f' },
    cdn: { metaphor: 'Avant-poste', icon: '🗼', shape: 'watchtower', color: '#b9b2a4', accent: '#3f7cac' },
    'load-balancer': { metaphor: 'Porte de la cité', icon: '🏰', shape: 'gatehouse', color: '#b9b2a4', accent: '#5a4632' },
    'app-server': { metaphor: 'Tour des scribes', icon: '📜', shape: 'tower', color: '#d6cfc0', accent: '#3d5a80' },
    cache: { metaphor: 'Carnet du scribe', icon: '📒', shape: 'lectern', color: '#8d6a4f', accent: '#f4f1de' },
    database: { metaphor: 'Archives royales', icon: '🏛️', shape: 'keep', color: '#c7bfae', accent: '#7a3b2e' },
    'message-queue': { metaphor: 'Relais de poste', icon: '🐎', shape: 'stables', color: '#9c6b3f', accent: '#6b4226' },
  },
  narrator: { name: 'Le chambellan', icon: '🎩' },
  narratives: {
    launch:
      'Sire, le bureau des raccourcis ouvre ses portes. Une centaine de voyageurs par seconde : presque tous demandent leur chemin, quelques-uns déposent un nouveau raccourci. Une tour de scribes et les archives devraient suffire… à condition de les relier.',
    'read-surge':
      'La nouvelle s’est répandue dans tout le royaume : dix fois plus de voyageurs demandent leur chemin. Les archives grondent sous les demandes. Comment les soulager sans vider le trésor ?',
    'marketing-peak':
      'Les crieurs annoncent une grande foire : pendant un tiers de la journée, cinq fois plus de monde, et la foule arrive en quelques instants. Vos scribes tiendront-ils le choc ?',
    'noisy-client':
      'La foire a réussi, la foule est restée. Cinquante marchands partenaires passent à grand débit… et deux bandes de pillards inondent la porte en visitant chaque raccourci du royaume.',
    'click-tracking':
      'Le trésorier veut compter chaque passage par un raccourci. Mais un voyageur ne doit jamais attendre qu’on ait fini de compter.',
  },
  vehicles: {
    // La hauteur des personnages est la deuxième valeur de `size`.
    read: { metaphor: 'Messager (lecture)', color: '#3a86ff', size: [0.3, 0.55, 0.3], model: 'kaykit-chars/Rogue.glb' },
    write: { metaphor: 'Porteur (écriture)', color: '#fb8500', size: [0.3, 0.6, 0.3], model: 'kaykit-chars/Barbarian.glb' },
    async: { metaphor: 'Mage messager (async)', color: '#9b5de5', size: [0.3, 0.55, 0.3], model: 'kaykit-chars/Mage.glb' },
  },
};
