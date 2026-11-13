import type { Scenario } from '../engine/types.ts';
import type { BalanceSpace, Choice } from './canonical.ts';
import type { MassSimReport } from './mass-sim.ts';

const pct = (x: number) => `${Math.round(x * 100)} %`;
// Arrondi fixe : le coût moyen sort sinon avec 15 décimales, et l'instantané
// bougerait au moindre bruit flottant.
const round2 = (x: number) => String(Math.round(x * 100) / 100);

/**
 * Met en forme le rapport d'un scénario, sans l'en-tête (qui porte la durée, seule
 * donnée instable). Fonction pure : l'affichage et l'instantané versionné
 * (`docs/balance-snapshot.txt`) partagent ces lignes, donc le diff ne montre que de
 * vraies différences d'équilibrage. `ko` compte les critères de sortie non tenus.
 */
export function formatScenarioReport(scenario: Scenario, space: BalanceSpace, report: MassSimReport): { lines: string[]; ko: number } {
  // Les niveaux ne s'affichent que pour les dimensions qui en ont plusieurs.
  const graded = space.dimensions.filter((d) => Math.max(...d.levels) > 1);
  const lines: string[] = [];
  let ko = 0;
  const levelsOf = (c: Choice) =>
    graded.filter((d) => (c[d.id] ?? 0) > 0).map((d) => `${typeof d.label === 'string' ? d.label : d.id} ${c[d.id]}`).join(', ');

  for (const w of report.waves) {
    const flag = w.meetsStrategyCriterion ? 'ok' : 'KO';
    if (!w.meetsStrategyCriterion) ko++;
    const single = w.singleStrategy ? ' (réponse unique assumée)' : '';
    lines.push(`[${flag}] ${w.waveId}${single} — ${w.strategies.length} stratégie(s) : ${w.strategies.join(' | ') || 'aucune'}`);
    for (const g of w.groups) {
      const { result: r, choice: c, score } = g.best;
      const levels = levelsOf(c);
      lines.push(
        `     ${g.strategy.padEnd(48)} ${String(g.winners).padStart(4)} gagnantes | meilleure : ${levels || '—'} ` +
          `| score ${score.toFixed(1)} | coût ${round2(r.gauges.cost.value)}/${round2(r.gauges.cost.limit)} ` +
          `| marges coût ${pct(r.gauges.cost.margin)}, cx ${pct(r.gauges.complexity.margin)}, ` +
          `échecs ${pct(r.gauges.failureRate.margin)}, p95 ${pct(r.gauges.latency.margin)}`,
      );
      if (g.dominatedBy) lines.push(`       ↳ dominée par « ${g.dominatedBy} »`);
    }
  }

  lines.push('');
  if (report.universalWinners.length > 0) ko++;
  lines.push(`Architecture gagnant toutes les vagues : ${report.universalWinners.length === 0 ? 'aucune (ok)' : `${report.universalWinners.length} (KO)`}`);
  lines.push(`Deux stratégies sur la majorité des vagues : ${report.majorityHasTwoStrategies ? 'oui' : 'non'}`);
  for (const o of report.overprovisioned) {
    if (!o.losesOnBudget) ko++;
    lines.push(`Tout au maximum, ${o.waveId} : ${o.losesOnBudget ? 'perd (ok)' : 'KO'} — ${o.lossReasons.join(' ; ') || 'gagne'}`);
  }
  return { lines, ko };
}

/** Diff ligne à ligne, sans dépendance : suffisant pour un fichier trié par construction. */
export function diffLines(expected: string[], actual: string[]): string[] {
  const n = expected.length;
  const m = actual.length;
  // Plus longue sous-suite commune, remplie depuis la fin ; `at` évite les `!` partout.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (i: number, j: number) => lcs[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      (lcs[i] as number[])[j] = expected[i] === actual[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && expected[i] === actual[j]) { i++; j++; }
    else if (j < m && (i === n || at(i, j + 1) >= at(i + 1, j))) out.push(`+ ${actual[j++]}`);
    else out.push(`- ${expected[i++]}`);
  }
  return out;
}
