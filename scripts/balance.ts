import { runMassSim } from '../src/balance/mass-sim.ts';
import { diffLines, formatScenarioReport } from '../src/balance/report.ts';
import { balanceSpaces } from '../src/data/balance-space.ts';
import { catalog } from '../src/data/catalog.ts';
import { scoring } from '../src/data/scoring.ts';

// `npm run balance -- market` : un seul scénario, par son id.
// `--snapshot` écrit docs/balance-snapshot.txt, `--check` le compare au rapport courant.
// Les deux portent sur les scénarios réunis : combinés à un id, ils sont refusés plutôt
// que de comparer une section à un fichier entier.
// Pas de @types/node dans le projet : `process` est lu sans son type.
type Fs = { readFileSync(p: URL, enc: 'utf8'): string; writeFileSync(p: URL, data: string): void };
type Proc = { argv: string[]; exit(code: number): never; getBuiltinModule(id: 'fs'): Fs };
const proc = (globalThis as { process?: Proc }).process!;
const { readFileSync, writeFileSync } = proc.getBuiltinModule('fs');
const args = proc.argv.slice(2);
const only = args.find((a) => !a.startsWith('--'));
const snapshot = args.includes('--snapshot');
const check = args.includes('--check');
const SNAPSHOT_PATH = new URL('../docs/balance-snapshot.txt', import.meta.url);

if (snapshot && check) {
  console.error('--snapshot et --check s’excluent.');
  proc.exit(2);
}
if ((snapshot || check) && only) {
  console.error('--snapshot et --check portent sur tous les scénarios : pas de filtre.');
  proc.exit(2);
}

let ko = 0;
const stable: string[] = [];

for (const { scenario, space } of balanceSpaces.filter((b) => !only || b.scenario.id === only)) {
  const started = performance.now();
  const report = runMassSim(scenario, catalog, space, scoring);
  const elapsed = Math.round(performance.now() - started);
  const { lines, ko: scenarioKo } = formatScenarioReport(scenario, space, report);
  ko += scenarioKo;

  const header = `${scenario.title} — ${report.waves[0]?.candidates ?? 0} architectures × ${report.waves.length} vagues`;
  stable.push(`## ${header}`, ...lines, '');
  if (!snapshot && !check) {
    console.log(`\n${header}, ${elapsed} ms\n`);
    for (const l of lines) console.log(l);
  }
}

console.log(`\n${ko === 0 ? 'Aucun KO.' : `${ko} KO.`}`);

if (snapshot) {
  writeFileSync(SNAPSHOT_PATH, stable.join('\n'));
  console.log(`Instantané écrit : docs/balance-snapshot.txt`);
}
if (check) {
  const expected = readFileSync(SNAPSHOT_PATH, 'utf8').split('\n');
  const diff = diffLines(expected, stable.join('\n').split('\n'));
  if (diff.length > 0) {
    console.error(`\nL’équilibrage diffère de docs/balance-snapshot.txt (- instantané, + courant) :\n${diff.join('\n')}`);
    console.error('\nSi le changement est voulu : npm run balance:snapshot.');
    proc.exit(1);
  }
  console.log('Identique à docs/balance-snapshot.txt.');
}
if (ko > 0) proc.exit(1);
