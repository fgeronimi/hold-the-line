import type { Scenario, TrafficSource } from '../../engine/types.ts';

const TICKS = 60;
const flat = [{ until: TICKS, factor: 1 }];

const users = (rps: TrafficSource['rps']): TrafficSource => ({ id: 'users', clients: 1000, rps });

// Légitimes mais gourmands : une limite trop basse les coupe (décision C2).
const partners = (rps: TrafficSource['rps']): TrafficSource => ({ id: 'partners', clients: 50, rps });

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
      briefing: 'Le service ouvre : 100 requêtes par seconde, 90 % de redirections.',
      ticks: TICKS,
      profile: flat,
      sources: [users({ read: 90, write: 10 })],
      sla: { maxFailureRate: 0.01, maxP95LatencyMs: 60 },
      budget: 100,
      complexityCap: 4,
      // Vague tutoriel : poser les briques de base, il n'y a rien à arbitrer.
      singleStrategy: true,
    },
    {
      id: 'read-surge',
      title: 'Les lectures explosent',
      briefing: 'Les liens circulent : les redirections sont multipliées par 10.',
      ticks: TICKS,
      profile: flat,
      sources: [users({ read: 900, write: 10 })],
      sla: { maxFailureRate: 0.01, maxP95LatencyMs: 60 },
      budget: 115,
      complexityCap: 7,
    },
    {
      id: 'marketing-peak',
      title: 'Campagne marketing',
      briefing:
        'Une campagne est lancée : le trafic monte en quelques secondes jusqu’à 5 fois la normale, pendant un tiers de la vague.',
      ticks: TICKS,
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
    },
    {
      id: 'noisy-client',
      title: 'Un client trop gourmand',
      briefing:
        'La campagne a marché, le trafic de pointe est devenu la norme. 50 partenaires intègrent l’API, à 30 requêtes par seconde chacun. Et un scraper, depuis 2 adresses, envoie 1 000 requêtes par seconde par adresse en visitant tous les liens.',
      ticks: TICKS,
      profile: flat,
      sources: [users({ read: 3000, write: 50 }), partners({ read: 1500 }), scraper],
      sla: { maxFailureRate: 0.01, maxP95LatencyMs: 60 },
      budget: 165,
      complexityCap: 9,
      conceptRef: 'Rate Limiting',
    },
    {
      id: 'click-tracking',
      title: 'Compter les clics',
      briefing:
        'Le marketing veut le nombre de clics de chaque lien. Chaque redirection doit être comptée, sans ralentir la redirection.',
      ticks: TICKS,
      profile: flat,
      sources: [users({ read: 3000, write: 50, async: 3000 }), partners({ read: 1500, async: 1500 }), scraper],
      sla: { maxFailureRate: 0.01, maxP95LatencyMs: 60 },
      budget: 225,
      complexityCap: 12,
      conceptRef: 'Backpressure',
      // La file est la seule réponse ; un CDN posé en vague 3 y perd les clics des redirections en cache.
      singleStrategy: true,
    },
  ],
};
