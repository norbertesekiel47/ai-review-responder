// tests/llm-eval/run.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEvalSet } from './load';
import { loadJudgeEvalSet } from './judge-load';
import { scoreJudgeOutput } from './judge-scorer';
import { scoreRow } from './scorer';
import type {
  JudgeEvalReport,
  JudgeEvalResult,
  JudgeEvalRow,
  JudgeLiveGenerator,
} from './judge-types';
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

export interface JudgeRunOptions {
  live: boolean;
  generate?: JudgeLiveGenerator;
}

/** Pure judge eval over golden or live structured outputs. */
export async function runJudgeEval(
  rows: JudgeEvalRow[],
  options: JudgeRunOptions,
): Promise<JudgeEvalReport> {
  if (options.live && !options.generate) {
    throw new Error('live judge mode requires a generate() function');
  }

  const results: JudgeEvalResult[] = [];
  for (const row of rows) {
    const output = options.live
      ? await options.generate!(row)
      : row.cannedOutput;
    results.push(scoreJudgeOutput(row, output, options.live ? 'live' : 'canned'));
  }

  const passed = results.filter((result) => result.passed).length;
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
  const judgeRows = loadJudgeEvalSet();

  let generate: ((row: EvalRow) => Promise<string>) | undefined;
  let generateJudge: JudgeLiveGenerator | undefined;
  if (live) {
    // Heavy generator deps are isolated behind this dynamic import so the
    // offline path stays import-light and keyless.
    const { createLiveGenerator, createLiveJudgeGenerator } = await import('./live-runner');
    generate = createLiveGenerator();
    generateJudge = createLiveJudgeGenerator();
  }

  const responseReport = await runEval(rows, { live, generate });
  const judgeReport = await runJudgeEval(judgeRows, { live, generate: generateJudge });

  for (const result of responseReport.results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    const detail = result.failures.length ? ` — ${result.failures.join('; ')}` : '';
    console.log(`${status}  reply/${result.id} [${result.category}]${detail}`);
  }
  for (const result of judgeReport.results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    const detail = result.failures.length ? ` — ${result.failures.join('; ')}` : '';
    console.log(`${status}  judge/${result.id} [${result.category}]${detail}`);
  }

  const report = {
    startedAt: responseReport.startedAt,
    mode: responseReport.mode,
    total: responseReport.total + judgeReport.total,
    passed: responseReport.passed + judgeReport.passed,
    failed: responseReport.failed + judgeReport.failed,
    lanes: {
      replyGeneration: responseReport,
      judge: judgeReport,
    },
  };
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
