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
    const auto = play(A.autoscaled(1, 3), 'marketing-peak');

    // L'autoscaling est moins cher que le scaling permanent, mais échoue un peu pendant la montée en charge.
    expect(auto.gauges.cost.value).toBeLessThan(permanent.gauges.cost.value);
    expect(auto.bill.autoscaling).toBeGreaterThan(0);
    expect(auto.failed).toBeGreaterThan(0);
    expect(permanent.failed).toBe(0);

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
    const at = (tier: number) => play(A.scaled(3, { rateLimitTier: tier }), 'noisy-client', A.scaled(3));
    const winning = [1, 2, 3, 4, 5].filter((tier) => at(tier).won);
    expect(winning).toEqual([A.TIER_40, A.TIER_40 + 1]);

    // Trop basse, elle coupe les partenaires légitimes ; trop haute, elle laisse passer le scraper.
    expect(at(2).failuresByReason['rate-limited']).toBeGreaterThan(0);
    expect(at(5).nodes.db!.peakUtilization).toBeGreaterThan(1);
    expect(at(A.TIER_40).shed).toBeGreaterThan(0);
  });

  it('vague 4 — le CDN n’arrête pas le scraper, qui parcourt la longue traîne', () => {
    expect(play(A.withCdn(), 'noisy-client').won).toBe(false);
    expect(play(A.withCdn({ rateLimitTier: A.TIER_40 }), 'noisy-client').won).toBe(true);
  });

  it('vague 4 — tout scaler au lieu de limiter dépasse le budget', () => {
    expect(play(A.scaled(3), 'noisy-client').won).toBe(false);
    expect(play(A.scaled(5), 'noisy-client').lossReasons).toContain('Budget dépassé : 195 / 165');
  });

  it('vague 5 — file de messages pour compter les clics hors du chemin critique', () => {
    expect(waveById('click-tracking').singleStrategy).toBe(true);
    expect(play(A.queuedClicks(4), 'click-tracking').won).toBe(true);
    const inline = play(A.inlineClicks(4), 'click-tracking');
    expect(inline.won).toBe(false);
    expect(inline.nodes.db!.peakUtilization).toBeGreaterThan(1);
  });

  it('vague 5 — le worker tombe : la file garde les clics, puis les rend', () => {
    const r = play(A.queuedClicks(4), 'click-tracking');
    expect(r.won).toBe(true);
    expect(r.ticks[31]!.nodes.queue!.backlog).toBeGreaterThan(0);
    expect(r.ticks[34]!.nodes.queue!.backlog ?? 0).toBe(0);
    expect(r.failuresByReason['queue-overflow']).toBe(0);
  });

  it('vague 5 — le CDN de la vague 3 perd les clics des redirections en cache', () => {
    // Le débat 301 contre 302 : une redirection servie en bordure ne passe jamais par le serveur.
    const r = play(A.withCdn({ rateLimitTier: A.TIER_40, queue: true }), 'click-tracking');
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
