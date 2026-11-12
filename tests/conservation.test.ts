import { describe, expect, it } from 'vitest';
import { enumerate, maxedChoice, type BalanceSpace } from '../src/balance/canonical.ts';
import { balanceSpaces } from '../src/data/balance-space.ts';
import { catalog } from '../src/data/catalog.ts';
import * as U from '../src/data/scenarios/url-shortener.archetypes.ts';
import * as M from '../src/data/scenarios/market.archetypes.ts';
import { checkout } from '../src/data/scenarios/resilience.archetypes.ts';
import { boxOffice } from '../src/data/scenarios/tournament.archetypes.ts';
import { routeTable } from '../src/engine/routing.ts';
import { simulateWave } from '../src/engine/simulate.ts';
import type { Architecture, Catalog, RequestKind, Scenario, Wave, WaveResult } from '../src/engine/types.ts';
import { REQUEST_KINDS } from '../src/engine/types.ts';
import { upgradeLevel, validateArchitecture } from '../src/engine/validate.ts';

/**
 * Invariant de conservation (revue T2, action A1).
 *
 * Le moteur n'expose les échecs, l'écarté et l'arriéré que par nœud, tous types confondus ;
 * seuls les liens sont détaillés par type. L'invariant le plus strict qu'on puisse vérifier
 * de l'extérieur est donc un bilan par nœud et par tick, tous types confondus :
 *
 *   X = reçu + arriéré(t-1) − arriéré(t) − émis − échoué − écarté − dédoublonné + copies
 *
 * où X est ce que le nœud a servi sur place sans le transmettre. Puis :
 *   - X = 0 pour un nœud de transit (aucun type terminal, pas une bordure) : source, load
 *     balancer, serveur, file, pub/sub ne peuvent rien garder pour eux ;
 *   - 0 ≤ X ≤ reçu + arriéré pour un nœud terminal (base, cache, service métier) ;
 *   - pour une bordure, X ≤ taux de succès × lectures reçues : elle ne sert sur place que des
 *     lectures, et au plus sa part nominale.
 * Sommé sur les nœuds, les liens s'annulent et l'on obtient le bilan global du tick :
 *   offert + copies = servi + échoué + écarté + dédoublonné + variation d'arriéré.
 */

const EPS = 1e-6;
const close = (a: number, b: number, scale: number) => Math.abs(a - b) <= EPS * Math.max(1, Math.abs(scale));

interface Graph {
  arch: Architecture;
  catalog: Catalog;
  routes: ReturnType<typeof routeTable>;
  typeOf: Map<string, string>;
  /** Serveur qui publie vers une file ou un pub/sub et écrit dans une base à outbox. */
  outboxPublishers: Set<string>;
  ancestors: Map<string, Set<string>>;
}

function graphOf(arch: Architecture, catalog: Catalog): Graph {
  const routes = routeTable(arch, catalog);
  const typeOf = new Map(arch.nodes.map((n) => [n.id, n.type]));
  const behaviorOf = (id: string) => catalog.components[typeOf.get(id) ?? '']?.behavior;
  const byId = new Map(arch.nodes.map((n) => [n.id, n]));
  const hasEffect = (id: string, effect: string) =>
    Object.values(catalog.upgrades).some((u) => u.appliesTo === typeOf.get(id) && u.effect.type === effect && upgradeLevel(byId.get(id)!, u.id) > 0);
  // Même règle que `messagingRoles` du moteur : c'est elle qui décide de la copie en écriture.
  const outboxPublishers = new Set(
    arch.nodes
      .filter((n) => behaviorOf(n.id) === 'service')
      .filter((n) => routes.get(n.id)!.forward.async.some((t) => behaviorOf(t) === 'queue' || behaviorOf(t) === 'pubsub'))
      .filter((n) => routes.get(n.id)!.forward.write.some((t) => behaviorOf(t) === 'database' && hasEffect(t, 'outbox')))
      .map((n) => n.id),
  );
  const ancestors = new Map<string, Set<string>>();
  const up = (id: string): Set<string> => {
    const known = ancestors.get(id);
    if (known) return known;
    const set = new Set<string>();
    ancestors.set(id, set);
    for (const l of arch.links) if (l.to === id) for (const a of [l.from, ...up(l.from)]) set.add(a);
    return set;
  };
  for (const n of arch.nodes) up(n.id);
  return { arch, catalog, routes, typeOf, outboxPublishers, ancestors };
}

const KIND_SET = new Set<string>(REQUEST_KINDS);

/**
 * Vérifie l'invariant sur une vague jouée et renvoie les écarts, chacun préfixé d'un code :
 * un test peut ainsi isoler un écart connu sans éteindre le reste.
 */
function conservationViolations(arch: Architecture, wave: Wave, catalog: Catalog, result: WaveResult): string[] {
  const out: string[] = [];
  const report = (code: string, msg: string) => out.push(`${code} ${wave.id}: ${msg}`);
  const g = graphOf(arch, catalog);
  const defOf = (id: string) => catalog.components[g.typeOf.get(id)!]!;
  const sourceId = arch.nodes.find((n) => defOf(n.id).behavior === 'source')!.id;
  const incidentsById = new Map((wave.incidents ?? []).map((i) => [i.id, i]));

  // Deux nœuds qui relivrent en chaîne rendraient la part des doublons indéchiffrable depuis
  // les liens : aucun scénario ne le fait, on le refuse plutôt que de vérifier à moitié.
  const duplicating = new Set((wave.incidents ?? []).filter((i) => i.effect.type === 'duplicate-delivery').map((i) => i.component));
  for (const n of arch.nodes) {
    if (duplicating.has(n.type) && [...g.ancestors.get(n.id)!].some((a) => duplicating.has(g.typeOf.get(a)!))) {
      throw new Error(`cas non couvert : relivraison en chaîne jusqu'à ${n.id}`);
    }
  }

  const walk = (path: string, v: unknown) => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) report('nan', `${path} = ${v}`);
      else if (v < -EPS) report('negatif', `${path} = ${v}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(`${path}[${i}]`, x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(`${path}.${k}`, x);
  };
  walk('ticks', result.ticks);
  walk('failuresByReason', result.failuresByReason);
  walk('delivery', result.delivery);
  walk('totaux', { offered: result.offered, failed: result.failed, shed: result.shed });

  const maxBacklog = new Map<string, number>();
  for (const n of arch.nodes) {
    const def = defOf(n.id);
    if (def.behavior !== 'queue') continue;
    let cap = def.maxBacklog ?? Infinity;
    for (const u of Object.values(catalog.upgrades)) {
      if (u.effect.type === 'retention' && u.appliesTo === n.type) cap += u.effect.perLevel * upgradeLevel(n, u.id);
    }
    maxBacklog.set(n.id, cap);
  }

  const backlogPrev = new Map<string, number>();
  let undeliveredFromTicks = 0;
  let shedFromNodes = 0;
  let asyncFromSource = 0;
  let failedSoFar = 0;
  let retriedSoFar = 0;
  const nodeFailedTotal = new Map<string, number>();

  for (const t of result.ticks) {
    const at = `t${t.tick}`;
    const linkIn = new Map<string, Record<RequestKind, number>>();
    const linkOut = new Map<string, Record<RequestKind, number>>();
    const zero = (): Record<RequestKind, number> => ({ read: 0, write: 0, async: 0 });
    for (const [key, byKind] of Object.entries(t.links)) {
      const [from, to] = key.split('→') as [string, string];
      if (!g.arch.links.some((l) => l.from === from && l.to === to)) report('lien', `${at} ${key} : trafic sur un lien qui n'existe pas`);
      for (const [kind, rps] of Object.entries(byKind)) {
        if (!KIND_SET.has(kind)) continue;
        const k = kind as RequestKind;
        // Le routage n'envoie un type qu'à qui l'accepte : sinon ce trafic irait se perdre là-bas.
        if ((rps ?? 0) > 0 && !defOf(to).accepts.includes(k)) report('lien', `${at} ${key} porte du ${k} que ${to} n'accepte pas`);
        (linkIn.get(to) ?? linkIn.set(to, zero()).get(to)!)[k] += rps ?? 0;
        (linkOut.get(from) ?? linkOut.set(from, zero()).get(from)!)[k] += rps ?? 0;
      }
    }
    const active = (t.incidents ?? []).map((id) => incidentsById.get(id)!).filter(Boolean);

    let nodesFailed = 0;
    let served = 0;
    let copiesTotal = 0;
    let dedupTotal = 0;
    let shedTick = 0;
    let backlogDelta = 0;
    let deferredTick = 0;
    let requeuedTick = 0;
    for (const n of arch.nodes) {
      const nt = t.nodes[n.id];
      if (!nt) {
        report('noeud', `${at} ${n.id} absent des ticks`);
        continue;
      }
      const def = defOf(n.id);
      const inK = linkIn.get(n.id) ?? zero();
      const outK = linkOut.get(n.id) ?? zero();
      const inSum = REQUEST_KINDS.reduce((a, k) => a + inK[k], 0);
      const outSum = REQUEST_KINDS.reduce((a, k) => a + outK[k], 0);

      // Ce que le nœud dit avoir reçu doit être ce que les liens lui ont porté : sinon une
      // partie du trafic circule hors des liens, invisible du rendu comme du bilan.
      const received = n.id === sourceId ? t.offered : inSum;
      if (!close(nt.rps, received, received)) report('recu', `${at} ${n.id} rps ${nt.rps} ≠ liens entrants ${received}`);
      if (n.id === sourceId) asyncFromSource += outK.async;

      // Copies légitimes, reconstituées depuis les liens sortants.
      let copies = 0;
      const dup = Math.min(
        1,
        active.filter((i) => i.component === n.type && i.effect.type === 'duplicate-delivery').reduce((a, i) => a + (i.effect.type === 'duplicate-delivery' ? i.effect.share : 0), 0),
      );
      for (const k of REQUEST_KINDS) {
        // Un pub/sub copie chaque message à chacun de ses voisins ; une file le partage.
        const fan = def.fanOut ? Math.max(1, g.routes.get(n.id)!.forward[k].length) : 1;
        // Un incident de relivraison ajoute une copie de chaque événement original envoyé.
        const d = k === 'async' ? dup : 0;
        copies += outK[k] - outK[k] / (fan * (1 + d));
      }
      // Avec une outbox, l'événement est aussi écrit dans la base : une écriture de plus par
      // événement publié. Un circuit coupé ferait échouer une partie de ces événements après
      // la copie, ce que les liens ne permettent plus de démêler : aucun scénario ne combine les deux.
      if (g.outboxPublishers.has(n.id)) {
        if (nt.open?.length) throw new Error(`cas non couvert : outbox et circuit ouvert sur ${n.id}`);
        copies += outK.async;
      }

      const prev = backlogPrev.get(n.id) ?? 0;
      const now = nt.backlog ?? 0;
      const shed = nt.shed ?? 0;
      // Un doublon reconnu par l'idempotence est écarté sans échec : il sort quand même du flux.
      const dedup = nt.deduplicated ?? 0;
      // Un message de file que l'aval n'a pas pu traiter retourne dans sa file au même tick (M1) :
      // le nœud qui le rend ne le sert pas, la file le compte dans son arriéré.
      const deferred = nt.deferred ?? 0;
      const requeued = nt.requeued ?? 0;
      const kept = received + prev + requeued - now - outSum - nt.failed - shed - dedup - deferred + copies;
      const scale = received + prev + requeued + outSum + copies;

      const transit = def.terminalFor.length === 0 && def.behavior !== 'edge';
      if (transit) {
        if (!close(kept, 0, scale)) report('transit', `${at} ${n.id} (${def.behavior}) garde ${kept} req/s sans les servir ni les compter`);
      } else {
        if (kept < -EPS * Math.max(1, scale)) report('cree', `${at} ${n.id} (${def.behavior}) sert ${kept} : trafic créé`);
        if (kept > received + prev + EPS * Math.max(1, scale)) report('cree', `${at} ${n.id} sert ${kept} > reçu ${received + prev}`);
      }
      if (def.behavior === 'edge') {
        // Les absences de la bordure repartent ; les succès sont servis sur place, au plus `hitRate`.
        const bound = (def.hitRate ?? 0) * inK.read;
        if (kept > bound + EPS * Math.max(1, scale)) report('bordure', `${at} ${n.id} sert ${kept} > ${bound} (lectures × taux de succès)`);
      }
      // Un type terminal s'arrête là : en réémettre serait le compter deux fois.
      for (const k of def.terminalFor) {
        if (outK[k] > EPS) report('terminal', `${at} ${n.id} réémet ${outK[k]} de ${k}, type pour lequel il est terminal`);
      }
      if (maxBacklog.has(n.id) && now > maxBacklog.get(n.id)! * (1 + EPS)) {
        report('arriere', `${at} ${n.id} arriéré ${now} > ${maxBacklog.get(n.id)}`);
      }

      if (!transit) served += kept;
      nodesFailed += nt.failed;
      copiesTotal += copies;
      dedupTotal += dedup;
      shedTick += shed;
      backlogDelta += now - prev;
      deferredTick += deferred;
      requeuedTick += requeued;
      backlogPrev.set(n.id, now);
      nodeFailedTotal.set(n.id, (nodeFailedTotal.get(n.id) ?? 0) + nt.failed);
    }

    // Tout ce qu'un nœud rend à une file y est remis dans le même tick : rien ne reste en route.
    if (!close(deferredTick, requeuedTick, deferredTick)) report('retour', `${at} ${deferredTick} messages rendus ≠ ${requeuedTick} remis en file`);

    // Bilan global du tick : conséquence des bilans locaux, gardé pour l'énoncé qu'il donne.
    const lhs = t.offered + copiesTotal;
    const rhs = served + nodesFailed + shedTick + dedupTotal + backlogDelta;
    if (!close(lhs, rhs, lhs)) report('global', `${at} offert + copies ${lhs} ≠ servi + échoué + écarté + dédoublonné + Δarriéré ${rhs}`);

    // Le seul échec qui n'appartient à aucun nœud est le « non livré », calculé par différence
    // au niveau de la vague (simulate.ts, bloc `fanOut > 0`).
    const unattributed = t.failed - nodesFailed;
    if (unattributed < -EPS * Math.max(1, t.failed)) report('echecs', `${at} échecs du tick ${t.failed} < somme des nœuds ${nodesFailed}`);
    if (!wave.consumers?.length && !close(unattributed, 0, t.failed)) report('echecs', `${at} ${unattributed} échecs hors nœud sans contrôle de livraison`);
    undeliveredFromTicks += unattributed;
    shedFromNodes += shedTick;

    // Une relance répond à un échec d'un tick précédent : jamais plus de relances cumulées
    // que d'échecs cumulés avant elles.
    retriedSoFar += t.retries ?? 0;
    if (retriedSoFar > failedSoFar * (1 + EPS) + EPS) report('relances', `${at} ${retriedSoFar} relances cumulées pour ${failedSoFar} échecs avant elles`);
    failedSoFar += t.failed;
  }

  const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
  const offered = sum(result.ticks.map((t) => t.offered));
  const tickFailed = sum(result.ticks.map((t) => t.failed));
  const reasons = sum(Object.values(result.failuresByReason));
  if (!close(offered, result.offered, offered)) report('vague', `Σ offert ${offered} ≠ ${result.offered}`);
  if (!close(tickFailed, reasons, reasons)) report('vague', `Σ échecs des ticks ${tickFailed} ≠ Σ par raison ${reasons}`);
  if (!close(undeliveredFromTicks, result.failuresByReason.undelivered, reasons)) {
    report('vague', `échecs hors nœud ${undeliveredFromTicks} ≠ non livrés ${result.failuresByReason.undelivered}`);
  }
  if (!close(shedFromNodes, result.shed, result.shed)) report('vague', `Σ écarté des nœuds ${shedFromNodes} ≠ ${result.shed}`);
  // Un échec relancé sort du total : sa relance compte à sa place (S19). Une copie d'événement
  // perdue ne pèse que 1 / n services attendus (B9) : chaque événement compte au plus pour un.
  const fanOut = Math.max(1, wave.consumers?.length ?? 0);
  if (fanOut === 1) {
    if (!close(result.failed, tickFailed - retriedSoFar, tickFailed)) report('vague', `failed ${result.failed} ≠ Σ échecs ${tickFailed} − relances ${retriedSoFar}`);
  } else if (result.delivery) {
    // Les copies d'événement en échec sont ce qui manque à la livraison, moins ce qui attend encore en file.
    const copies = result.delivery.expected - result.delivery.delivered;
    const weighted = tickFailed - retriedSoFar - copies * (1 - 1 / fanOut);
    if (result.failed > tickFailed - retriedSoFar + EPS * Math.max(1, tickFailed)) report('vague', `failed ${result.failed} > Σ échecs ${tickFailed} − relances`);
    if (result.failed < weighted - EPS * Math.max(1, tickFailed)) report('vague', `failed ${result.failed} < échecs pondérés ${weighted}`);
  }
  for (const [id, f] of nodeFailedTotal) {
    if (!close(result.nodes[id]!.failed, f, f)) report('vague', `${id} : résumé ${result.nodes[id]!.failed} ≠ Σ ticks ${f}`);
  }
  const counted = result.offered - result.shed - retriedSoFar;
  if (counted > 0) {
    const rate = result.gauges.failureRate.value;
    if (rate < -EPS) report('taux', `taux d'échec ${rate} négatif`);
    // Corrigé par B9 : une copie d'événement perdue pèse 1 / n, le taux reste un taux.
    if (rate > 1 + EPS) report('taux', `taux d'échec ${rate} > 1`);
    if (!close(rate * counted, result.failed, counted)) report('taux', `taux ${rate} ≠ échecs ${result.failed} / ${counted}`);
  }
  if (result.delivery) {
    const { expected, delivered } = result.delivery;
    if (delivered > expected * (1 + EPS) + EPS) report('livraison', `livré ${delivered} > attendu ${expected}`);
    // Chaque abonné attend une copie de chaque événement émis par les clients, relances comprises.
    const want = asyncFromSource * (wave.consumers?.length ?? 0);
    if (!close(expected, want, want)) report('livraison', `attendu ${expected} ≠ async émis × abonnés ${want}`);
  }
  return out;
}

/** Pas de l'échantillon : une architecture sur `stride` de l'espace complet, plus ses bornes. */
const SAMPLE_PER_SCENARIO = 120;

function sample(space: BalanceSpace): Architecture[] {
  const all = [...enumerate(space)];
  const stride = Math.max(1, Math.ceil(all.length / SAMPLE_PER_SCENARIO));
  const picked = all.filter((_, i) => i % stride === 0).map((c) => c.arch);
  // L'architecture minimale et celle au maximum de tout encadrent l'espace.
  return [...picked, all.at(-1)!.arch, space.build(maxedChoice(space))];
}

/** Les architectures types des tests de scénario : les réponses attendues et leurs contre-exemples. */
const ARCHETYPES: Record<string, Architecture[]> = {
  'url-shortener': [
    U.minimal,
    // Sans base : tout finit en échec faute de route, ce qui doit aussi se compter.
    U.noDatabase,
    U.withCache,
    U.withReplica,
    ...[0, 1, 2, 3, 5, 9].map((n) => U.scaled(n)),
    ...[1, 2, 3, 4, 5].map((tier) => U.scaled(3, { rateLimitTier: tier })),
    U.inlineClicks(3),
    U.queuedClicks(3),
    U.withCdn(),
    U.withCdn({ rateLimitTier: U.TIER_40 }),
    U.withCdn({ rateLimitTier: U.TIER_40, queue: true }),
    U.autoscaled(2, 3),
    U.autoscaled(1, 6),
  ],
  market: [
    M.inline,
    M.queued,
    M.sharedQueue,
    ...M.DELIVERIES.map((d) => M.ordering(d)),
    M.fannedOut({ idempotence: true }),
    M.fannedOut({ idempotence: true, outbox: true }),
    M.fannedOut({ idempotence: true, outbox: true, cache: true, replicas: 2, extraInstances: 2 }),
    M.ordering('pubsub-direct', { idempotence: true, outbox: true }),
    M.fannedOut({ deadLetter: true }),
    M.ordering('shared-queue', { deadLetter: true }),
  ],
  resilience: [
    checkout(),
    checkout({ breaker: true }),
    checkout({ queue: true }),
    checkout({ cache: true }),
    checkout({ cache: true, coalescing: true }),
    checkout({ breaker: true, queue: true, cache: true, coalescing: true, replicas: 2, extraInstances: 2 }),
  ],
  tournament: [
    boxOffice(),
    boxOffice({ backoff: true, extraInstances: 1 }),
    boxOffice({ extraInstances: 1, autoscaling: 3 }),
    boxOffice({ queue: true, retention: 3 }),
    boxOffice({ replicas: 2, leaderReads: true, cache: true }),
    boxOffice({ backoff: true, extraInstances: 4, autoscaling: 6, cache: true, replicas: 3, leaderReads: true, queue: true, retention: 3 }),
  ],
};

interface Run {
  scenario: Scenario;
  arch: Architecture;
}

const runs: Run[] = balanceSpaces.flatMap(({ scenario, space }) =>
  [...sample(space), ...(ARCHETYPES[scenario.id] ?? [])]
    .filter((arch) => validateArchitecture(arch, catalog).ok)
    .map((arch) => ({ scenario, arch })),
);

const label = (arch: Architecture) =>
  arch.nodes
    .map((n) => `${n.id}${Object.values(n.upgrades ?? {}).some((v) => v > 0) ? JSON.stringify(n.upgrades) : ''}`)
    .join(',');

/** Écarts connus du moteur, isolés plus bas : leur code est exclu de l'invariant général. */
const KNOWN: string[] = [];

describe('conservation du trafic', () => {
  it('chaque scénario a ses architectures types et un échantillon de son espace', () => {
    for (const { scenario } of balanceSpaces) {
      expect(ARCHETYPES[scenario.id]?.length ?? 0).toBeGreaterThan(0);
      expect(runs.filter((r) => r.scenario === scenario).length).toBeGreaterThan(50);
    }
  });

  describe.each(balanceSpaces.map(({ scenario }) => [scenario.title, scenario] as const))('%s', (_, scenario) => {
    it.each(scenario.waves.map((w) => [w.id, w] as const))('vague %s : rien ne se crée, rien ne se perd', (_, wave) => {
      const violations: string[] = [];
      for (const { arch } of runs.filter((r) => r.scenario === scenario)) {
        const result = simulateWave(arch, wave, catalog);
        for (const v of conservationViolations(arch, wave, catalog, result)) {
          if (!KNOWN.some((code) => v.startsWith(`${code} `))) violations.push(`${v} [${label(arch)}]`);
        }
      }
      // Un seul écart suffit à le comprendre ; la liste complète noierait le rapport.
      expect(violations.slice(0, 5)).toEqual([]);
    });
  });
});

/**
 * Écarts trouvés par l'invariant, tous corrigés depuis. Un écart nouveau s'écrit en
 * `it.fails` (ce que le moteur devrait faire), avec son code dans `KNOWN`, jusqu'à sa correction.
 */
describe('écarts de conservation connus', () => {
  const play = (scenario: Scenario, waveId: string, arch: Architecture) => {
    const wave = scenario.waves.find((w) => w.id === waveId)!;
    return { wave, result: simulateWave(arch, wave, catalog) };
  };

  // E1, corrigé par B8 : l'async d'une requête rejetée par le limiteur suit son sort (C5),
  // en échec `rate-limited` pour un client légitime, écarté avec un abusif. Vague 5 du
  // raccourcisseur, palier 20 req/s : les 500 clics des 500 lectures rejetées des partenaires.
  it('E1 — l’async d’une requête rejetée par le limiteur est compté avec elle', () => {
    const arch = U.scaled(3, { rateLimitTier: 2 });
    const { wave, result } = play(balanceSpaces[0]!.scenario, 'click-tracking', arch);
    expect(conservationViolations(arch, wave, catalog, result)).toEqual([]);
    // Les partenaires envoient autant de clics que de lectures : chaque lecture rejetée emporte son clic.
    const rejectedReads = result.events.reduce((a, e) => a + (e.type === 'rate-limited' && e.source === 'partners' ? e.rejectedRps : 0), 0);
    expect(rejectedReads).toBeGreaterThan(0);
    expect(result.failuresByReason['rate-limited']).toBeCloseTo(2 * rejectedReads, 6);
  });

  // E2, corrigé par B9 : « non livré » se compte par copie, mais une copie ne pèse que 1 / n
  // services attendus dans le taux d'échec. Sans aucune livraison, le marché affichait 119 %
  // à la vague 2 ; un événement jamais livré compte désormais pour un échec, pas pour trois.
  it('E2 — le taux d’échec ne dépasse pas 100 %, même quand rien n’est livré', () => {
    const { result } = play(balanceSpaces[1]!.scenario, 'three-trades', M.ordering('none'));
    expect(result.gauges.failureRate.value).toBeLessThanOrEqual(1);
    expect(result.gauges.failureRate.value).toBeGreaterThan(0.25);
  });
});
