import { describe, expect, it } from 'vitest';
import { answersOf } from '../src/data/balance-space.ts';
import { catalog } from '../src/data/catalog.ts';
import * as A from '../src/data/scenarios/url-shortener.archetypes.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import type { Architecture } from '../src/engine/types.ts';

const waveById = (id: string) => {
  const w = urlShortener.waves.find((x) => x.id === id);
  if (!w) throw new Error(`Vague inconnue : ${id}`);
  return w;
};

const play = (arch: Architecture, waveId: string, previous?: Architecture) =>
  simulateWave(arch, waveById(waveId), catalog, previous);

/**
 * Chaque vague : gagnée avec la réponse attendue, perdue sans elle, et perdue avec
 * la réponse sur-dimensionnée. Si un recalibrage casse ces tests, c'est le jeu qui
 * a changé, pas seulement un chiffre.
 */
describe('Raccourcisseur d’URL', () => {
  // Les réponses attendues sont des données (`Wave.answers`), jouées ici isolément, sans
  // architecture précédente, comme l'énumération en masse : on vérifie ce qui peut gagner.
  it('chaque vague est gagnée par chacune de ses réponses attendues', () => {
    urlShortener.waves.forEach((w, i) => {
      const answers = answersOf(urlShortener.id, i);
      expect(answers.length, w.id).toBeGreaterThan(0);
      answers.forEach((arch, k) => expect(play(arch, w.id).won, `${w.id} #${k}`).toBe(true));
    });
  });

  it('vague 1 — un serveur et une base suffisent', () => {
    expect(play(A.noDatabase, 'launch').won).toBe(false);
    expect(play(A.withCache, 'launch').lossReasons).toEqual(['Trop complexe : 5 / 4 points']);
  });

  it('vague 2 — cache ou réplica en lecture, deux profils différents', () => {
    const cache = play(A.withCache, 'read-surge', A.minimal);
    const replica = play(A.withReplica, 'read-surge', A.minimal);
    expect(cache.gauges.cost.value).toBeLessThan(replica.gauges.cost.value);
    expect(replica.gauges.complexity.value).toBeLessThan(cache.gauges.complexity.value);

    expect(play(A.minimal, 'read-surge').won).toBe(false);
  });

  it('vague 3 — scaling horizontal derrière un load balancer', () => {
    expect(play(A.scaled(3), 'marketing-peak', A.withCache).won).toBe(true);
    expect(play(A.withCache, 'marketing-peak').won).toBe(false);
    expect(play(A.scaled(2), 'marketing-peak').won).toBe(false);
    expect(play(A.scaled(4), 'marketing-peak').lossReasons).toEqual(['Budget dépassé : 175 / 170']);
  });

  it('vague 3 — trois familles de réponses aux profils différents', () => {
    const permanent = play(A.scaled(3), 'marketing-peak');
    const auto = play(A.autoscaled(2, 3), 'marketing-peak');

    // L'autoscaling est moins cher que le scaling permanent.
    expect(auto.gauges.cost.value).toBeLessThan(permanent.gauges.cost.value);
    expect(auto.bill.autoscaling).toBeGreaterThan(0);
    expect(permanent.failed).toBe(0);
    // Sur un socle trop mince, la montée en charge sature le serveur le temps que les instances
    // démarrent : des échecs, et ces minutes lentes pèsent plus de 5 % des requêtes (M4).
    const thin = play(A.autoscaled(1, 3), 'marketing-peak');
    expect(thin.failed).toBeGreaterThan(0);
    expect(thin.losses.map((l) => l.kind)).toEqual(['latency']);

    // Les instances demandées démarrent avant de servir : le rendu montre ce chantier.
    const first = auto.ticks.findIndex((t) => (t.nodes.app!.starting ?? 0) > 0);
    expect(first).toBeGreaterThan(0);
    expect(auto.ticks[first + 2]!.nodes.app!.instances).toBeGreaterThan(auto.ticks[first]!.nodes.app!.instances!);

    // Sans socle d'instances fixes, l'autoscaling arrive trop tard sur le pic.
    expect(play(A.autoscaled(0, 3), 'marketing-peak').won).toBe(false);
  });

  it('vague 3 — le réplica choisi en vague 2 coûte une migration', () => {
    // Décision E3 : retirer le réplica pour poser le cache se paie dans la facture de la vague.
    const r = play(A.scaled(3), 'marketing-peak', A.withReplica);
    expect(r.bill.migration).toBe(40);
    expect(r.lossReasons).toEqual(['Budget dépassé : 195 / 170, dont 40 de migration']);
  });

  it('vague 4 — seule une limite bien choisie passe', () => {
    const at = (tier: number) => play(A.scaled(4, { rateLimitTier: tier }), 'noisy-client', A.scaled(3));
    const winning = [1, 2, 3, 4, 5].filter((tier) => at(tier).won);
    // Depuis M4, le palier 80 laisse passer assez de scraper pour ralentir la base, que les
    // lectures ratant le cache attendent : plus de 5 % des requêtes.
    expect(winning).toEqual([A.TIER_40]);
    expect(at(A.TIER_40 + 1).losses.map((l) => l.kind)).toEqual(['latency']);

    // Trop basse, elle coupe les partenaires légitimes ; trop haute, elle laisse passer le scraper.
    expect(at(2).failuresByReason['rate-limited']).toBeGreaterThan(0);
    expect(at(5).nodes.db!.peakUtilization).toBeGreaterThan(1);
    expect(at(A.TIER_40).shed).toBeGreaterThan(0);
  });

  it('vague 4 — le CDN n’arrête pas le scraper, qui parcourt la longue traîne', () => {
    expect(play(A.withCdn(), 'noisy-client').won).toBe(false);
    expect(play(A.withCdn({ rateLimitTier: A.TIER_40, extraInstances: 1 }), 'noisy-client').won).toBe(true);
  });

  it('vague 4 — les partenaires passent le CDN : une limite trop basse les coupe aussi derrière lui (SC1)', () => {
    const at = (tier: number) => play(A.withCdn({ rateLimitTier: tier, extraInstances: 1 }), 'noisy-client');
    expect([1, 2].map((tier) => at(tier).won)).toEqual([false, false]);
    expect(at(2).failuresByReason['rate-limited']).toBeGreaterThan(0);
    // Sans instance de plus, le serveur seul ne tient pas les lectures des partenaires.
    expect(play(A.withCdn({ rateLimitTier: A.TIER_40 }), 'noisy-client').won).toBe(false);
  });

  it('vague 4 — tout scaler au lieu de limiter dépasse le budget', () => {
    expect(play(A.scaled(4), 'noisy-client').won).toBe(false);
    expect(play(A.scaled(5, { rateLimitTier: A.TIER_40 }), 'noisy-client').lossReasons).toContain('Budget dépassé : 200 / 180');
  });

  // La réponse sans CDN de la vague 5, et sa limite par classe, reprises par la vague 6.
  const keyed = { partnerTier: A.PARTNER_160, anonymousTier: A.ANONYMOUS_10, extraInstances: 4, replicas: 1 };

  it('vague 5 — aucune limite unique ne sépare les partenaires du scraper (C7)', () => {
    const at = (tier: number) => play(A.scaled(4, { rateLimitTier: tier }), 'partner-keys', A.scaled(4, { rateLimitTier: A.TIER_40 }));
    expect([1, 2, 3, 4, 5].filter((tier) => at(tier).won)).toEqual([]);
    // À 80 et en dessous, elle coupe les partenaires (125 req/s par clé) ; à 160, le scraper
    // (60 req/s par adresse) passe en entier et noie la base.
    expect([1, 2, 3, 4].every((tier) => at(tier).failuresByReason['rate-limited'] > 0)).toBe(true);
    expect(at(5).failuresByReason['rate-limited']).toBe(0);
    expect(at(5).nodes.db!.peakUtilization).toBeGreaterThan(1);
    // L'acheter en réplicas et en instances dépasse le budget.
    const absorbed = A.scaled(5, { rateLimitTier: 5 });
    absorbed.nodes = absorbed.nodes.map((n) => (n.id === 'db' ? { ...n, upgrades: { 'read-replica': 3 } } : n));
    const bought = play(absorbed, 'partner-keys');
    expect(bought.gauges.failureRate.value).toBeLessThan(0.01);
    expect(bought.losses.map((l) => l.kind)).toEqual(['budget']);
  });

  it('vague 5 — la passerelle d’API donne à chaque classe sa limite, avec ou sans CDN', () => {
    const r = play(A.gated(keyed), 'partner-keys');
    expect(r.won).toBe(true);
    expect(r.failuresByReason['rate-limited']).toBe(0);
    expect(r.shed).toBeGreaterThan(0);
    expect(play(A.gated({ partnerTier: A.PARTNER_160, anonymousTier: A.ANONYMOUS_10, cdn: true, extraInstances: 2 }), 'partner-keys').won).toBe(true);
    // Derrière le CDN, les partenaires n'échappent pas à leur quota : leurs lectures ne s'y gardent pas (SC1).
    const behindCdn = play(A.gated({ partnerTier: 4, anonymousTier: A.ANONYMOUS_10, cdn: true, extraInstances: 2 }), 'partner-keys');
    expect(behindCdn.failuresByReason['rate-limited']).toBeGreaterThan(0);
  });

  it('vague 5 — chaque limite de classe est nécessaire, à son palier', () => {
    // Sans quota par clé, le script qui boucle passe ; à 80, les partenaires sont coupés.
    expect(play(A.gated({ ...keyed, partnerTier: 0 }), 'partner-keys').won).toBe(false);
    expect(play(A.gated({ ...keyed, partnerTier: 4 }), 'partner-keys').failuresByReason['rate-limited']).toBeGreaterThan(0);
    // Sans limite par adresse, ou à 40, le scraper passe.
    expect(play(A.gated({ ...keyed, anonymousTier: 0 }), 'partner-keys').won).toBe(false);
    expect(play(A.gated({ ...keyed, anonymousTier: 3 }), 'partner-keys').won).toBe(false);
  });

  it('vague 5 — un saut de plus : sans CDN, la passerelle coûte une instance', () => {
    // 5 ms de plus sur chaque requête : sur 4 instances, le p95 sort de l'objectif.
    const short = play(A.gated({ ...keyed, extraInstances: 3 }), 'partner-keys');
    expect(short.losses.map((l) => l.kind)).toEqual(['latency']);
    // Derrière le CDN, la limite unique gardée en plus, même à 160, coûte un point de complexité de trop.
    const cdn = { partnerTier: A.PARTNER_160, anonymousTier: A.ANONYMOUS_10, cdn: true, extraInstances: 2 };
    expect(play(A.gated({ ...cdn, singleLimit: 5 }), 'partner-keys').losses.map((l) => l.kind)).toEqual(['complexity']);
    // Sur-dimensionnée, elle dépasse le budget.
    expect(play(A.gated({ ...keyed, extraInstances: 5 }), 'partner-keys').losses.map((l) => l.kind)).toEqual(['budget']);
  });

  it('vague 6 — file de messages pour compter les clics hors du chemin critique', () => {
    expect(waveById('click-tracking').singleStrategy).toBe(true);
    expect(play(A.gated({ ...keyed, queue: true }), 'click-tracking', A.gated(keyed)).won).toBe(true);
    const inline = play(A.gated(keyed), 'click-tracking');
    expect(inline.won).toBe(false);
    expect(inline.nodes.db!.peakUtilization).toBeGreaterThan(1);
  });

  it('vague 6 — le worker tombe : la file garde les clics, puis les rend', () => {
    const r = play(A.gated({ ...keyed, queue: true }), 'click-tracking');
    expect(r.won).toBe(true);
    const incident = r.ticks.find((t) => t.incidents?.includes('worker-crash'))!.tick;
    const end = incident + waveById('click-tracking').incidents![0]!.until - waveById('click-tracking').incidents![0]!.from;
    expect(r.ticks[end - 1]!.nodes.queue!.backlog).toBeGreaterThan(0);
    // Le worker revenu, la file se vide au rythme de ce que la base écrit (M1) : sans rien perdre.
    const after = r.ticks.slice(end).map((t) => t.nodes.queue!.backlog ?? 0);
    expect(after.every((b, i) => i === 0 || b <= after[i - 1]!)).toBe(true);
    expect(after.at(-1)).toBe(0);
    expect(r.failuresByReason['queue-overflow']).toBe(0);
    expect(r.ticks.slice(end).every((t) => t.nodes.db!.failed === 0)).toBe(true);
  });

  it('vague 6 — le CDN perd les clics des redirections en cache', () => {
    // Le débat 301 contre 302 : une redirection servie en bordure ne passe jamais par le serveur.
    const r = play(A.gated({ ...keyed, cdn: true, queue: true }), 'click-tracking');
    expect(r.won).toBe(false);
    expect(r.failuresByReason['lost-at-edge']).toBeGreaterThan(0);
  });

  it('une évolution ajoutée ne casse pas la vague précédente', () => {
    // Le joueur garde son schéma d'une vague à l'autre : le rate limiting ajouté en
    // vague 4 ne doit pas rejeter le trafic légitime du pic de la vague 3.
    const r = play(A.scaled(3, { rateLimitTier: A.TIER_40 }), 'marketing-peak');
    expect(r.won).toBe(true);
    expect(r.failuresByReason['rate-limited']).toBe(0);
  });
});
