import type { Scenario } from '../../engine/types.ts';
import { market } from './market.ts';
import { resilience } from './resilience.ts';
import { tournament } from './tournament.ts';
import { urlShortener } from './url-shortener.ts';

/** Les scénarios proposés à l'écran de choix, dans l'ordre conseillé (décision S2). */
export const SCENARIOS: { scenario: Scenario; level: string; pitch: string }[] = [
  {
    scenario: urlShortener,
    level: 'Débutant',
    pitch: 'Un raccourcisseur d’URL : serveurs, base, cache, CDN, rate limiting, file de messages.',
  },
  {
    scenario: market,
    level: 'Suite',
    pitch: 'Une boutique en ligne : diffuser chaque commande à plusieurs services, sans doublon ni perte (pub/sub, idempotence, outbox).',
  },
  {
    scenario: resilience,
    level: 'Résilience',
    pitch: 'Un paiement chez un prestataire qui ralentit ou tombe : cascade de pannes, circuit breaker, paiement différé, ruée vers le cache.',
  },
  {
    scenario: tournament,
    level: 'Distribué',
    pitch: 'Une billetterie prise d’assaut : tempête de relances et backoff, file qui déborde, partition réseau et lectures cohérentes.',
  },
];

export const scenarioById = (id: string): Scenario | undefined => SCENARIOS.find((s) => s.scenario.id === id)?.scenario;
