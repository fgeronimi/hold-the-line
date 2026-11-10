import { runMassSim } from '../src/balance/mass-sim.ts';
import { balanceSpaces } from '../src/data/balance-space.ts';
import { catalog } from '../src/data/catalog.ts';
import { scoring } from '../src/data/scoring.ts';

// `npm run balance -- market` : un seul scénario, par son id.
// Pas de @types/node dans le projet : `process` est lu sans son type.
const only = (globalThis as { process?: { argv: string[] } }).process?.argv[2];
const pct = (x: number) => `${Math.round(x * 100)} %`;
let ko = 0;

for (const { scenario, space } of balanceSpaces.filter((b) => !only || b.scenario.id === only)) {
  const started = performance.now();
  const report = runMassSim(scenario, catalog, space, scoring);
  const elapsed = Math.round(performance.now() - started);
  // Les niveaux ne s'affichent que pour les dimensions qui en ont plusieurs.
  const graded = space.dimensions.filter((d) => Math.max(...d.levels) > 1);

  console.log(`\n${scenario.title} — ${report.waves[0]?.candidates ?? 0} architectures × ${report.waves.length} vagues, ${elapsed} ms\n`);

  for (const w of report.waves) {
    const flag = w.meetsStrategyCriterion ? 'ok' : 'KO';
    if (!w.meetsStrategyCriterion) ko++;
    const single = w.singleStrategy ? ' (réponse unique assumée)' : '';
    console.log(`[${flag}] ${w.waveId}${single} — ${w.strategies.length} stratégie(s) : ${w.strategies.join(' | ') || 'aucune'}`);
    for (const g of w.groups) {
      const { result: r, choice: c, score } = g.best;
      const levels = graded.filter((d) => (c[d.id] ?? 0) > 0).map((d) => `${typeof d.label === 'string' ? d.label : d.id} ${c[d.id]}`).join(', ');
      console.log(
        `     ${g.strategy.padEnd(48)} ${String(g.winners).padStart(4)} gagnantes | meilleure : ${levels || '—'} ` +
          `| score ${score.toFixed(1)} | coût ${r.gauges.cost.value}/${r.gauges.cost.limit} ` +
          `| marges coût ${pct(r.gauges.cost.margin)}, cx ${pct(r.gauges.complexity.margin)}, ` +
          `échecs ${pct(r.gauges.failureRate.margin)}, p95 ${pct(r.gauges.latency.margin)}`,
      );
      if (g.dominatedBy) console.log(`       ↳ dominée par « ${g.dominatedBy} »`);
    }
  }

  console.log('');
  if (report.universalWinners.length > 0) ko++;
  console.log(`Architecture gagnant toutes les vagues : ${report.universalWinners.length === 0 ? 'aucune (ok)' : `${report.universalWinners.length} (KO)`}`);
  console.log(`Deux stratégies sur la majorité des vagues : ${report.majorityHasTwoStrategies ? 'oui' : 'non'}`);
  for (const o of report.overprovisioned) {
    if (!o.losesOnBudget) ko++;
    console.log(`Tout au maximum, ${o.waveId} : ${o.losesOnBudget ? 'perd (ok)' : 'KO'} — ${o.lossReasons.join(' ; ') || 'gagne'}`);
  }
}

console.log(`\n${ko === 0 ? 'Aucun KO.' : `${ko} KO.`}`);
