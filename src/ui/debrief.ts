import { incidentLessons, paradeCosts, reasonLessons, saturationLessons, type Lesson } from '../data/lessons.ts';
import { bill } from '../engine/budget.ts';
import { superfluous as superfluousOf, type Spare } from '../engine/lean.ts';
import { simulateWave } from '../engine/simulate.ts';
import type { Architecture, Catalog, RequestKind, TickMetrics, UpgradeEffect, Wave, WaveResult } from '../engine/types.ts';
import { hasEffect, resolveUpgrades, withEffect } from '../engine/upgrades.ts';
import { percent as pct } from '../render/html.ts';
import { nodeNames, type DebriefLine, type Theme } from '../render/theme.ts';

/** Un débit lisible : « 7 200 ». */
const fmtCount = (x: number) => Math.round(x).toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ');

/**
 * Un constat du chambellan après une vague.
 * - `good` : ce qui a marché ;
 * - `warn` : ce qui a failli casser, sur une vague tenue ;
 * - `bad` : ce qui a fait perdre la vague ;
 * - `tip` : ce qu'on pourrait alléger.
 */
export interface Finding {
  tone: 'bad' | 'warn' | 'good' | 'tip';
  /** Dit dans la métaphore. */
  says: string;
  /** La même chose en vrai, avec les termes techniques. */
  tech?: string;
  remedy?: string;
  concept?: string;
  /** Ce qui aurait prévenu : la métrique à surveiller et son seuil (D1). */
  signal?: string;
  node?: string;
}

const KIND_NAMES: Record<RequestKind, string> = { read: 'lecture', write: 'écriture', async: 'async' };

/** Au-delà, un bâtiment est trop près de sa capacité pour encaisser la prochaine affluence. */
const HOT = 0.8;
/** Minutes d'attente du plus vieux message au-delà desquelles le debrief le raconte (M13). */
const QUEUE_AGE_WARNING = 10;

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}

function fromLesson(tone: Finding['tone'], lesson: Lesson, vars: Record<string, string>, node?: string): Finding {
  const f: Finding = {
    tone,
    says: fill(lesson.says, vars),
    tech: fill(lesson.tech, vars),
    remedy: fill(lesson.remedy, vars),
    concept: lesson.concept,
  };
  if (lesson.signal) f.signal = lesson.signal;
  if (node) f.node = node;
  return f;
}

const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);

/** Débit d'un type sur les liens qui partent d'un nœud (`from`) ou y arrivent (`to`), sur toute la vague. */
function flow(ticks: TickMetrics[], kind: RequestKind, end: 'from' | 'to', id: string): number {
  const side = end === 'from' ? 0 : 1;
  return sum(
    ticks.flatMap((t) =>
      Object.entries(t.links)
        .filter(([key]) => key.split('→')[side] === id)
        .map(([, k]) => k[kind] ?? 0),
    ),
  );
}

/**
 * Le debrief raconte la vague en trois temps : ce qui a marché, ce qui a failli casser
 * (dans l'ordre où c'est arrivé), et ce qu'on pourrait alléger. Le rouge est réservé à
 * ce qui a fait perdre la vague : un incident encaissé est une alerte, pas un échec.
 * Pur : se teste sans interface.
 */
export function analyzeWave(result: WaveResult, arch: Architecture, wave: Wave, catalog: Catalog, theme: Theme): Finding[] {
  const typeOf = new Map(arch.nodes.map((n) => [n.id, n.type]));
  const names = (id: string) => {
    const node = arch.nodes.find((n) => n.id === id);
    return node ? nodeNames(node, catalog, theme) : { tech: id, metaphor: '' };
  };
  const metaphor = (id: string) => names(id).metaphor || id;
  const name = (id: string) => {
    const { tech, metaphor: m } = names(id);
    return `${tech}${m ? ` (${m})` : ''}`;
  };
  const behaviorOf = (id: string) => catalog.components[typeOf.get(id) ?? '']?.behavior;
  const ofBehavior = (b: string) => arch.nodes.filter((n) => catalog.components[n.type]?.behavior === b).map((n) => n.id);
  const won = result.won;
  const line = (l: DebriefLine, vars: Record<string, string> = {}) => fill(theme.debrief[l], vars);
  // Les évolutions se reconnaissent à leur effet, comme dans le moteur : pas à leur identifiant.
  const upgradesOf = (n: Architecture['nodes'][number]) => resolveUpgrades(n, catalog);
  const anyHas = (effect: UpgradeEffect['type']) => arch.nodes.some((n) => hasEffect(upgradesOf(n), effect));
  // Une limite par classe de client (C7) se dit à part de la limite unique : ni le même compromis,
  // ni la même victoire.
  const limits = arch.nodes.flatMap((n) => withEffect(upgradesOf(n), 'rateLimit').filter((u) => u.level > 0));
  const classLimits = limits.some((u) => u.effect.class !== undefined);
  const singleLimit = limits.some((u) => u.effect.class === undefined);
  const problem: Finding['tone'] = won ? 'warn' : 'bad';

  // Les ticks d'incident : ce qui y déborde est raconté par l'incident, pas comme un goulot.
  const incidents = (wave.incidents ?? []).filter((i) => arch.nodes.some((n) => n.type === i.component));
  const inIncident = (tick: number) => incidents.some((i) => tick >= i.from && tick < i.until);
  const calm = result.ticks.filter((t) => !inIncident(t.tick));

  const story: { tick: number; finding: Finding }[] = [];
  const tell = (tick: number, finding: Finding) => story.push({ tick, finding });

  // Requêtes sans route : un lien manque.
  const noRoute = new Map<string, { tick: number; kinds: Set<RequestKind> }>();
  for (const e of result.events) {
    if (e.type !== 'no-route') continue;
    const entry = noRoute.get(e.node) ?? { tick: e.tick, kinds: new Set<RequestKind>() };
    entry.kinds.add(e.kind);
    noRoute.set(e.node, entry);
  }
  for (const [node, { tick, kinds }] of noRoute) {
    const kind = [...kinds].map((k) => KIND_NAMES[k]).join(', ');
    tell(tick, fromLesson('bad', reasonLessons.noRoute, { name: name(node), kind }, node));
  }

  // Tempête de relances (S19) : les relances ont dépassé la moitié du trafic neuf. Elle
  // raconte alors la panne qui l'a amorcée : la leçon de l'incident seul serait trompeuse.
  const storm = result.ticks.find((t) => (t.retries ?? 0) > 0.5 * (t.offered - (t.retries ?? 0)));

  // Un message empoisonné qu'une file garde encore au dernier tick la bloque pour de bon (S25) :
  // ce qui manque aux services vient de lui, pas d'un abonnement oublié.
  const lastTick = result.ticks.at(-1);
  const stillPoisoned = !!lastTick && Object.values(lastTick.nodes).some((t) => (t.poisoned ?? 0) > 0);
  const deadLetters = sum(Object.values(lastTick?.nodes ?? {}).map((t) => t.deadLetters ?? 0));

  // Incidents : ce qu'ils ont coûté, ou comment la cité les a encaissés.
  for (const incident of incidents) {
    if (storm && incident.from <= storm.tick && incident.effect.type === 'instance-down') continue;
    if (incident.effect.type === 'poison-message') {
      const lesson = incidentLessons['poison-message'];
      const vars = { title: incident.title, failed: fmtCount(result.failuresByReason.undelivered), dead: fmtCount(deadLetters) };
      // Mis de côté, le message n'est pas traité : une alerte, même quand la file a tenu.
      if (stillPoisoned) tell(incident.from, fromLesson(problem, lesson.hurt, vars));
      else if (deadLetters >= 1) tell(incident.from, fromLesson(won ? 'warn' : problem, lesson.held, vars));
      continue;
    }
    const failed = Math.round(sum(result.ticks.slice(incident.from, incident.until).map((t) => t.failed)));
    const lesson = incidentLessons[incident.effect.type];
    const vars = { title: incident.title, failed: String(failed) };
    // Le disjoncteur a évité la cascade : ce qui a échoué, ce sont les appels qu'il a coupés.
    const cut = incident.effect.type === 'slow-dependency' && failed > 0 && !result.events.some((e) => e.type === 'threads-exhausted');
    const dependency = arch.nodes.find((n) => n.type === incident.component)?.id;
    const gaveUp = result.failuresByReason['timed-out'] > 0 && result.failuresByReason['circuit-open'] === 0;
    if (cut && dependency && gaveUp) {
      tell(incident.from, fromLesson(problem, reasonLessons.timedOut, { name: name(dependency), metaphor: metaphor(dependency).toLowerCase(), failed: String(failed) }, dependency));
    } else if (cut && dependency) {
      tell(incident.from, fromLesson(problem, reasonLessons.circuitOpen, { name: name(dependency), metaphor: metaphor(dependency).toLowerCase(), failed: String(failed) }, dependency));
    } else {
      tell(incident.from, fromLesson(failed > 0 ? problem : 'good', failed > 0 ? lesson.hurt : lesson.held, vars));
    }
  }

  // Goulots hors incident, du plus d'échecs au moins.
  const saturated = Object.keys(result.nodes)
    .filter((id) => !noRoute.has(id))
    .map((id) => {
      const hot = calm.filter((t) => (t.nodes[id]?.utilization ?? 0) > 1);
      return { id, first: hot[0]?.tick, failed: sum(hot.map((t) => t.nodes[id]?.failed ?? 0)) };
    })
    .filter((s): s is { id: string; first: number; failed: number } => s.first !== undefined)
    .sort((a, b) => b.failed - a.failed)
    .slice(0, 2);
  for (const s of saturated) {
    const lesson = saturationLessons[typeOf.get(s.id) ?? ''];
    if (lesson) tell(s.first, fromLesson(problem, lesson, { name: metaphor(s.id) }, s.id));
  }

  const limited = result.events.find((e) => e.type === 'rate-limited');
  if (result.failuresByReason['rate-limited'] > 0) tell(limited?.type === 'rate-limited' ? limited.tick : 0, fromLesson(problem, reasonLessons.legitLimited, {}));
  if (result.failuresByReason['lost-at-edge'] > 0) tell(0, fromLesson(problem, reasonLessons.lostAtEdge, {}));
  // Doublons et pertes : racontés par leur incident quand il y en a un, sinon ici.
  const told = (effect: string) => incidents.some((i) => i.effect.type === effect);
  const firstFailing = (reason: string) => Object.entries(result.nodes).find(([, x]) => x.failed > 0)?.[0] ?? reason;
  if (result.failuresByReason.duplicate > 0 && !told('duplicate-delivery')) {
    tell(0, fromLesson(problem, reasonLessons.duplicate, { name: name(firstFailing('consommateur')) }));
  }
  if (result.failuresByReason['lost-event'] > 0 && !told('publish-loss')) {
    tell(0, fromLesson(problem, reasonLessons.lostEvent, { name: name(firstFailing('serveur')) }));
  }
  const expected = wave.consumers?.length ?? 0;
  // Un reste d'arrondi n'est pas un service oublié : au moins un message entier.
  if (result.failuresByReason.undelivered >= 1 && result.delivery && expected > 0 && !stillPoisoned) {
    const reached = (result.delivery.delivered / result.delivery.expected) * expected;
    tell(0, fromLesson(problem, reasonLessons.undelivered, { fanOut: String(expected), reached: reached.toFixed(1).replace('.', ',') }));
  }

  if (storm) {
    const worst = Math.max(...result.ticks.map((t) => t.retries ?? 0));
    tell(storm.tick, fromLesson(problem, reasonLessons.retryStorm, { retries: fmtCount(worst) }));
  }

  const overflowed = new Set<string>();
  for (const e of result.events) {
    if (e.type !== 'queue-overflow' || overflowed.has(e.node)) continue;
    overflowed.add(e.node);
    tell(e.tick, fromLesson(problem, reasonLessons.queueOverflow, { name: name(e.node) }, e.node));
  }

  // Rien n'est perdu, mais un message très en retard est un incident pour celui qui l'attend (M13).
  for (const id of ofBehavior('queue')) {
    const ages = result.ticks.map((t) => t.nodes[id]?.backlogAge ?? 0);
    const oldest = Math.max(0, ...ages);
    if (oldest < QUEUE_AGE_WARNING || overflowed.has(id)) continue;
    tell(ages.indexOf(oldest), fromLesson('warn', reasonLessons.queueAge, { name: name(id), minutes: String(oldest) }, id));
  }

  const { cost, complexity, latency, failureRate } = result.gauges;
  if (cost.value > cost.limit) {
    const finding = fromLesson('bad', reasonLessons.overBudget, { cost: String(Math.round(cost.value)), budget: String(cost.limit) });
    const priciest = bill(arch, catalog)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 2)
      .map((l) => `${name(l.node)} : ${l.cost}`)
      .join(', ');
    finding.remedy += ` Les plus chers : ${priciest}.`;
    tell(Infinity, finding);
  }
  if (complexity.value > complexity.limit) {
    tell(Infinity, fromLesson('bad', reasonLessons.overComplexity, { complexity: String(complexity.value), cap: String(complexity.limit) }));
  }

  // Le bâtiment le plus chargé hors incident : la cause d'une latence trop haute, ou le
  // prochain à céder sur une vague tenue.
  const hottest = Object.keys(result.nodes)
    .filter((id) => behaviorOf(id) !== 'source')
    .map((id) => ({ id, peak: Math.max(0, ...calm.map((t) => t.nodes[id]?.utilization ?? 0)) }))
    .sort((a, b) => b.peak - a.peak)[0];
  // Un service métier appelé en direct (sans file entre eux) : le client attend son travail.
  // Sauf si c'est un incident qui l'a ralenti : la leçon de l'incident le raconte déjà.
  const slowedByIncident = (id: string) => incidents.some((i) => i.effect.type === 'slow-dependency' && i.component === typeOf.get(id));
  const called = arch.links.find(
    (l) => catalog.components[typeOf.get(l.to) ?? '']?.prePlaced && behaviorOf(l.from) !== 'queue' && !slowedByIncident(l.to),
  );
  if (latency.value > latency.limit && called) {
    const def = catalog.components[typeOf.get(called.to)!]!;
    tell(Infinity, fromLesson('bad', reasonLessons.syncCall, { name: name(called.to), metaphor: metaphor(called.to).toLowerCase(), latency: String(def.latencyMs) }, called.to));
  } else if (latency.value > latency.limit && failureRate.value <= failureRate.limit && hottest) {
    tell(Infinity, fromLesson('bad', reasonLessons.slow, { name: name(hottest.id), load: pct(hottest.peak) }, hottest.id));
  } else if (won && hottest && hottest.peak > HOT && !saturated.some((s) => s.id === hottest.id)) {
    tell(Infinity, {
      tone: 'warn',
      says: line('hot', { name: metaphor(hottest.id) }),
      tech: `${name(hottest.id)} a tourné jusqu’à ${pct(hottest.peak)} de sa capacité : peu de marge.`,
      node: hottest.id,
    });
  }

  const out = [won ? openingWon() : openingLost(), ...story.sort((a, b) => a.tick - b.tick).map((s) => s.finding)];

  // Ce qu'ont coûté les parades en place : une protection a aussi un prix pour le client (D1).
  const costs = [
    ...(ofBehavior('queue').length > 0 ? [paradeCosts.queue] : []),
    ...(Object.keys(paradeCosts) as (keyof typeof paradeCosts)[])
      .filter((k) => {
        if (k === 'queue') return false;
        if (k === 'rateLimit') return singleLimit;
        if (k === 'classLimits') return classLimits;
        return anyHas(k);
      })
      .map((k) => paradeCosts[k]),
  ].filter((c): c is string => !!c);
  if (costs.length > 0) out.push({ tone: 'tip', says: line('paradeCosts'), tech: costs.join(' '), concept: 'Compromis des parades' });

  const sizing = sizingOf();
  if (sizing) out.push(sizing);

  // Ce qu'on pourrait alléger : seulement si la vague a tenu, ou si le trésor ou la
  // complexité débordent (c'est alors la première chose à retirer).
  const overspent = cost.value > cost.limit || complexity.value > complexity.limit;
  // Ce qui coûte l'étoile « juste ce qu'il faut » (E7) : un bâtiment ou un cran d'évolution en trop.
  const superfluous = won || overspent ? superfluousOf(arch, wave, catalog) : [];
  const said = (sp: Spare, label: (id: string) => string) => (sp.upgrade ? `${catalog.upgrades[sp.upgrade]?.techName ?? sp.upgrade} de ${label(sp.node)}` : label(sp.node));
  // Ce dont la vague se passait entièrement : un bâtiment, ou une évolution coupée.
  const removable = superfluous.filter((sp) => !sp.level);
  if (removable.length > 0) {
    const plural = removable.length > 1;
    out.push({
      tone: 'tip',
      says: line(plural ? 'superfluousMany' : 'superfluous', { names: removable.map((sp) => said(sp, metaphor)).join(', ') }),
      tech: `${removable.map((sp) => said(sp, name)).join(', ')} : la vague rejouée sans ${plural ? 'eux' : 'lui'} respecte toujours le SLA. Chaque composant d’un système doit répondre à un besoin précis.`,
      remedy: 'Le retirer pour l’étoile « rien de superflu », ou le garder en connaissance de cause pour une vague à venir.',
      concept: 'Over-engineering',
    });
  }
  // Ce qui était surdimensionné d'un cran : le niveau qui suffisait est dit.
  const lowered = superfluous.filter((sp) => sp.level);
  if (lowered.length > 0) {
    out.push({
      tone: 'tip',
      says: line('superfluousLevel', { names: lowered.map((sp) => said(sp, metaphor)).join(', ') }),
      tech: `${lowered.map((sp) => `${said(sp, name)} : ${sp.level} suffit`).join(' ; ')}. La vague rejouée ainsi respecte toujours le SLA : dimensionner au plus juste, c'est le calcul de capacité.`,
      remedy: 'Baisser d’un cran pour l’étoile « rien de superflu ».',
      concept: 'Calcul de capacité',
    });
  }
  return out;

  function openingWon(): Finding {
    const worked = contributions();
    return {
      tone: 'good',
      says: line('won', { story: worked.length > 0 ? worked.map((w) => w.says).join(' ') : line('wonQuiet', { title: wave.title }) }),
      ...(worked.length > 0 ? { tech: worked.map((w) => w.tech).join(' ') } : {}),
    };
  }

  function openingLost(): Finding {
    return { tone: 'bad', says: line('lost'), tech: `${result.lossReasons.join('. ')}.` };
  }

  /** Ce que chaque bâtiment a apporté, chiffré : ce qui a fait tenir la vague. */
  function contributions(): { says: string; tech: string }[] {
    const worked: { says: string; tech: string }[] = [];
    const reads = sum(ofBehavior('source').map((s) => flow(result.ticks, 'read', 'from', s)));

    for (const id of ofBehavior('edge')) {
      const served = flow(result.ticks, 'read', 'to', id) - flow(result.ticks, 'read', 'from', id);
      if (reads > 0 && served > 0) {
        worked.push({
          says: line('edge', { name: metaphor(id), share: String(Math.round((served / reads) * 100)) }),
          tech: `Le CDN a servi ${pct(served / reads)} des lectures en bordure : le serveur ne les a jamais vues.`,
        });
      }
    }
    for (const id of ofBehavior('cache')) {
      const hits = flow(result.ticks, 'read', 'to', id);
      if (reads > 0 && hits > 0) {
        worked.push({
          says: line('cache', { name: metaphor(id), share: String(Math.round((hits / reads) * 100)) }),
          tech: `Le cache a servi ${pct(hits / reads)} des lectures ; la base n’a vu que le reste.`,
        });
      }
    }
    for (const id of ofBehavior('service')) {
      const peak = Math.max(0, ...result.ticks.map((t) => t.nodes[id]?.instances ?? 1));
      if (peak <= 1) continue;
      // Un consommateur de file (le worker) ne reçoit que des messages : il partage un arriéré, pas une foule.
      const consumer = !catalog.components[typeOf.get(id) ?? '']?.accepts.some((k) => k !== 'async');
      worked.push(
        consumer
          ? { says: line('workers', { count: String(peak) }), tech: `${peak} workers derrière la file : ils se partagent les messages (scaling horizontal).` }
          : { says: line('instances', { count: String(peak) }), tech: `Jusqu’à ${peak} instances du serveur derrière le load balancer : la charge est répartie (scaling horizontal).` },
      );
    }
    for (const n of arch.nodes) {
      const replicas = withEffect(upgradesOf(n), 'readReplicas').reduce((a, u) => a + u.level, 0);
      if (replicas > 0) {
        worked.push({
          says: replicas > 1 ? line('replicas', { count: String(replicas) }) : line('replica'),
          tech: `${replicas} réplica${replicas > 1 ? 's' : ''} en lecture : les lectures se répartissent, le primaire garde les écritures.`,
        });
      }
    }
    if (result.shed > 0 && result.failuresByReason['rate-limited'] === 0) {
      worked.push(
        classLimits
          ? {
              says: line('classLimits'),
              tech: `Les limites par classe de la passerelle d’API ont écarté ${Math.round(result.shed)} requêtes abusives, chaque classe sous son propre palier, et aucune requête légitime.`,
            }
          : {
              says: line('rateLimit'),
              tech: `Le rate limiting a écarté ${Math.round(result.shed)} requêtes abusives du scraper, et aucune requête légitime.`,
            },
      );
    }
    for (const id of ofBehavior('pubsub')) {
      const subscribers = arch.links.filter((l) => l.from === id).length;
      if (flow(result.ticks, 'async', 'to', id) > 0 && subscribers > 0) {
        worked.push({
          says: line('pubsub', { name: metaphor(id), count: String(subscribers) }),
          tech: `Le pub/sub a copié chaque événement à ses ${subscribers} abonnés : chaque service reçoit tout, sans que le serveur les connaisse.`,
        });
      }
    }
    if (anyHas('idempotence') && result.failuresByReason.duplicate === 0) {
      worked.push({
        says: line('idempotence'),
        tech: 'Les consommateurs idempotents écartent les messages déjà traités.',
      });
    }
    if (anyHas('outbox') && result.failuresByReason['lost-event'] === 0) {
      worked.push({
        says: line('outbox'),
        tech: 'L’outbox écrit l’événement dans la même transaction que la commande.',
      });
    }
    // Une phrase pour toutes les files : elles font le même travail.
    const queues = ofBehavior('queue').filter((id) => flow(result.ticks, 'async', 'to', id) > 0);
    if (queues.length > 0) {
      worked.push({
        says: queues.length > 1 ? line('queues', { count: String(queues.length) }) : line('queue', { name: metaphor(queues[0]!) }),
        tech: 'La file sort ce travail du chemin critique : la requête répond tout de suite, un worker traite les messages à son rythme, par lots.',
      });
    }
    return worked;
  }

  /**
   * Un bâtiment est superflu si la vague, rejouée sans lui, respecte encore le SLA. On ne
   * juge pas sur sa charge : un cache peu chargé peut servir 95 % des lectures.
   */
  /**
   * Le calcul de dimensionnement du serveur le plus chargé hors incident, posé avec les
   * chiffres de la vague (D1) : ce qu'il reçoit au plus fort, ce que ça pèse en travail, et le
   * nombre d'instances pour rester sous 70 %. Seulement pour un serveur qui reçoit du trafic
   * direct : derrière une file, les lots rendent le compte trompeur.
   */
  function sizingOf(): Finding | undefined {
    const servers = arch.nodes.filter((n) => {
      const def = catalog.components[n.type];
      const fed = arch.links.filter((l) => l.to === n.id).map((l) => behaviorOf(l.from));
      return def?.behavior === 'service' && !n.fixed && !def.prePlaced && fed.length > 0 && fed.every((b) => b !== 'queue' && b !== 'pubsub');
    });
    const peaks = servers
      .map((n) => {
        const tick = calm.reduce<TickMetrics | undefined>((best, t) => ((t.nodes[n.id]?.utilization ?? 0) > (best?.nodes[n.id]?.utilization ?? -1) ? t : best), undefined);
        return { node: n, tick };
      })
      .filter((p): p is { node: Architecture['nodes'][number]; tick: TickMetrics } => !!p.tick)
      .sort((a, b) => (b.tick.nodes[b.node.id]?.utilization ?? 0) - (a.tick.nodes[a.node.id]?.utilization ?? 0));
    const top = peaks[0];
    if (!top) return undefined;
    const { node, tick } = top;
    const def = catalog.components[node.type]!;
    const into = (kind: RequestKind) =>
      Object.entries(tick.links)
        .filter(([key]) => key.endsWith(`→${node.id}`))
        .reduce((a, [, k]) => a + (k[kind] ?? 0), 0);
    const parts = (['read', 'write', 'async'] as RequestKind[])
      .map((k) => ({ k, rps: into(k), w: def.workPerRequest[k] ?? 0 }))
      .filter((p) => p.rps > 0 && p.w > 0);
    if (parts.length === 0) return undefined;
    const work = parts.reduce((a, p) => a + p.rps * p.w, 0);
    const instances = tick.nodes[node.id]?.instances ?? 1;
    const capacity = def.capacity * instances;
    const needed = Math.ceil(work / (def.capacity * 0.7));
    const terms = parts.map((p) => `${fmtCount(p.rps)} ${KIND_NAMES[p.k]}${p.rps >= 2 && p.k !== 'async' ? 's' : ''}/s × ${p.w}`).join(' + ');
    return {
      tone: 'tip',
      says: line('sizing', { name: metaphor(node.id) }),
      tech: `Au plus fort${incidents.length > 0 ? ' hors incident' : ''} (${tick.tick + 1}ᵉ minute), ${name(node.id)} a reçu ${terms} = ${fmtCount(work)} unités de travail par seconde, pour ${fmtCount(def.capacity)} par instance × ${instances} = ${fmtCount(capacity)} (${pct(work / capacity)}). Pour rester sous 70 % de charge, il faut ⌈${fmtCount(work)} / (${fmtCount(def.capacity)} × 0,7)⌉ = ${needed} instance${needed > 1 ? 's' : ''}.`,
      concept: 'Calcul de capacité',
      node: node.id,
    };
  }
}

/**
 * L'analyse d'une tentative, avec le catalogue et la vague qu'elle a lus. Elle relance une
 * simulation par bâtiment retirable : on la calcule quand la tentative est enregistrée, et
 * on ne la refait que si le calibrage du mode debug a changé l'un ou l'autre depuis.
 */
export interface Analysis {
  catalog: Catalog;
  wave: Wave;
  findings: Finding[];
}

export function analysisOf(
  known: Analysis | undefined,
  attempt: { result: WaveResult; arch: Architecture },
  wave: Wave,
  catalog: Catalog,
  theme: Theme,
): Analysis {
  if (known && known.catalog === catalog && known.wave === wave) return known;
  return { catalog, wave, findings: analyzeWave(attempt.result, attempt.arch, wave, catalog, theme) };
}
