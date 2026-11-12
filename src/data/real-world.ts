/**
 * Les lignes « en vrai » des fiches (D3b) : l'ordre de grandeur réel d'un bâtiment ou d'une
 * évolution, à côté des chiffres du jeu, qui restent des ordres de grandeur cohérents entre eux
 * (décision 5.3 de la revue). Un chiffre de fournisseur cite sa source, à relire sur la page
 * citée avant de le changer : ces quotas évoluent. Les produits réels ne sont nommés qu'ici,
 * jamais dans la métaphore ni dans le nom des bâtiments.
 */
export interface RealWorld {
  text: string;
  source?: { label: string; url: string };
}

/** Par composant du catalogue. */
export const realWorldComponents: Record<string, RealWorld> = {
  'app-server': {
    text: 'Quelques centaines à quelques milliers de requêtes par seconde par instance, selon le travail de chaque requête : le jeu prend le haut de la fourchette.',
  },
  worker: {
    text: 'Souvent le même code que le serveur, déployé autrement : il lit une file au lieu de répondre à des clients, et se dimensionne sur l’arriéré, pas sur le trafic entrant.',
  },
  database: {
    text: 'Une base relationnelle correcte sert plusieurs milliers à quelques dizaines de milliers de lectures simples par seconde : le jeu la fait dix fois plus petite, pour que le premier goulot arrive vite. Une écriture y coûte plusieurs lectures.',
  },
  cache: {
    text: 'Un Redis sur un seul nœud sert de l’ordre de 100 000 opérations par seconde, en moins d’une milliseconde. Ce qui compte, c’est son taux de succès, et ce qui arrive quand il redémarre vide.',
  },
  cdn: {
    text: 'Le composant le moins cher par requête servie, et le plus loin du serveur. Ce qu’il garde en bordure n’atteint jamais l’application : un clic servi depuis le CDN n’est pas compté par le serveur.',
  },
  'load-balancer': {
    text: 'Un load balancer géré tient des dizaines de milliers de requêtes par seconde et retire en quelques secondes une instance qui ne répond plus à ses vérifications de santé.',
  },
  'message-queue': {
    text: 'Sur une file gérée, la limite est une durée plutôt qu’un nombre : Amazon SQS garde un message 4 jours par défaut, 14 au plus, avec environ 120 000 messages en cours de traitement.',
    source: { label: 'quotas Amazon SQS', url: 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html' },
  },
  pubsub: {
    text: 'Un bus copie chaque message à chacun de ses abonnés, et le relivre au moins une fois : un abonné reçoit des doublons en temps normal, pas seulement pendant un incident.',
  },
  'payment-provider': {
    text: 'Une autorisation de paiement prend plusieurs centaines de millisecondes, parfois quelques secondes, et l’API a un quota : Stripe accepte 100 requêtes par seconde par compte en production, 25 par point d’entrée par défaut.',
    source: { label: 'limites de l’API Stripe', url: 'https://docs.stripe.com/rate-limits' },
  },
  'mail-provider': {
    text: 'Le quota d’envoi est la vraie contrainte d’un envoi en masse : Amazon SES commence à 1 message par seconde et 200 par jour, puis le débit se négocie compte par compte. Le jeu est bien plus généreux.',
    source: { label: 'quotas Amazon SES', url: 'https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html' },
  },
  'domain-service': {
    text: 'Le service d’une autre équipe : on ne le dimensionne pas, on convient avec elle de ce qu’on lui envoie, et on ne partage pas sa base.',
  },
};

/** Par évolution du catalogue. */
export const realWorldUpgrades: Record<string, RealWorld> = {
  autoscaling: {
    text: 'Une instance met de l’ordre de quelques minutes à servir, et la réduction attend un délai de stabilisation : 300 secondes par défaut sur EC2 Auto Scaling.',
    source: { label: 'EC2 Auto Scaling', url: 'https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-scaling-cooldowns.html' },
  },
  'client-backoff': {
    text: 'Les SDK d’AWS, en mode standard, font 3 tentatives au total avec une attente exponentielle tirée au hasard. Le jeu montre le client naïf, qui relance trois fois sans attendre.',
    source: { label: 'relances des SDK AWS', url: 'https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html' },
  },
  'load-shedding': {
    text: 'Délester en amont dès que la charge dépasse la capacité, relances comprises, est la parade côté serveur aux pannes en cascade. Son cousin côté client est le budget de relances : au plus quelques tentatives par requête.',
    source: { label: 'Google SRE, pannes en cascade', url: 'https://sre.google/sre-book/addressing-cascading-failures/' },
  },
  'call-timeout': {
    text: 'Tout appel réseau a un délai d’attente, plus court que celui de son propre client. Sans lui, une dépendance qui se tait retient les fils jusqu’au délai par défaut, souvent des dizaines de secondes.',
  },
  'circuit-breaker': {
    text: 'Un vrai disjoncteur s’ouvre après quelques secondes d’échecs, pas au premier, et laisse passer de temps en temps un appel pour tester la reprise.',
  },
  'queue-retention': {
    text: 'Kafka borne un sujet en durée ou en octets, RabbitMQ une file en longueur, SQS en durée. On dimensionne sur la plus longue panne de l’aval qu’on accepte, et on surveille l’âge du plus vieux message.',
  },
  'rate-limiting': {
    text: 'Une API limite par clé d’API et par classe de client, rarement d’une seule limite pour tous ; un scraper change d’adresses, et une limite par adresse ne le retient pas longtemps.',
  },
  'read-replica': {
    text: 'Un réplica a toujours un peu de retard sur le primaire (replica lag) : une lecture qui doit être à jour ne s’y fait pas.',
  },
  'leader-reads': {
    text: 'La garantie finale contre la double vente est une réservation atomique à l’écriture ; lire sur le primaire évite seulement de promettre ce qui n’est plus libre.',
  },
  idempotence: {
    text: 'Obligatoire avec toute file qui livre au moins une fois : les doublons arrivent en temps normal. On garde les clés déjà vues assez longtemps pour couvrir les relivraisons, et on les purge.',
  },
  outbox: {
    text: 'Une ligne de plus dans la même transaction que la commande, et un relais qui la publie : il faut le faire tourner et surveiller son retard.',
  },
};
