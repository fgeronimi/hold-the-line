import type { Theme } from '../../render/theme.ts';

/**
 * « Les portes de la cité » : l'architecture devient une cité fortifiée à tenir, les
 * requêtes des messagers et des charrettes venus des hameaux.
 */
export const fortifiedCity: Theme = {
  id: 'fortified-city',
  title: 'Les portes de la cité',
  alert: '#d62828',
  failed: 'Requête en échec',
  hostile: { metaphor: 'Scraper (pillards squelettes)', color: '#2b2d42', model: 'kaykit-chars/Skeleton_Warrior.glb' },
  buildings: {
    'traffic-source': {
      role: {
        says: 'Les hameaux d’où partent les voyageurs.',
        real: 'Les clients : navigateurs et partenaires qui appellent le service.',
      },
      metaphor: 'Hameaux', icon: '🏘️', shape: 'hamlet', color: '#e8d5a8', accent: '#9c6b3f' },
    cdn: {
      role: {
        says: 'Un avant-poste sur la route, qui connaît par cœur les chemins les plus demandés : il répond lui-même, sans faire entrer le voyageur en ville.',
        real: 'Le CDN garde en cache, au plus près des clients, les réponses qui ne changent pas (les redirections) : le serveur ne les voit jamais.',
      },
      metaphor: 'Avant-poste', icon: '🗼', shape: 'watchtower', color: '#b9b2a4', accent: '#3f7cac' },
    'load-balancer': {
      role: {
        says: 'La porte répartit les voyageurs entre les tours de scribes, et sa garde peut refouler les pillards.',
        real: 'Le load balancer répartit les requêtes entre les instances du serveur ; c’est aussi lui qui porte le rate limiting.',
      },
      metaphor: 'Porte de la cité', icon: '🏰', shape: 'gatehouse', color: '#b9b2a4', accent: '#5a4632' },
    'app-server': {
      role: {
        says: 'Les scribes reçoivent chaque voyageur et vont chercher sa réponse. Plus de tours, plus de voyageurs servis à la fois.',
        real: 'Le serveur d’application exécute le code ; on ajoute des instances pour tenir plus de charge.',
      },
      metaphor: 'Tour des scribes', icon: '📜', shape: 'tower', color: '#d6cfc0', accent: '#3d5a80' },
    'domain-service': {
      role: {
        says: 'Un maître d’un autre corps de métier, installé de l’autre côté de la rivière : il fait son ouvrage quand on le lui annonce.',
        real: 'Un service métier tenu par une autre équipe : il consomme les événements et fait son travail, avec son propre stockage.',
      },
      metaphor: 'Maître de métier', icon: '⚒️', shape: 'tower', color: '#d6cfc0', accent: '#7a4e8a' },
    cache: {
      role: {
        says: 'Le carnet où le scribe note les réponses déjà cherchées, pour ne pas retourner aux archives à chaque fois.',
        real: 'Le cache garde en mémoire les lectures fréquentes ; le serveur le consulte avant la base (cache-aside).',
      },
      metaphor: 'Carnet du scribe', icon: '📒', shape: 'lectern', color: '#8d6a4f', accent: '#f4f1de' },
    database: {
      role: {
        says: 'Les archives, où tout est consigné : sûres, mais lentes à consulter, et on ne peut pas y faire entrer tout le monde.',
        real: 'La base de données stocke tout ; c’est souvent le premier goulot, surtout en lecture.',
      },
      metaphor: 'Archives royales', icon: '🏛️', shape: 'keep', color: '#c7bfae', accent: '#7a3b2e' },
    'message-queue': {
      role: {
        says: 'Le relais de poste prend les colis et les livre plus tard : le voyageur n’attend pas la livraison.',
        real: 'La file de messages découple : le serveur dépose le travail et répond tout de suite, un worker le traite à son rythme.',
      },
      metaphor: 'Relais de poste', icon: '🐎', shape: 'stables', color: '#9c6b3f', accent: '#6b4226' },
    pubsub: {
      role: {
        says: 'Au pied du clocher, le crieur public annonce chaque nouvelle à tous ceux qui se sont abonnés à ses annonces : chacun l’entend, personne ne la prend aux autres.',
        real: 'Le pub/sub diffuse chaque événement à tous ses abonnés : chaque service en reçoit une copie, sans que le serveur qui publie les connaisse.',
      },
      metaphor: 'Crieur public', icon: '📣', shape: 'belfry', color: '#c7bfae', accent: '#3d5a80' },
  },
  narrator: { name: 'Le chambellan', icon: '🎩' },
  narratives: {
    // Le grand marché.
    'market-open':
      'Sire, le grand marché ouvre ses étals. Cent commandes chaque seconde, chacune à consigner au grand livre… et chacune réclame une lettre de confirmation. Le messager met du temps à écrire chaque lettre, et le chaland, lui, n’aime pas attendre au comptoir.',
    'three-trades':
      'Le magasinier, le trésorier et le messager veulent tous apprendre chaque commande, et chacun la sienne. Si l’un l’apprend, les deux autres doivent l’apprendre aussi.',
    'double-delivery':
      'Les annonces se répètent parfois : il arrive qu’une même commande soit criée deux fois. Gare à ne pas la servir deux fois, ni à faire payer deux fois le client.',
    'lost-orders':
      'Les scribes consignent la commande, puis courent l’annoncer. Mais certains tombent en chemin : la commande est au grand livre, et personne n’en a rien su.',
    sales:
      'Les soldes, Sire ! Toute la ville vient voir où en sont ses commandes, les annonces se répètent et des scribes tombent en chemin. Tout ce que vous avez appris, il faudra le tenir ensemble.',
    // Les portes de la cité.
    launch:
      'Sire, le bureau des raccourcis ouvre ses portes. Une centaine de voyageurs par seconde : presque tous demandent leur chemin, quelques-uns déposent un nouveau raccourci. Une tour de scribes et les archives devraient suffire… à condition de les relier.',
    'read-surge':
      'La nouvelle s’est répandue dans tout le royaume : dix fois plus de voyageurs demandent leur chemin. Les archives grondent sous les demandes. Comment les soulager sans vider le trésor ?',
    'marketing-peak':
      'Les crieurs annoncent une grande foire : pendant un tiers de la journée, cinq fois plus de monde, et la foule arrive en quelques instants. Vos scribes tiendront-ils le choc ?',
    'noisy-client':
      'La foire a réussi : la foule est restée. Cinquante marchands passent la porte toute la journée. Et deux bandes de pillards sont venues recopier tout le registre des raccourcis, page après page, même les pages que personne ne consulte jamais.',
    'click-tracking':
      'Le trésorier veut compter chaque passage par un raccourci. Mais un voyageur ne doit jamais attendre qu’on ait fini de compter.',
  },
  vehicles: {
    // La hauteur des personnages est la deuxième valeur de `size`.
    read: { metaphor: 'Lecture (messager)', color: '#3a86ff', size: [0.3, 0.55, 0.3], model: 'kaykit-chars/Rogue.glb' },
    write: { metaphor: 'Écriture (porteur)', color: '#fb8500', size: [0.3, 0.6, 0.3], model: 'kaykit-chars/Barbarian.glb' },
    async: { metaphor: 'Async (mage messager)', color: '#9b5de5', size: [0.3, 0.55, 0.3], model: 'kaykit-chars/Mage.glb' },
  },
};
