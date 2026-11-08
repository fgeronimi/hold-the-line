import { reasonLessons, saturationLessons, type Lesson } from '../data/lessons.ts';
import { bill } from '../engine/budget.ts';
import type { Architecture, Catalog, RequestKind, Wave, WaveResult } from '../engine/types.ts';
import type { Theme } from '../render/theme.ts';

/** Un constat du chambellan après une vague. */
export interface Finding {
  tone: 'bad' | 'good' | 'tip';
  /** Dit dans la métaphore. */
  says: string;
  /** L'explication d'entretien. */
  tech?: string;
  remedy?: string;
  concept?: string;
  node?: string;
}

const KIND_NAMES: Record<RequestKind, string> = { read: 'lecture', write: 'écriture', async: 'async' };

/** Au-dessous de ce pic de charge, un bâtiment ne sert presque à rien cette vague. */
const IDLE = 0.3;
/** Au-delà, il est trop près de sa capacité pour que la latence reste basse. */
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

/**
 * Pourquoi la vague a tenu ou cassé, du plus grave au moins grave : ce que le chambellan
 * dit, l'explication d'entretien, et la parade. Pur : se teste sans interface.
 */
export function analyzeWave(result: WaveResult, arch: Architecture, wave: Wave, catalog: Catalog, theme: Theme): Finding[] {
  const typeOf = new Map(arch.nodes.map((n) => [n.id, n.type]));
  const name = (id: string) => {
    const type = typeOf.get(id) ?? '';
    return `${theme.buildings[type]?.metaphor ?? id} (${catalog.components[type]?.techName ?? type})`;
  };
  const out: Finding[] = [];

  // Requêtes sans route : un lien manque.
  const noRoute = new Map<string, Set<RequestKind>>();
  for (const e of result.events) {
    if (e.type === 'no-route') noRoute.set(e.node, (noRoute.get(e.node) ?? new Set()).add(e.kind));
  }
  for (const [node, kinds] of noRoute) {
    const kind = [...kinds].map((k) => KIND_NAMES[k]).join(', ');
    out.push(fromLesson('bad', reasonLessons.noRoute, { name: name(node), kind }, node));
  }

  // Goulots : les bâtiments saturés, du plus d'échecs au moins.
  const saturated = Object.entries(result.nodes)
    .filter(([id, n]) => n.peakUtilization > 1 && !noRoute.has(id))
    .sort(([, a], [, b]) => b.failed - a.failed || b.peakUtilization - a.peakUtilization);
  for (const [id] of saturated.slice(0, 2)) {
    const lesson = saturationLessons[typeOf.get(id) ?? ''];
    if (lesson) out.push(fromLesson('bad', lesson, { name: theme.buildings[typeOf.get(id)!]?.metaphor ?? id }, id));
  }

  if (result.failuresByReason['rate-limited'] > 0) out.push(fromLesson('bad', reasonLessons.legitLimited, {}));
  if (result.failuresByReason['lost-at-edge'] > 0) out.push(fromLesson('bad', reasonLessons.lostAtEdge, {}));
  for (const e of result.events) {
    if (e.type === 'queue-overflow' && !out.some((f) => f.node === e.node && f.concept === 'Backpressure')) {
      out.push(fromLesson('bad', reasonLessons.queueOverflow, { name: name(e.node) }, e.node));
    }
  }

  const idle = Object.entries(result.nodes)
    .filter(([id, n]) => n.peakUtilization < IDLE && catalog.components[typeOf.get(id) ?? '']?.behavior !== 'source')
    .map(([id]) => id);

  const { cost, complexity, latency, failureRate } = result.gauges;
  if (cost.value > cost.limit) {
    const finding = fromLesson('bad', reasonLessons.overBudget, { cost: String(Math.round(cost.value)), budget: String(cost.limit) });
    const priciest = bill(arch, catalog)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 2)
      .map((l) => `${name(l.node)} : ${l.cost}`)
      .join(', ');
    finding.remedy += ` Les plus chers : ${priciest}.${idle.length > 0 ? ` Peu utilisés : ${idle.map(name).join(', ')}.` : ''}`;
    out.push(finding);
  }
  if (complexity.value > complexity.limit) {
    out.push(fromLesson('bad', reasonLessons.overComplexity, { complexity: String(complexity.value), cap: String(complexity.limit) }));
  }

  const hottest = Object.entries(result.nodes).sort(([, a], [, b]) => b.peakUtilization - a.peakUtilization)[0];
  if (latency.value > latency.limit && failureRate.value <= failureRate.limit && hottest) {
    out.push(fromLesson('bad', reasonLessons.slow, { name: name(hottest[0]), load: pct(hottest[1].peakUtilization) }, hottest[0]));
  }

  if (result.won) {
    out.unshift({
      tone: 'good',
      says: `La cité a tenu, Sire. ${wave.title} : défi relevé.`,
      ...(hottest
        ? {
            tech: `Le goulot le plus proche : ${name(hottest[0])}, à ${pct(hottest[1].peakUtilization)} de charge au pic.${hottest[1].peakUtilization > HOT ? ' Peu de marge : la prochaine relance le fera céder.' : ''}`,
            node: hottest[0],
          }
        : {}),
    });
    if (result.shed > 0) {
      out.push({ tone: 'good', says: `La garde a repoussé ${Math.round(result.shed)} pillards.`, concept: 'Rate Limiting' });
    }
  }
  // Un bâtiment à vide est le premier à retirer : utile après une victoire comme quand le
  // trésor ou la complexité débordent.
  const overspent = cost.value > cost.limit || complexity.value > complexity.limit;
  if (idle.length > 0 && (result.won || overspent)) {
    out.push({
      tone: 'tip',
      says: `Certains bâtiments ont peu servi : ${idle.map(name).join(', ')}.`,
      tech: 'Un composant qui tourne à vide coûte et complexifie sans rien apporter cette vague. En entretien : justifier chaque composant par un besoin précis.',
    });
  }
  return out;
}
