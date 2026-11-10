import { incidentLessons, reasonLessons, saturationLessons, type Lesson } from '../data/lessons.ts';
import { bill } from '../engine/budget.ts';
import { simulateWave } from '../engine/simulate.ts';
import type { Architecture, Catalog, RequestKind, TickMetrics, Wave, WaveResult } from '../engine/types.ts';
import { nodeNames, type Theme } from '../render/theme.ts';
import { removeNode } from './editor.ts';

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
  node?: string;
}

const KIND_NAMES: Record<RequestKind, string> = { read: 'lecture', write: 'écriture', async: 'async' };

/** Au-delà, un bâtiment est trop près de sa capacité pour encaisser la prochaine affluence. */
const HOT = 0.8;

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
  if (node) f.node = node;
  return f;
}

const pct = (n: number) => `${Math.round(n * 100)} %`;
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

  // Incidents : ce qu'ils ont coûté, ou comment la cité les a encaissés.
  for (const incident of incidents) {
    if (storm && incident.from <= storm.tick && incident.effect.type === 'instance-down') continue;
    const failed = Math.round(sum(result.ticks.slice(incident.from, incident.until).map((t) => t.failed)));
    const lesson = incidentLessons[incident.effect.type];
    const vars = { title: incident.title, failed: String(failed) };
    // Le disjoncteur a évité la cascade : ce qui a échoué, ce sont les appels qu'il a coupés.
    const cut = incident.effect.type === 'slow-dependency' && failed > 0 && !result.events.some((e) => e.type === 'threads-exhausted');
    const dependency = arch.nodes.find((n) => n.type === incident.component)?.id;
    if (cut && dependency) {
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
  if (result.failuresByReason.undelivered >= 1 && result.delivery && expected > 0) {
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
      says: `${metaphor(hottest.id)} : presque plein au plus fort de la vague. À la prochaine affluence, c’est là que ça cédera.`,
      tech: `${name(hottest.id)} a tourné jusqu’à ${pct(hottest.peak)} de sa capacité : peu de marge.`,
      node: hottest.id,
    });
  }

  const out = [won ? openingWon() : openingLost(), ...story.sort((a, b) => a.tick - b.tick).map((s) => s.finding)];

  // Ce qu'on pourrait alléger : seulement si la vague a tenu, ou si le trésor ou la
  // complexité débordent (c'est alors la première chose à retirer).
  const overspent = cost.value > cost.limit || complexity.value > complexity.limit;
  const superfluous = won || overspent ? superfluousNodes() : [];
  if (superfluous.length > 0) {
    const plural = superfluous.length > 1;
    out.push({
      tone: 'tip',
      says: `Sans ${superfluous.map(metaphor).join(', ')}, la cité aurait tenu quand même : ${plural ? 'ils coûtent' : 'il coûte'} sans rien apporter cette vague.`,
      tech: `${superfluous.map(name).join(', ')} : la vague rejouée sans ${plural ? 'eux' : 'lui'} respecte toujours le SLA. Chaque composant d’un système doit répondre à un besoin précis.`,
      remedy: 'Le retirer, ou le garder en connaissance de cause pour une vague à venir.',
      concept: 'Over-engineering',
    });
  }
  return out;

  function openingWon(): Finding {
    const worked = contributions();
    return {
      tone: 'good',
      says: `La cité a tenu, Sire. ${worked.length > 0 ? worked.map((w) => w.says).join(' ') : `${wave.title} : défi relevé.`}`,
      ...(worked.length > 0 ? { tech: worked.map((w) => w.tech).join(' ') } : {}),
    };
  }

  function openingLost(): Finding {
    return { tone: 'bad', says: 'La cité est tombée, Sire. Voici ce qui s’est passé.', tech: `${result.lossReasons.join('. ')}.` };
  }

  /** Ce que chaque bâtiment a apporté, chiffré : ce qui a fait tenir la vague. */
  function contributions(): { says: string; tech: string }[] {
    const worked: { says: string; tech: string }[] = [];
    const reads = sum(ofBehavior('source').map((s) => flow(result.ticks, 'read', 'from', s)));

    for (const id of ofBehavior('edge')) {
      const served = flow(result.ticks, 'read', 'to', id) - flow(result.ticks, 'read', 'from', id);
      if (reads > 0 && served > 0) {
        worked.push({
          says: `Votre ${metaphor(id)} a renvoyé ${Math.round((served / reads) * 100)} voyageurs sur 100 sans même les faire entrer en ville.`,
          tech: `Le CDN a servi ${pct(served / reads)} des lectures en bordure : le serveur ne les a jamais vues.`,
        });
      }
    }
    for (const id of ofBehavior('cache')) {
      const hits = flow(result.ticks, 'read', 'to', id);
      if (reads > 0 && hits > 0) {
        worked.push({
          says: `Votre ${metaphor(id)} a fait le travail : ${Math.round((hits / reads) * 100)} voyageurs sur 100 y ont trouvé leur réponse sans déranger les archives.`,
          tech: `Le cache a servi ${pct(hits / reads)} des lectures ; la base n’a vu que le reste.`,
        });
      }
    }
    for (const id of ofBehavior('service')) {
      const peak = Math.max(0, ...result.ticks.map((t) => t.nodes[id]?.instances ?? 1));
      if (peak > 1) {
        worked.push({
          says: `${peak} tours de scribes se sont partagé la foule.`,
          tech: `Jusqu’à ${peak} instances du serveur derrière le load balancer : la charge est répartie (scaling horizontal).`,
        });
      }
    }
    for (const n of arch.nodes) {
      const replicas = n.upgrades?.['read-replica'] ?? 0;
      if (replicas > 0) {
        worked.push({
          says: `${replicas > 1 ? `Les ${replicas} copies des archives ont` : 'La copie des archives a'} répondu aux lectures que les archives seules n’auraient pas tenues.`,
          tech: `${replicas} réplica${replicas > 1 ? 's' : ''} en lecture : les lectures se répartissent, le primaire garde les écritures.`,
        });
      }
    }
    if (result.shed > 0 && result.failuresByReason['rate-limited'] === 0) {
      worked.push({
        says: 'La garde de la porte a refoulé les pillards sans gêner un seul marchand honnête.',
        tech: `Le rate limiting a écarté ${Math.round(result.shed)} requêtes abusives du scraper, et aucune requête légitime.`,
      });
    }
    for (const id of ofBehavior('pubsub')) {
      const subscribers = arch.links.filter((l) => l.from === id).length;
      if (flow(result.ticks, 'async', 'to', id) > 0 && subscribers > 0) {
        worked.push({
          says: `Votre ${metaphor(id)} a annoncé chaque commande à ${subscribers} corps de métier à la fois.`,
          tech: `Le pub/sub a copié chaque événement à ses ${subscribers} abonnés : chaque service reçoit tout, sans que le serveur les connaisse.`,
        });
      }
    }
    if (arch.nodes.some((n) => (n.upgrades?.idempotence ?? 0) > 0) && result.failuresByReason.duplicate === 0) {
      worked.push({
        says: 'Vos ateliers reconnaissent une commande déjà servie : personne n’a été débité deux fois.',
        tech: 'Les consommateurs idempotents écartent les messages déjà traités.',
      });
    }
    if (arch.nodes.some((n) => (n.upgrades?.outbox ?? 0) > 0) && result.failuresByReason['lost-event'] === 0) {
      worked.push({
        says: 'Chaque commande est consignée au grand livre avec son annonce : aucune ne s’est perdue.',
        tech: 'L’outbox écrit l’événement dans la même transaction que la commande.',
      });
    }
    // Une phrase pour toutes les files : elles font le même travail.
    const queues = ofBehavior('queue').filter((id) => flow(result.ticks, 'async', 'to', id) > 0);
    if (queues.length > 0) {
      worked.push({
        says: `${queues.length > 1 ? `Vos ${queues.length} relais de poste ont` : `Votre ${metaphor(queues[0]!)} a`} emporté le travail de fond sans faire attendre personne.`,
        tech: 'La file sort ce travail du chemin critique : la requête répond tout de suite, un worker traite les messages à son rythme, par lots.',
      });
    }
    return worked;
  }

  /**
   * Un bâtiment est superflu si la vague, rejouée sans lui, respecte encore le SLA. On ne
   * juge pas sur sa charge : un cache peu chargé peut servir 95 % des lectures.
   */
  function superfluousNodes(): string[] {
    return arch.nodes
      // La source et les services déjà en place ne se retirent pas.
      .filter((n) => catalog.components[n.type]?.behavior !== 'source' && !n.fixed)
      .filter((n) => {
        const r = simulateWave(removeNode(arch, n.id), wave, catalog);
        const valid = !r.events.some((e) => e.type === 'invalid') && r.failuresByReason['no-route'] === 0;
        return valid && r.gauges.failureRate.margin >= 0 && r.gauges.latency.margin >= 0;
      })
      .map((n) => n.id);
  }
}
