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
    worker: {
      role: {
        says: 'Les commis du relais vident les sacs de colis en attente et portent chacun à son destinataire. On en embauche selon les colis qui s’empilent, pas selon les voyageurs qui passent la porte.',
        real: 'Le worker consomme les messages d’une file. C’est souvent le même code que le serveur, déployé autrement ; il se dimensionne sur l’arriéré à résorber, pas sur le trafic entrant.',
      },
      metaphor: 'Tour des commis', icon: '📦', shape: 'tower', color: '#c9b79c', accent: '#6b4226' },
    'domain-service': {
      role: {
        says: 'Un maître d’un autre corps de métier, installé de l’autre côté de la rivière : il fait son ouvrage quand on le lui annonce.',
        real: 'Un service métier tenu par une autre équipe : il consomme les événements et fait son travail, avec son propre stockage.',
      },
      metaphor: 'Maître de métier', icon: '⚒️', shape: 'tower', color: '#d6cfc0', accent: '#7a4e8a' },
    'payment-provider': {
      role: {
        says: 'Le banquier lombard, hors de la cité : il encaisse chaque paiement. Il n’est pas à vous, et il ne se presse pour personne.',
        real: 'Un prestataire de paiement externe : on l’appelle par son API, on ne le dimensionne pas, et il peut ralentir ou tomber sans prévenir.',
      },
      metaphor: 'Banquier lombard', icon: '🏦', shape: 'counting-house', color: '#c7bfae', accent: '#b08a2e' },
    'mail-provider': {
      role: {
        says: 'Le colombier, de l’autre côté de la rivière : ses pigeons portent chaque billet à son spectateur, mais il n’en lâche qu’un nombre fixe par seconde, et il ferme parfois.',
        real: 'Un prestataire d’e-mail externe : il accepte un nombre limité de messages par seconde (son quota), regroupés ou non, et peut tomber en panne.',
      },
      metaphor: 'Colombier', icon: '🕊️', shape: 'dovecote', color: '#d6cfc0', accent: '#5a7d9a' },
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
  upgradeIcons: {
    'horizontal-scaling': '🗼',
    'worker-scaling': '🗼',
    autoscaling: '🏗️',
    'read-replica': '📚',
    'rate-limiting': '🛡️',
    idempotence: '🔏',
    outbox: '📒',
    'circuit-breaker': '🔌',
    'request-coalescing': '🔒',
    'client-backoff': '⏳',
    'queue-retention': '📦',
    'leader-reads': '👑',
  },
  hints: {
    place: 'Sire, il manque encore un bâtiment à la cité : {name}.',
    placeMore: 'Un seul ne suffira pas, Sire : bâtissez-en un de plus. {name}.',
    link: 'Tracez un chemin de {from} jusqu’à {to}, sans quoi personne n’y passera.',
    upgrade: 'Que {name} se dote de ceci : {upgrade}.',
    level: 'Que {name} se dote de ceci : {upgrade}, {level}.',
    remove: 'Cette fois, {name} ne sert à rien, et le trésor le paie quand même.',
    unlink: 'Le chemin de {from} à {to} égare les voyageurs : qu’on le ferme.',
    lower: '{name} en fait trop : {upgrade}, c’est plus qu’il n’en faut cette fois.',
    rewind: 'Sire, d’ici la cité ne tiendra pas : défaire ce qui est bâti coûterait plus que le trésor. Revenons à la vague {wave}, avant ce choix.',
    rebuilt: 'Tout y est, Sire, mais {name} a été démoli puis rebâti : le trésor paie la démolition.',
    ready: 'Tout y est, Sire. Lancez la vague !',
  },
  debrief: {
    won: 'La cité a tenu, Sire. {story}',
    wonQuiet: '{title} : défi relevé.',
    lost: 'La cité est tombée, Sire. Voici ce qui s’est passé.',
    edge: 'Votre {name} a renvoyé {share} voyageurs sur 100 sans même les faire entrer en ville.',
    cache: 'Votre {name} a fait le travail : {share} voyageurs sur 100 y ont trouvé leur réponse sans déranger les archives.',
    instances: '{count} tours de scribes se sont partagé la foule.',
    workers: '{count} tours de commis se sont partagé les colis du relais.',
    replica: 'La copie des archives a répondu aux lectures que les archives seules n’auraient pas tenues.',
    replicas: 'Les {count} copies des archives ont répondu aux lectures que les archives seules n’auraient pas tenues.',
    rateLimit: 'La garde de la porte a refoulé les pillards sans gêner un seul marchand honnête.',
    pubsub: 'Votre {name} a annoncé chaque commande à {count} corps de métier à la fois.',
    idempotence: 'Vos ateliers reconnaissent une commande déjà servie : personne n’a été débité deux fois.',
    outbox: 'Chaque commande est consignée au grand livre avec son annonce : aucune ne s’est perdue.',
    queue: 'Votre {name} a emporté le travail de fond sans faire attendre personne.',
    queues: 'Vos {count} relais de poste ont emporté le travail de fond sans faire attendre personne.',
    hot: '{name} : presque plein au plus fort de la vague. À la prochaine affluence, c’est là que ça cédera.',
    superfluous: 'Sans {names}, la cité aurait tenu quand même : il coûte sans rien apporter cette vague.',
    superfluousMany: 'Sans {names}, la cité aurait tenu quand même : ils coûtent sans rien apporter cette vague.',
  },
  choose: {
    says: 'Sire, quelle partie de la cité voulez-vous défendre ?',
    real: 'Choisissez un scénario. Chacun a sa propre partie, vous pouvez passer de l’un à l’autre sans rien perdre.',
  },
  timeRule: {
    says: 'Une chose, Sire : dans la cité, le temps file. Chaque vague tient une heure, et chaque minute passe en un clin d’œil. Mais les voyageurs, eux, se comptent toujours à la seconde.',
    real: 'Le temps est accéléré : une vague montre une heure de trafic, et un tick de simulation vaut une minute (60 ticks par vague). Les débits restent en requêtes par seconde ; les compteurs cumulés (arriéré d’une file, requêtes en échec) additionnent ces débits minute après minute, à l’échelle du jeu, pas en volumes réels.',
  },
  narratives: {
    // La billetterie du tournoi.
    'ticket-rush':
      'Sire, la billetterie du grand tournoi ouvre ! Les spectateurs se pressent aux guichets, et chaque billet vendu part au colombier. Gare : un mauvais déploiement fera tomber tous les guichetiers pendant trois minutes, et un spectateur refoulé revient aussitôt à la charge, avec ses voisins.',
    'pigeons-grounded':
      'Le colombier fermera une demi-heure : plus un pigeon ne part. Les achats, eux, continuent, et chaque billet doit attendre quelque part son pigeon. Mais une file n’est pas un puits sans fond.',
    'split-registry':
      'Les spectateurs cherchent leurs dates et regardent les places restantes. Les copistes recopient le grand registre pour répondre plus vite… mais un temps, ils ne l’entendront plus. Une place promise et déjà vendue, c’est un spectateur furieux.',
    'final-joust':
      'La joute finale, Sire ! Tout le royaume veut sa place : les guichetiers tomberont, le colombier fermera, et les copistes seront coupés du registre. Tout ce que vous avez appris, il faudra le tenir ensemble.',
    // Le comptoir des paiements.
    checkout:
      'Sire, la boutique encaisse enfin ses ventes. Chaque commande passe par le banquier lombard, de l’autre côté de la rivière : il répond vite, et le chaland attend sa quittance au comptoir.',
    'slow-banker':
      'Le banquier a ses humeurs : on dit que, quatre minutes durant, il fait attendre chaque paiement de longues secondes. Vos scribes attendront-ils avec lui, au point de ne plus servir personne ?',
    'midnight-expiry':
      'Les voyageurs affluent pour consulter leurs commandes. Mais à minuit, toutes les pages du carnet s’effacent d’un coup, et chacune devra être recopiée des archives.',
    'banker-closed':
      'Le banquier ferme boutique pour vingt-cinq minutes. Les commandes, elles, ne s’arrêtent pas : il faudra bien encaisser à sa réouverture.',
    fair:
      'La grande foire, Sire ! Une foule immense, le banquier qui traîne, le carnet qui s’efface : tout ce que vous avez appris, il faudra le tenir ensemble.',
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
      'Les crieurs annoncent une grande foire : pendant un tiers de l’heure, cinq fois plus de monde, et la foule arrive en quelques minutes. Vos scribes tiendront-ils le choc ?',
    'noisy-client':
      'La foire a réussi : la foule est restée. Cinquante marchands passent la porte sans relâche. Et deux bandes de pillards sont venues recopier tout le registre des raccourcis, page après page, même les pages que personne ne consulte jamais.',
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
