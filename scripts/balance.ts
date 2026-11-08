import { runMassSim } from '../src/balance/mass-sim.ts';
import { searchSpace } from '../src/data/balance-space.ts';
import { catalog } from '../src/data/catalog.ts';
import { urlShortener } from '../src/data/scenarios/url-shortener.ts';
import { scoring } from '../src/data/scoring.ts';

const pct = (x: number) => `${Math.round(x * 100)} %`;

const started = performance.now();
const report = runMassSim(urlShortener, catalog, searchSpace, scoring);
const elapsed = Math.round(performance.now() - started);

console.log(`${urlShortener.title} — ${report.waves[0]?.candidates ?? 0} architectures × ${report.waves.length} vagues, ${elapsed} ms\n`);

for (const w of report.waves) {
  const flag = w.meetsStrategyCriterion ? 'ok' : 'KO';
  const single = w.singleStrategy ? ' (réponse unique assumée)' : '';
  console.log(`[${flag}] ${w.waveId}${single} — ${w.strategies.length} stratégie(s) : ${w.strategies.join(' | ') || 'aucune'}`);
  for (const g of w.groups) {
    const { result: r, choice: c, score } = g.best;
    const levels = [
      c.extraInstances && `${c.extraInstances + 1} inst.`,
      c.autoscaling && `auto ≤${c.autoscaling}`,
      c.rateLimitTier && `palier ${c.rateLimitTier}`,
      c.replicas && `${c.replicas} répl.`,
      c.extraWorkers && `${c.extraWorkers + 1} workers`,
    ].filter(Boolean).join(', ');
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
console.log(`Architecture gagnant toutes les vagues : ${report.universalWinners.length === 0 ? 'aucune (ok)' : `${report.universalWinners.length} (KO)`}`);
console.log(`Deux stratégies sur la majorité des vagues : ${report.majorityHasTwoStrategies ? 'oui (ok)' : 'non (KO)'}`);
for (const o of report.overprovisioned) {
  console.log(`Tout au maximum, ${o.waveId} : ${o.losesOnBudget ? 'perd (ok)' : 'KO'} — ${o.lossReasons.join(' ; ') || 'gagne'}`);
}
