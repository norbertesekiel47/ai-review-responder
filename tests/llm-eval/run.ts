// tests/llm-eval/run.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEvalSet } from './load';
import { scoreRow } from './scorer';
import type { EvalReport, EvalResult, EvalRow } from './types';

export interface RunOptions {
  live: boolean;
  /** Required in live mode: resolves a row to its generated candidate text. */
  generate?: (row: EvalRow) => Promise<string>;
}

/** Pure eval over the given rows. No filesystem or process side effects. */
export async function runEval(
  rows: EvalRow[],
  options: RunOptions,
): Promise<EvalReport> {
  if (options.live && !options.generate) {
    throw new Error('live mode requires a generate() function');
  }

  const results: EvalResult[] = [];

  for (const row of rows) {
    let text: string;
    let source: EvalResult['source'];
    if (options.live) {
      text = await options.generate!(row);
      source = 'live';
    } else {
      text = row.candidate;
      source = 'canned';
    }
    results.push(scoreRow(row, text, source));
  }

  const passed = results.filter((r) => r.passed).length;
  return {
    startedAt: new Date().toISOString(),
    mode: options.live ? 'live' : 'offline',
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = resolve(HERE, 'reports');

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const rows = loadEvalSet();

  let generate: ((row: EvalRow) => Promise<string>) | undefined;
  if (live) {
    // Heavy generator deps are isolated behind this dynamic import so the
    // offline path stays import-light and keyless.
    const { createLiveGenerator } = await import('./live-runner');
    generate = createLiveGenerator();
  }

  const report = await runEval(rows, { live, generate });

  for (const result of report.results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    const detail = result.failures.length ? ` — ${result.failures.join('; ')}` : '';
    console.log(`${status}  ${result.id} [${result.category}]${detail}`);
  }
  console.log(`\n${report.passed}/${report.total} passed (${report.mode} mode)`);

  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = resolve(
    REPORTS_DIR,
    `${report.startedAt.replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report written: ${reportPath}`);

  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

// Run only when invoked directly (`tsx tests/llm-eval/run.ts`), never on import.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main();
}
