import type { Scenario, TrafficSource } from '../../engine/types.ts';

const TICKS = 60;
const flat = [{ until: TICKS, factor: 1 }];
/** Le trafic monte au départ et retombe à la fin (décision S11). */
const RAMP = { up: 8, down: 8 };

const users = (rps: TrafficSource['rps']): TrafficSource => ({ id: 'users', clients: 1000, rps });

// Légitimes mais gourmands : une limite trop basse les coupe (décision C2). Ils appellent
// l'API, dont les réponses ne se gardent pas en bordure : un CDN ne les arrête pas (SC1).
const partners = (rps: TrafficSource['rps']): TrafficSource => ({ id: 'partners', clients: 50, noEdgeCache: true, rps });

// Quelques adresses à très fort débit : une limite trop haute les laisse passer.
// Il visite tous les liens, donc aucun cache ne l'arrête : seul le rate limiting le fait.
const scraper: TrafficSource = { id: 'scraper', clients: 2, abusive: true, longTail: true, rps: { read: 2000 } };

export const urlShortener: Scenario = {
  id: 'url-shortener',
  title: 'Raccourcisseur d’URL',
  subtitle: 'Hold the Line : les portes de la cité',
  waves: [
    {
      id: 'launch',
      title: 'Lancement',
      briefing: 'Le service ouvre : 100 requêtes par seconde, 90 % de lectures (les redirections) et 10 % d’écritures (les raccourcis créés). Un serveur d’application et une base de données suffisent.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [users({ read: 90, write: 10 })],
      sla: { maxFailureRate: 0.01, maxP95LatencyMs: 60 },
      budget: 100,
      complexityCap: 4,
      // Vague tutoriel : poser les briques de base, il n'y a rien à arbitrer.
      singleStrategy: true,
      thriftyCost: 70,
      answers: [
        {  },
      ],
    },
    {
      id: 'read-surge',
      title: 'Les lectures explosent',
      briefing: 'Les liens circulent : 900 lectures par seconde, toujours 10 écritures. Une base seule encaisse 600 requêtes par seconde.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [users({ read: 900, write: 10 })],
      sla: { maxFailureRate: 0.01, maxP95LatencyMs: 60 },
      budget: 115,
      complexityCap: 7,
      thriftyCost: 85,
      answers: [
        { cache: 1 },
        { replicas: 1 },
        // Au prix d'un CDN réaliste (M9a), les redirections servies en bordure suffisent aussi.
        { cdn: 1 },
      ],
      // Sans danger pour un réplica ; un cache tient, mais on voit la base encaisser la ruée.
      incidents: [{ id: 'cache-restart', title: 'Le cache redémarre à froid', component: 'cache', from: 30, until: 35, effect: { type: 'cold-cache' } }],
    },
    {
      id: 'marketing-peak',
      title: 'Campagne marketing',
      briefing:
        'Une campagne est lancée : le trafic monte en quelques minutes jusqu’à 5 fois la normale (4 500 lectures par seconde), pendant un tiers de la vague (20 minutes). Une instance de serveur d’application traite 1 500 requêtes par seconde.',
      ticks: TICKS,
      ramp: RAMP,
      profile: [
        { until: 20, factor: 1 },
        { until: 22, factor: 2 },
        { until: 24, factor: 3.5 },
        { until: 40, factor: 5 },
        { until: TICKS, factor: 1 },
      ],
      sources: [users({ read: 900, write: 10 })],
      sla: { maxFailureRate: 0.01, maxP95LatencyMs: 60 },
      budget: 170,
      complexityCap: 9,
      thriftyCost: 125,
      // Plus de CDN + réplica depuis M4 : les 20 % de lectures que la bordure laisse passer
      // attendent une base à 87 %, et ce sont plus de 5 % des requêtes. Plus d'autoscaling sur
      // une seule instance fixe : les minutes de la montée, où le serveur sature, pèsent trop.
      answers: [
        { cdn: 1, cache: 1 },
        { lb: 1, scaling: 3, cache: 1 },
        { lb: 1, scaling: 2, autoscaling: 3, cache: 1 },
      ],
      // Après le pic : une cité à serveur unique perd quelques requêtes, pas la vague.
      incidents: [{ id: 'server-crash', title: 'Une instance du serveur tombe', component: 'app-server', from: 45, until: 50, effect: { type: 'instance-down', count: 1 } }],
    },
    {
      id: 'noisy-client',
      title: 'Un client trop gourmand',
      briefing:
        'La campagne a marché, le trafic de pointe est devenu la norme. 50 partenaires intègrent l’API, à 30 requêtes par seconde chacun. Et un scraper, depuis 2 adresses, envoie 1 000 requêtes par seconde par adresse en visitant tous les liens.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [users({ read: 3000, write: 50 }), partners({ read: 1500 }), scraper],
      sla: { maxFailureRate: 0.01, maxP95LatencyMs: 60 },
      // Les partenaires passent le CDN (SC1) : derrière lui, il faut une instance de plus, d'où
      // le budget et le plafond relevés pour que la stratégie CDN reste jouable.
      budget: 180,
      complexityCap: 10,
      thriftyCost: 160,
      // Depuis M4, les lectures qui ratent le cache attendent serveur et base, et pèsent plus de
      // 5 % : sans CDN, il faut une instance de plus, et le palier 80 laisse passer trop de scraper.
      answers: [
        { lb: 1, scaling: 4, rateLimit: 3, cache: 1 },
        { cdn: 1, lb: 1, scaling: 1, rateLimit: 3, cache: 1 },
        // Plus d'autoscaling ici depuis M9b : sur un trafic qui ne retombe pas, l'instance à la
        // demande, plus chère, coûte plus que l'instance fixe qu'elle remplace.
      ],
      conceptRef: 'Rate Limiting',
    },
    {
      id: 'click-tracking',
      title: 'Compter les clics',
      briefing:
        'Le marketing veut le nombre de clics de chaque lien. Chaque redirection doit être comptée, sans ralentir la redirection. Et le worker qui compte les clics tombera dix minutes : aucun clic ne doit se perdre.',
      ticks: TICKS,
      ramp: RAMP,
      profile: flat,
      sources: [users({ read: 3000, write: 50, async: 3000 }), partners({ read: 1500, async: 1500 }), scraper],
      sla: { maxFailureRate: 0.01, maxP95LatencyMs: 60 },
      budget: 225,
      complexityCap: 12,
      conceptRef: 'Backpressure',
      thriftyCost: 205,
      answers: [
        { lb: 1, scaling: 3, rateLimit: 3, cache: 1, queue: 1 },
      ],
      // La file est la seule réponse ; un CDN posé en vague 3 y perd les clics des redirections en cache.
      singleStrategy: true,
      // Le worker tombe dix minutes : la file garde les clics le temps qu'il revienne, puis se
      // vide au rythme de ce que la base écrit (M8). Un second worker encaisserait la panne.
      incidents: [{ id: 'worker-crash', title: 'Le worker tombe', component: 'worker', from: 30, until: 40, effect: { type: 'instance-down', count: 1 } }],
    },
  ],
};
