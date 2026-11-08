import type { Catalog, Scenario } from '../engine/types.ts';

export interface Field {
  /** Chemin dans l'objet calibré, séparé par des points. */
  path: string;
  label: string;
  /** Liste de nombres saisie « 10, 20, 40 ». */
  list?: boolean;
}

export interface FieldGroup {
  title: string;
  root: 'catalog' | 'scenario';
  fields: Field[];
}

const COMPONENT_NUMBERS = ['capacity', 'latencyMs', 'cost', 'complexity', 'hitRate', 'batchSize', 'maxBacklog'] as const;

/** Tous les nombres calibrables, décrits depuis les données : rien à maintenir à la main. */
export function calibrationGroups(catalog: Catalog, scenario: Scenario, waveIndex: number): FieldGroup[] {
  const groups: FieldGroup[] = [];

  const wave = scenario.waves[waveIndex];
  if (wave) {
    const w = `waves.${waveIndex}`;
    groups.push({
      title: `Vague ${waveIndex + 1} — ${wave.title}`,
      root: 'scenario',
      fields: [
        { path: `${w}.budget`, label: 'budget' },
        { path: `${w}.complexityCap`, label: 'plafond de complexité' },
        { path: `${w}.sla.maxFailureRate`, label: "taux d'échec max" },
        { path: `${w}.sla.maxP95LatencyMs`, label: 'latence p95 max (ms)' },
        ...wave.sources.flatMap((s, i) =>
          Object.keys(s.rps).map((kind) => ({ path: `${w}.sources.${i}.rps.${kind}`, label: `${s.id} : ${kind} req/s` })),
        ),
        ...wave.sources.map((s, i) => ({ path: `${w}.sources.${i}.clients`, label: `${s.id} : clients` })),
      ],
    });
  }

  for (const def of Object.values(catalog.components)) {
    if (def.behavior === 'source') continue;
    const base = `components.${def.id}`;
    const fields: Field[] = COMPONENT_NUMBERS.filter((k) => def[k] !== undefined).map((k) => ({ path: `${base}.${k}`, label: k }));
    for (const kind of Object.keys(def.workPerRequest)) {
      fields.push({ path: `${base}.workPerRequest.${kind}`, label: `travail / ${kind}` });
    }
    groups.push({ title: `${def.label} (${def.techName})`, root: 'catalog', fields });
  }

  for (const up of Object.values(catalog.upgrades)) {
    const base = `upgrades.${up.id}`;
    const fields: Field[] = [
      { path: `${base}.maxLevel`, label: 'niveau max' },
      { path: `${base}.cost.base`, label: 'coût de base' },
      { path: `${base}.cost.perLevel`, label: 'coût par niveau' },
      { path: `${base}.complexity.base`, label: 'complexité de base' },
      { path: `${base}.complexity.perLevel`, label: 'complexité par niveau' },
    ];
    for (const [k, v] of Object.entries(up.effect)) {
      if (typeof v === 'number') fields.push({ path: `${base}.effect.${k}`, label: k });
      if (Array.isArray(v)) fields.push({ path: `${base}.effect.${k}`, label: k, list: true });
    }
    groups.push({ title: `${up.label} (${up.techName})`, root: 'catalog', fields });
  }

  return groups;
}

/**
 * Réglages qui diffèrent des valeurs du code, au format « chemin = valeur ». Limité aux
 * champs calibrables de la vague donnée : c'est ce qui distingue deux tentatives.
 */
export function changedSettings(
  defaults: { catalog: Catalog; scenario: Scenario },
  current: { catalog: Catalog; scenario: Scenario },
  waveIndex: number,
): string[] {
  const changes: string[] = [];
  for (const g of calibrationGroups(current.catalog, current.scenario, waveIndex)) {
    for (const f of g.fields) {
      const now = formatField(getAt(current[g.root], f.path));
      if (now !== formatField(getAt(defaults[g.root], f.path))) changes.push(`${f.path.replace(/^(components|upgrades)\./, '')} = ${now}`);
    }
  }
  return changes;
}

export function getAt(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, key) => (o as Record<string, unknown> | undefined)?.[key], obj);
}

/** Copie modifiée de `obj`, sans toucher l'original. */
export function setAt<T>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  if (head === undefined) return obj;
  const source = obj as Record<string, unknown>;
  const copy = (Array.isArray(obj) ? [...obj] : { ...source }) as Record<string, unknown>;
  copy[head] = rest.length === 0 ? value : setAt(source[head], rest.join('.'), value);
  return copy as T;
}

export function parseField(raw: string, field: Field): number | number[] | undefined {
  if (field.list) {
    const values = raw.split(',').map((x) => Number(x.trim()));
    return values.length > 0 && values.every(Number.isFinite) ? values : undefined;
  }
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) ? n : undefined;
}

export function formatField(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : String(value ?? '');
}
