import { spaceOf } from '../data/balance-space.ts';
import { incidentLessons, reasonLessons, saturationLessons, type Lesson } from '../data/lessons.ts';
import { hintsLeft, withHint, type GameState } from '../engine/game.ts';
import { linkFlows } from '../engine/routing.ts';
import { simulateWave } from '../engine/simulate.ts';
import type { Architecture, ArchNode, Catalog, RequestKind, Scenario, UpgradeDef, UpgradeEffect, Wave } from '../engine/types.ts';
import { nodeNames, type HintLine, type Theme } from '../render/theme.ts';
import type { TutorialStep } from './tutorial.ts';

/**
 * L'aide (décision I14, qui amende I9) : un indice par essai perdu, le prochain élément qui
 * manque au brouillon pour ressembler à une réponse attendue de la vague. Aucun texte n'est
 * écrit par vague : les réponses sont des données (`Wave.answers`, passées par l'espace
 * d'équilibrage du scénario), et un recalibrage qui en change une change l'aide sans y toucher.
 *
 * Le brouillon du joueur n'a pas les identifiants de la réponse de référence : tout se
 * compare par éléments (composants par type, liens par paire de types, niveaux
 * d'évolution), après un appariement des nœuds décrit à `align`.
 */

/**
 * Une place dans la réponse de référence, sans identifiant : un type, son rang parmi les
 * nœuds du même type quand il y en a plusieurs (le serveur, puis le worker), ou le nom d'un
 * service déjà en place.
 */
export interface Slot {
  type: string;
  /** Rang dans l'ordre du trafic, à partir de 1, quand la réponse a plusieurs nœuds de ce type. */
  nth?: number;
  /** Nom technique d'un service déjà en place (S8) : c'est lui qui le désigne, pas son id. */
  fixed?: string;
}

export type HintKind =
  /** Poser un composant. */
  | 'place'
  /** Relier deux bâtiments. */
  | 'link'
  /** Acheter une évolution, ou en monter le niveau. */
  | 'upgrade'
  /** Démolir un bâtiment que la réponse n'a pas. */
  | 'remove'
  /** Retirer un lien que la réponse n'a pas. */
  | 'unlink'
  /** Baisser ou couper une évolution. */
  | 'lower'
  /** Revenir à une vague précédente (E6) : d'ici, aucune réponse ne tient dans le budget. */
  | 'rewind'
  /** Tout y est, mais un bâtiment validé a été démoli puis reposé : sa démolition se paie. */
  | 'rebuilt';

export type Highlight = NonNullable<TutorialStep['highlight']>;

export interface Hint {
  kind: HintKind;
  /** Identifie l'indice sans identifiant de nœud : c'est elle que garde la partie. */
  key: string;
  /** `place`, `remove`, `rebuilt` : le type du composant. */
  type?: string;
  /** `place` : combien la réponse en compte, celui-ci compris. */
  count?: number;
  /** `link`, `unlink`. */
  from?: Slot;
  to?: Slot;
  /** `upgrade`, `lower` : le bâtiment qui porte l'évolution. */
  node?: Slot;
  upgrade?: string;
  /** `upgrade`, `lower` : le niveau visé. */
  level?: number;
  /** `rewind` : l'index de la vague où revenir. */
  wave?: number;
  /** `link` : ce qui circulera sur le lien dans la réponse visée. */
  carries?: RequestKind[];
  /** Les bâtiments du brouillon concernés, quand ils existent : de quoi appliquer l'indice. */
  target?: { node?: string; from?: string; to?: string };
  /** Le bouton, la pastille ou le bâtiment à faire clignoter. */
  highlight?: Highlight;
}

export interface HintText {
  /** Le chambellan, dans la métaphore. */
  says: string;
  /** La ligne « En vrai » : le nom technique d'abord, la métaphore entre parenthèses, et pourquoi. */
  real: string;
}

export interface HintContext {
  game: GameState;
  scenario: Scenario;
  catalog: Catalog;
  draft: Architecture;
  /** Les réponses attendues d'une vague. Par défaut, `Wave.answers` passées par l'espace du scénario. */
  answers?: (waveIndex: number) => Architecture[];
}

/**
 * - `ready` : le brouillon tient déjà la vague, il n'y a rien à souffler ;
 * - `guide` : les éléments manquants dans l'ordre de pose, puis ce qui est en trop ;
 * - `rewind` : un seul indice, revenir à une vague précédente ;
 * - `stuck` : aucune réponse connue n'est atteignable, même en revenant en arrière.
 */
export interface HintPlan {
  status: 'ready' | 'guide' | 'rewind' | 'stuck';
  hints: Hint[];
}

const EMPTY: Architecture = { nodes: [], links: [] };

const isSource = (n: ArchNode, catalog: Catalog) => catalog.components[n.type]?.behavior === 'source';
/** Ce que le joueur pose ou démolit : ni la source ni un service déjà en place. */
const buildable = (n: ArchNode, catalog: Catalog) => !isSource(n, catalog) && !n.fixed;
const levelOf = (n: ArchNode | undefined, upgradeId: string) => n?.upgrades?.[upgradeId] ?? 0;

/** Les réponses attendues d'une vague, construites par l'espace d'équilibrage du scénario. */
export function answersFor(scenario: Scenario, waveIndex: number): Architecture[] {
  const choices = scenario.waves[waveIndex]?.answers ?? [];
  if (choices.length === 0) return [];
  try {
    const space = spaceOf(scenario.id);
    return choices.map((c) => space.build(c));
  } catch {
    // Un scénario sans espace d'équilibrage n'a pas d'aide.
    return [];
  }
}

// ——— Réduire une architecture à ses éléments ———

/**
 * L'ordre où le trafic traverse l'architecture : tri topologique qui garde l'ordre des
 * nœuds et des liens à égalité, pour que « l'amont avant l'aval » suive la référence.
 */
function trafficOrder(arch: Architecture): string[] {
  const indegree = new Map(arch.nodes.map((n) => [n.id, 0]));
  for (const l of arch.links) if (indegree.has(l.to)) indegree.set(l.to, indegree.get(l.to)! + 1);
  const ready = arch.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const l of arch.links) {
      if (l.from !== id || !indegree.has(l.to)) continue;
      const d = indegree.get(l.to)! - 1;
      indegree.set(l.to, d);
      if (d === 0) ready.push(l.to);
    }
  }
  for (const n of arch.nodes) if (!order.includes(n.id)) order.push(n.id);
  return order;
}

/** La place de chaque nœud de la référence. */
function slotsOf(ref: Architecture, catalog: Catalog): Map<string, Slot> {
  const order = trafficOrder(ref);
  const byId = new Map(ref.nodes.map((n) => [n.id, n]));
  const total = new Map<string, number>();
  for (const n of ref.nodes) if (buildable(n, catalog)) total.set(n.type, (total.get(n.type) ?? 0) + 1);
  const seen = new Map<string, number>();
  const slots = new Map<string, Slot>();
  for (const id of order) {
    const n = byId.get(id)!;
    if (n.fixed) slots.set(id, { type: n.type, fixed: n.fixed.tech });
    else if (!buildable(n, catalog) || (total.get(n.type) ?? 0) < 2) slots.set(id, { type: n.type });
    else {
      const nth = (seen.get(n.type) ?? 0) + 1;
      seen.set(n.type, nth);
      slots.set(id, { type: n.type, nth });
    }
  }
  return slots;
}

const slotKey = (s: Slot) => (s.fixed ? `${s.type}@${s.fixed}` : s.nth ? `${s.type}#${s.nth}` : s.type);

function parseSlot(text: string): Slot {
  const at = text.indexOf('@');
  if (at >= 0) return { type: text.slice(0, at), fixed: text.slice(at + 1) };
  const hash = text.indexOf('#');
  if (hash >= 0) return { type: text.slice(0, hash), nth: Number(text.slice(hash + 1)) };
  return { type: text };
}

/** Le voisinage d'un nœud, par types : ce qui distingue le serveur (derrière la porte) du worker (derrière la file). */
function neighbourhood(arch: Architecture, id: string): string[] {
  const byId = new Map(arch.nodes.map((n) => [n.id, n]));
  const label = (other: string) => {
    const n = byId.get(other);
    return n?.fixed ? `@${n.fixed.tech}` : (n?.type ?? '?');
  };
  return [
    ...arch.links.filter((l) => l.to === id).map((l) => `in:${label(l.from)}`),
    ...arch.links.filter((l) => l.from === id).map((l) => `out:${label(l.to)}`),
  ];
}

function overlap(a: string[], b: string[]): number {
  const left = [...b];
  let n = 0;
  for (const x of a) {
    const i = left.indexOf(x);
    if (i >= 0) {
      n++;
      left.splice(i, 1);
    }
  }
  return n;
}

/**
 * Le meilleur appariement entre deux listes : autant de paires que possible, puis le plus
 * haut score total ; à égalité, l'ordre des listes. Les listes sont courtes (trois files au
 * plus dans une réponse) : on les essaie toutes, sauf au-delà de sept candidats.
 */
function assign<R, C>(rows: R[], cols: C[], score: (r: R, c: C) => number): [R, C][] {
  if (rows.length === 0 || cols.length === 0) return [];
  if (rows.length > cols.length) return assign(cols, rows, (c, r) => score(r, c)).map(([c, r]) => [r, c]);
  if (cols.length > 7) {
    const used = new Set<number>();
    return rows.map((r) => {
      let best = -1;
      cols.forEach((c, j) => {
        if (!used.has(j) && (best < 0 || score(r, c) > score(r, cols[best]!))) best = j;
      });
      used.add(best);
      return [r, cols[best]!];
    });
  }
  let best: number[] = [];
  let bestScore = -Infinity;
  const pick = (i: number, chosen: number[], total: number) => {
    if (i === rows.length) {
      if (total > bestScore) {
        bestScore = total;
        best = [...chosen];
      }
      return;
    }
    cols.forEach((c, j) => {
      if (chosen.includes(j)) return;
      chosen.push(j);
      pick(i + 1, chosen, total + score(rows[i]!, c));
      chosen.pop();
    });
  };
  pick(0, [], 0);
  return rows.map((r, i) => [r, cols[best[i]!]!]);
}

/**
 * Apparie les nœuds de la référence à ceux d'une autre architecture (le brouillon, ou
 * l'architecture validée) : id de la référence → id de l'autre.
 *
 * Règle : la source va à la source, un service déjà en place à celui du même nom. Entre
 * nœuds du même type, on garde les paires qui partagent le plus de voisins, comptés par
 * type et par sens (deux points par voisin commun), puis le plus d'évolutions en commun
 * (un point). Le serveur, relié à la porte et à la base, va donc au serveur ; le worker,
 * derrière la file, au worker.
 *
 * Limites : un bâtiment pas encore relié n'a pas de voisins, il n'est apparié que par ses
 * évolutions, puis par l'ordre de pose ; deux nœuds du même type, aux mêmes voisins et aux
 * mêmes évolutions, sont interchangeables et appariés dans l'ordre.
 */
export function align(ref: Architecture, other: Architecture, catalog: Catalog): Map<string, string> {
  const map = new Map<string, string>();
  const refSource = ref.nodes.find((n) => isSource(n, catalog));
  const otherSource = other.nodes.find((n) => isSource(n, catalog));
  if (refSource && otherSource) map.set(refSource.id, otherSource.id);
  for (const r of ref.nodes) {
    if (!r.fixed) continue;
    const o = other.nodes.find((n) => n.fixed && n.type === r.type && n.fixed.tech === r.fixed!.tech);
    if (o) map.set(r.id, o.id);
  }
  const order = trafficOrder(ref);
  const refByType = new Map<string, ArchNode[]>();
  for (const id of order) {
    const n = ref.nodes.find((x) => x.id === id)!;
    if (buildable(n, catalog)) refByType.set(n.type, [...(refByType.get(n.type) ?? []), n]);
  }
  for (const [type, refs] of refByType) {
    const candidates = other.nodes.filter((n) => n.type === type && buildable(n, catalog));
    const score = (r: ArchNode, o: ArchNode) => {
      const shared = Object.keys(r.upgrades ?? {}).filter((u) => levelOf(r, u) > 0 && levelOf(o, u) > 0).length;
      return 2 * overlap(neighbourhood(ref, r.id), neighbourhood(other, o.id)) + shared;
    };
    for (const [r, o] of assign(refs, candidates, score)) map.set(r.id, o.id);
  }
  return map;
}

const KIND_TEXT: Record<RequestKind, string> = { read: 'les lectures', write: 'les écritures', async: 'les événements' };

/**
 * Ce qui sépare une architecture de la référence : les éléments manquants dans l'ordre de
 * pose (composants dans l'ordre du trafic, puis liens, puis évolutions), et ce qui est en
 * trop (bâtiments, liens, niveaux au-delà de la référence).
 */
export function compare(ref: Architecture, other: Architecture, catalog: Catalog): { missing: Hint[]; extra: Hint[] } {
  const map = align(ref, other, catalog);
  const back = new Map([...map].map(([r, o]) => [o, r]));
  const slots = slotsOf(ref, catalog);
  const slot = (id: string) => slots.get(id)!;
  const order = trafficOrder(ref);
  const rank = (id: string) => order.indexOf(id);
  const refById = new Map(ref.nodes.map((n) => [n.id, n]));
  const otherById = new Map(other.nodes.map((n) => [n.id, n]));
  const linked = (arch: Architecture, from: string, to: string) => arch.links.some((l) => l.from === from && l.to === to);
  const missing: Hint[] = [];
  const extra: Hint[] = [];

  const mappedOfType = new Map<string, number>();
  for (const [r] of map) {
    const n = refById.get(r)!;
    if (buildable(n, catalog)) mappedOfType.set(n.type, (mappedOfType.get(n.type) ?? 0) + 1);
  }
  const placed = new Map<string, number>();
  for (const id of order) {
    const n = refById.get(id)!;
    if (!buildable(n, catalog) || map.has(id)) continue;
    const count = (mappedOfType.get(n.type) ?? 0) + (placed.get(n.type) ?? 0) + 1;
    placed.set(n.type, (placed.get(n.type) ?? 0) + 1);
    missing.push({ kind: 'place', key: `place|${n.type}|${count}`, type: n.type, count, highlight: { tool: 'place', type: n.type } });
  }

  const flows = linkFlows(ref, catalog);
  const refLinks = [...ref.links].sort((a, b) => rank(a.from) - rank(b.from) || rank(a.to) - rank(b.to));
  for (const l of refLinks) {
    const from = map.get(l.from);
    const to = map.get(l.to);
    if (from && to && linked(other, from, to)) continue;
    const carries = flows.get(`${l.from}→${l.to}`) ?? [];
    missing.push({
      kind: 'link',
      key: `link|${slotKey(slot(l.from))}|${slotKey(slot(l.to))}`,
      from: slot(l.from),
      to: slot(l.to),
      ...(carries.length > 0 && { carries }),
      ...(from && to && { target: { from, to } }),
      highlight: { tool: 'link', ...(from && { node: from }) },
    });
  }

  const upgradesOf = (type: string) => Object.values(catalog.upgrades).filter((u) => u.appliesTo === type);
  for (const id of order) {
    const r = refById.get(id)!;
    const o = otherById.get(map.get(id) ?? '');
    for (const up of upgradesOf(r.type)) {
      const level = levelOf(r, up.id);
      if (level <= levelOf(o, up.id)) continue;
      missing.push({
        kind: 'upgrade',
        key: `upgrade|${slotKey(slot(id))}|${up.id}|${level}`,
        node: slot(id),
        upgrade: up.id,
        level,
        ...(o && { target: { node: o.id }, highlight: { node: o.id, upgrade: up.id } }),
      });
    }
  }

  const removed = new Map<string, number>();
  for (const o of other.nodes) {
    if (!buildable(o, catalog) || back.has(o.id)) continue;
    const k = (removed.get(o.type) ?? 0) + 1;
    removed.set(o.type, k);
    extra.push({ kind: 'remove', key: `remove|${o.type}|${k}`, type: o.type, target: { node: o.id }, highlight: { tool: 'remove', node: o.id } });
  }
  for (const l of other.links) {
    const from = back.get(l.from);
    const to = back.get(l.to);
    // Un lien vers un bâtiment en trop part avec lui.
    if (!from || !to || linked(ref, from, to)) continue;
    extra.push({
      kind: 'unlink',
      key: `unlink|${slotKey(slot(from))}|${slotKey(slot(to))}`,
      from: slot(from),
      to: slot(to),
      target: { from: l.from, to: l.to },
      highlight: { node: l.from, link: { from: l.from, to: l.to } },
    });
  }
  for (const id of order) {
    const r = refById.get(id)!;
    const o = otherById.get(map.get(id) ?? '');
    if (!o) continue;
    for (const up of upgradesOf(r.type)) {
      const level = levelOf(r, up.id);
      if (levelOf(o, up.id) <= level) continue;
      extra.push({
        kind: 'lower',
        key: `lower|${slotKey(slot(id))}|${up.id}|${level}`,
        node: slot(id),
        upgrade: up.id,
        level,
        target: { node: o.id },
        highlight: { node: o.id, upgrade: up.id },
      });
    }
  }
  return { missing, extra };
}

// ——— Ce que la partie peut encore atteindre ———

/**
 * La référence jouée depuis `start` : ses nœuds prennent les identifiants de ceux qu'ils
 * apparient, les autres sont neufs. `migrationCost` compare par identifiant ; une fois
 * renommée, la référence garde ce qui est déjà bâti et ne paie que ce qu'elle démolit.
 */
export function realize(ref: Architecture, start: Architecture, catalog: Catalog): Architecture {
  const map = align(ref, start, catalog);
  const taken = new Set(start.nodes.map((n) => n.id));
  const rename = new Map<string, string>();
  for (const n of ref.nodes) {
    // Un nœud sans pendant garde son id s'il est libre : les services déjà en place sont
    // nommés par id dans la vague (`consumers`), et ne doivent pas changer de nom.
    let id = map.get(n.id) ?? (taken.has(n.id) ? undefined : n.id);
    if (!id) {
      id = `${n.type}-neuf`;
      for (let i = 2; taken.has(id); i++) id = `${n.type}-neuf-${i}`;
    }
    taken.add(id);
    rename.set(n.id, id);
  }
  return {
    nodes: ref.nodes.map((n) => ({ ...n, id: rename.get(n.id)! })),
    links: ref.links.map((l) => ({ from: rename.get(l.from)!, to: rename.get(l.to)! })),
  };
}

/** Une architecture réduite à ce que la simulation lit, pour servir de clé. */
function fingerprint(arch: Architecture): string {
  const upgrades = (n: ArchNode) =>
    Object.entries(n.upgrades ?? {})
      .filter(([, v]) => v > 0)
      .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    [...arch.nodes].map((n) => [n.id, n.type, upgrades(n), n.fixed?.tech ?? '']).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    arch.links.map((l) => `${l.from}→${l.to}`).sort(),
  ]);
}

/** Les mêmes simulations reviennent à chaque rendu : on les garde, par catalogue et par vague. */
const reachMemo = new WeakMap<Catalog, WeakMap<Wave, Map<string, boolean>>>();

/** La réponse, jouée depuis `start`, tient-elle la vague ? Elle perd si démolir ce qui est bâti la fait sortir du budget. */
function reachable(ref: Architecture, start: Architecture, wave: Wave, catalog: Catalog): boolean {
  let byWave = reachMemo.get(catalog);
  if (!byWave) reachMemo.set(catalog, (byWave = new WeakMap()));
  let memo = byWave.get(wave);
  if (!memo) byWave.set(wave, (memo = new Map()));
  const key = `${fingerprint(ref)}|${fingerprint(start)}`;
  let won = memo.get(key);
  if (won === undefined) {
    won = simulateWave(realize(ref, start, catalog), wave, catalog, start).won;
    memo.set(key, won);
  }
  return won;
}

/**
 * La plus récente vague où revenir (E6) : celle dont l'architecture validée permet encore,
 * réponse après réponse, d'atteindre une réponse de la vague en cours.
 */
function rewindTarget(ctx: HintContext, answers: (i: number) => Architecture[]): number | undefined {
  const { game, scenario, catalog } = ctx;
  const chain = (j: number, start: Architecture): boolean => {
    const wave = scenario.waves[j];
    if (!wave) return false;
    const ok = answers(j).filter((a) => reachable(a, start, wave, catalog));
    if (j === game.waveIndex) return ok.length > 0;
    return ok.some((a) => chain(j + 1, realize(a, start, catalog)));
  };
  for (let i = game.waveIndex - 1; i >= 0; i--) if (chain(i, game.history[i] ?? EMPTY)) return i;
  return undefined;
}

/**
 * Les indices à donner, dans l'ordre. Le brouillon qui tient déjà la vague n'en reçoit
 * aucun, même s'il ne ressemble à aucune réponse : l'aide ne ramène pas un joueur qui a
 * trouvé sa propre parade vers celle de référence.
 */
export function planHints(ctx: HintContext): HintPlan {
  const { game, scenario, catalog, draft } = ctx;
  const wave = scenario.waves[game.waveIndex];
  if (game.finished || !wave) return { status: 'stuck', hints: [] };
  if (simulateWave(draft, wave, catalog, game.committed).won) return { status: 'ready', hints: [] };
  const answers = ctx.answers ?? ((i: number) => answersFor(scenario, i));
  const all = answers(game.waveIndex);
  if (all.length === 0) return { status: 'stuck', hints: [] };
  const reach = all.filter((a) => reachable(a, game.committed, wave, catalog));
  if (reach.length === 0) {
    const back = rewindTarget(ctx, answers);
    if (back === undefined) return { status: 'stuck', hints: [] };
    return { status: 'rewind', hints: [{ kind: 'rewind', key: `rewind|${back}`, wave: back }] };
  }
  // La plus proche : le moins d'éléments manquants, puis le moins à retirer.
  let best: { missing: Hint[]; extra: Hint[] } | undefined;
  for (const a of reach) {
    const d = compare(a, draft, catalog);
    if (!best || d.missing.length < best.missing.length || (d.missing.length === best.missing.length && d.extra.length < best.extra.length)) best = d;
  }
  const hints = [...best!.missing, ...best!.extra];
  if (hints.length > 0) return { status: 'guide', hints };
  // Mêmes éléments que la réponse, qui tiendrait, et pourtant la vague est perdue : seule la
  // facture diffère, par un bâtiment validé démoli puis reposé sous un autre identifiant.
  const rebuilt = game.committed.nodes.find((n) => buildable(n, catalog) && !draft.nodes.some((d) => d.id === n.id));
  const type = rebuilt?.type ?? '';
  return { status: 'guide', hints: [{ kind: 'rebuilt', key: `rebuilt|${type}`, ...(rebuilt && { type }) }] };
}

/** Le premier indice qui n'a pas encore été donné. */
export function nextHint(plan: HintPlan, given: readonly string[]): Hint | undefined {
  return plan.hints.find((h) => !given.includes(h.key));
}

/** Retrouve un indice déjà donné par sa clé, quand il n'est plus à faire (il n'a alors plus de cible). */
export function decodeHint(key: string): Hint {
  const [kind, a = '', b = '', c = '', d = ''] = key.split('|');
  switch (kind as HintKind) {
    case 'place':
      return { kind: 'place', key, type: a, count: Number(b) };
    case 'remove':
      return { kind: 'remove', key, type: a };
    case 'link':
    case 'unlink':
      return { kind: kind as HintKind, key, from: parseSlot(a), to: parseSlot(b) };
    case 'upgrade':
    case 'lower':
      return { kind: kind as HintKind, key, node: parseSlot(a), upgrade: b, level: Number(c || d || 0) };
    case 'rewind':
      return { kind: 'rewind', key, wave: Number(a) };
    default:
      return { kind: 'rebuilt', key, ...(a && { type: a }) };
  }
}

// ——— Le bouton « Un indice » ———

export interface HintPanel {
  /** Les indices déjà donnés sur la vague, dans l'ordre ; `done` quand le brouillon les a satisfaits. */
  given: { hint: Hint; text: HintText; done: boolean }[];
  /** Le bouton : actif, ou grisé avec la raison. */
  button: { enabled: boolean; why?: string };
  /** Indices qu'on peut encore demander sur cette vague. */
  left: number;
  /** Ce qui clignote : l'élément du dernier indice donné, tant qu'il reste à faire. */
  highlight?: Highlight;
}

let lastPanel: { ctx: HintContext; theme: Theme; panel: HintPanel } | undefined;

/**
 * L'état de l'aide pour l'interface. Recalculé seulement si la partie, le brouillon, le
 * scénario ou le catalogue ont changé : la barre d'outils, le debrief et les pastilles le
 * demandent au même rendu.
 */
export function hintPanel(ctx: HintContext, theme: Theme): HintPanel {
  const last = lastPanel;
  if (last && last.theme === theme && last.ctx.game === ctx.game && last.ctx.draft === ctx.draft && last.ctx.scenario === ctx.scenario && last.ctx.catalog === ctx.catalog && last.ctx.answers === ctx.answers) {
    return last.panel;
  }
  const panel = computePanel(ctx, theme);
  lastPanel = { ctx, theme, panel };
  return panel;
}

function computePanel(ctx: HintContext, theme: Theme): HintPanel {
  const { game } = ctx;
  const keys = game.hints ?? [];
  const left = hintsLeft(game);
  if (game.finished) return { given: [], button: { enabled: false, why: 'La partie est terminée.' }, left: 0 };
  // Sans droit ni indice donné, inutile de simuler quoi que ce soit.
  if (left === 0 && keys.length === 0) return { given: [], button: { enabled: false, why: 'Disponible après un essai perdu.' }, left };
  const plan = planHints(ctx);
  const given = keys.map((key) => {
    const pending = plan.hints.find((h) => h.key === key);
    const hint = pending ?? decodeHint(key);
    return { hint, text: hintText(hint, ctx.catalog, theme, ctx.draft), done: !pending };
  });
  const lastGiven = keys.length > 0 ? plan.hints.find((h) => h.key === keys.at(-1)) : undefined;
  const next = nextHint(plan, keys);
  const why =
    game.replays === 0
      ? 'Disponible après un essai perdu.'
      : left === 0
        ? 'Un indice de plus après le prochain essai perdu.'
        : plan.status === 'ready'
          ? 'Rien à indiquer : tout y est, lancez la vague.'
          : !next
            ? plan.status === 'stuck'
              ? 'Plus rien à indiquer : aucune réponse connue n’est atteignable.'
              : 'Plus rien à indiquer : tous les indices sont donnés.'
            : undefined;
  return {
    given,
    button: why ? { enabled: false, why } : { enabled: true },
    left,
    ...(lastGiven?.highlight && { highlight: lastGiven.highlight }),
  };
}

/** Demander un indice : la partie le garde, si le joueur y a droit et qu'il y a quelque chose à dire. */
export function askHint(ctx: HintContext): GameState {
  if (hintsLeft(ctx.game) <= 0) return ctx.game;
  const next = nextHint(planHints(ctx), ctx.game.hints ?? []);
  return next ? withHint(ctx.game, next.key) : ctx.game;
}

// ——— Le texte, en double narration (I6) ———

/**
 * Pourquoi une évolution : la leçon déjà écrite pour le problème qu'elle règle, par effet.
 * Une évolution d'un effet nouveau, sans leçon, retombe sur son libellé du catalogue.
 */
const UPGRADE_LESSONS: Partial<Record<UpgradeEffect['type'], Lesson | undefined>> = {
  instances: saturationLessons['app-server'],
  autoscaling: incidentLessons['instance-down'].hurt,
  readReplicas: saturationLessons.database,
  rateLimit: reasonLessons.legitLimited,
  idempotence: reasonLessons.duplicate,
  outbox: reasonLessons.lostEvent,
  circuitBreaker: incidentLessons['slow-dependency'].hurt,
  coalescing: incidentLessons['cache-stampede'].hurt,
  backoff: reasonLessons.retryStorm,
  retention: reasonLessons.queueOverflow,
  leaderReads: reasonLessons.staleRead,
};

/** La parade de la leçon, ou son explication, tant qu'elle ne réclame pas de chiffres de la vague. */
function lessonWhy(lesson: Lesson | undefined): string | undefined {
  return [lesson?.remedy, lesson?.tech].find((t): t is string => !!t && !t.includes('{'));
}

const fill = (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const joinKinds = (kinds: RequestKind[]) => {
  const words = kinds.map((k) => KIND_TEXT[k]);
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} et ${words.at(-1)}` : (words[0] ?? '');
};

/** Le niveau visé d'une évolution, dans son unité : instances, réplicas, palier en req/s… */
export function levelText(up: UpgradeDef, level: number): string {
  const e = up.effect;
  switch (e.type) {
    case 'instances':
      return plural(level, 'instance en plus', 'instances en plus');
    case 'autoscaling':
      return `jusqu’à ${plural(level, 'instance', 'instances')} à la demande`;
    case 'readReplicas':
      return plural(level, 'réplica', 'réplicas');
    case 'rateLimit':
      return `palier ${e.tiersPerClientRps[level - 1] ?? '?'} req/s par client`;
    case 'retention':
      return `${plural(level, 'niveau', 'niveaux')}, ${e.perLevel * level} messages de plus`;
    default:
      return up.maxLevel > 1 ? `niveau ${level}` : '';
  }
}

function names(slot: Slot, catalog: Catalog, theme: Theme, arch: Architecture): { tech: string; metaphor: string } {
  if (slot.fixed) {
    const node = arch.nodes.find((n) => n.fixed?.tech === slot.fixed);
    return node ? nodeNames(node, catalog, theme) : { tech: slot.fixed, metaphor: '' };
  }
  const def = catalog.components[slot.type];
  const tech = def?.techName ?? def?.label ?? 'Composant';
  // Le rang ne sert qu'à distinguer deux bâtiments du même type : le serveur et le worker.
  return { tech: slot.nth && slot.nth > 1 ? `${tech} n° ${slot.nth}` : tech, metaphor: theme.buildings[slot.type]?.metaphor ?? '' };
}

const both = (n: { tech: string; metaphor: string }) => (n.metaphor ? `${n.tech} (${n.metaphor})` : n.tech);
const said = (n: { tech: string; metaphor: string }) => n.metaphor || n.tech;

/** La réplique du chambellan et la ligne « En vrai » d'un indice. */
export function hintText(hint: Hint, catalog: Catalog, theme: Theme, arch: Architecture): HintText {
  const line = (l: HintLine, vars: Record<string, string>) => fill(theme.hints[l], vars);
  const slotOf = (type: string): Slot => ({ type });
  const up = hint.upgrade ? catalog.upgrades[hint.upgrade] : undefined;
  switch (hint.kind) {
    case 'place': {
      const n = names(slotOf(hint.type ?? ''), catalog, theme, arch);
      const role = theme.buildings[hint.type ?? '']?.role.real ?? `${catalog.components[hint.type ?? '']?.label ?? 'Ce composant'} : il manque à la réponse.`;
      const more = (hint.count ?? 1) > 1;
      return {
        says: line(more ? 'placeMore' : 'place', { name: said(n) }),
        real: more
          ? `Posez un bâtiment de plus : ${both(n)}, il en faut ${hint.count} dans cette architecture. ${role}`
          : `Posez un bâtiment : ${both(n)}. ${role}`,
      };
    }
    case 'link': {
      const from = names(hint.from!, catalog, theme, arch);
      const to = names(hint.to!, catalog, theme, arch);
      const why = hint.carries?.length
        ? `Y passeront ${joinKinds(hint.carries)} : sans ce lien, elles n’ont pas de route.`
        : 'Sans ce lien, le trafic n’a pas de route de l’un à l’autre.';
      return {
        says: line('link', { from: said(from), to: said(to) }),
        real: `Reliez ${both(from)} → ${both(to)} : outil Relier, cliquer le départ puis l’arrivée. ${why}`,
      };
    }
    case 'upgrade': {
      const n = names(hint.node!, catalog, theme, arch);
      if (!up) return { says: line('upgrade', { name: said(n), upgrade: '' }), real: `Une évolution manque sur ${both(n)}.` };
      const level = up.maxLevel > 1 ? levelText(up, hint.level ?? 1) : '';
      const why = lessonWhy(UPGRADE_LESSONS[up.effect.type]) ?? `${up.label}.`;
      const where = `Sélectionnez le bâtiment : la pastille ${theme.upgradeIcons[up.id] ?? '✦'} est à son pied.`;
      return {
        says: line(level ? 'level' : 'upgrade', { name: said(n), upgrade: lowerFirst(up.label), level }),
        real: level
          ? `Réglez ${up.techName} sur ${both(n)} : ${level}. ${where} ${why}`
          : `Activez ${up.techName} sur ${both(n)}. ${where} ${why}`,
      };
    }
    case 'remove': {
      const def = catalog.components[hint.type ?? ''];
      const n = names(slotOf(hint.type ?? ''), catalog, theme, arch);
      return {
        says: line('remove', { name: said(n) }),
        real: `Retirez ${both(n)} (outil Retirer) : la réponse visée s’en passe, et ce bâtiment coûte ${def?.cost ?? 0} et ${def?.complexity ?? 0} de complexité à chaque vague.`,
      };
    }
    case 'unlink': {
      const from = names(hint.from!, catalog, theme, arch);
      const to = names(hint.to!, catalog, theme, arch);
      return {
        says: line('unlink', { from: said(from), to: said(to) }),
        real: `Retirez le lien ${both(from)} → ${both(to)}, depuis la fiche du bâtiment de départ : le trafic qui l’emprunte contourne la réponse visée.`,
      };
    }
    case 'lower': {
      const n = names(hint.node!, catalog, theme, arch);
      if (!up) return { says: line('lower', { name: said(n), upgrade: '' }), real: `Une évolution est de trop sur ${both(n)}.` };
      const level = hint.level ?? 0;
      const why =
        up.effect.type === 'rateLimit'
          ? (lessonWhy(UPGRADE_LESSONS.rateLimit) ?? `${up.label}.`)
          : 'Au-delà, elle pèse sur le budget et la complexité sans rien apporter à cette vague.';
      return {
        says: line('lower', { name: said(n), upgrade: lowerFirst(up.label) }),
        real:
          level === 0
            ? `Désactivez ${up.techName} sur ${both(n)} : la réponse visée s’en passe. ${why}`
            : `Ramenez ${up.techName} sur ${both(n)} à ${levelText(up, level)}. ${why}`,
      };
    }
    case 'rewind': {
      const wave = String((hint.wave ?? 0) + 1);
      return {
        says: line('rewind', { wave }),
        real: `Depuis l’architecture validée, aucune réponse ne tient dans le budget : démolir ce qui a été validé coûte sa valeur d’achat (migration). Menu ☰, « Revenir à la vague ${wave} » : ça compte comme un rejeu.`,
      };
    }
    case 'rebuilt': {
      const n = hint.type ? names(slotOf(hint.type), catalog, theme, arch) : { tech: 'un bâtiment', metaphor: '' };
      return {
        says: line('rebuilt', { name: said(n) }),
        real: `Rien ne manque, mais ${both(n)}, validé à la vague précédente, a été démoli puis reposé : son retrait entre dans la facture (migration). Annulez (⌘Z) jusqu’à retrouver le bâtiment d’origine.`,
      };
    }
  }
}
