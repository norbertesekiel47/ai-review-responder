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
import type { StructuredAttemptReport } from './structured-runner';

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

interface PrintableEvalResult {
  passed: boolean;
  failures: string[];
  id: string;
  category: string;
}

function printLaneResults(lane: string, results: PrintableEvalResult[]): void {
  for (const result of results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    const detail = result.failures.length ? ` — ${result.failures.join('; ')}` : '';
    console.log(`${status}  ${lane}/${result.id} [${result.category}]${detail}`);
  }
}

export type RunMode = 'offline' | 'live' | 'structured';

/**
 * `--structured-only` is an opt-in KEYED lane, never a default: it requires
 * `--live` because it calls both real providers.
 */
export function parseRunMode(argv: readonly string[]): RunMode {
  const live = argv.includes('--live');
  if (argv.includes('--structured-only')) {
    if (!live) {
      throw new Error(
        '--structured-only requires --live: it calls both real providers ' +
          '(OPENAI_API_KEY and ANTHROPIC_API_KEY). Run `pnpm eval:llm --live --structured-only`.',
      );
    }
    return 'structured';
  }
  return live ? 'live' : 'offline';
}

function writeReport(report: { startedAt: string; failed: number }): void {
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

function printStructuredAttempt(id: string, attempt: StructuredAttemptReport): void {
  const usage = attempt.usage
    ? `${attempt.usage.promptTokens}+${attempt.usage.completionTokens} tokens`
    : 'no usage';
  let error = '';
  if (attempt.error) {
    const status = attempt.error.status === undefined ? '' : `/${attempt.error.status}`;
    error = ` error=${attempt.error.kind}${status}`;
  }
  console.log(
    `      ${id} ${attempt.lane}: ${attempt.provider ?? '-'} ${attempt.model ?? '-'} ` +
      `${usage} ${attempt.latencyMs}ms schema=${attempt.schemaPassed ? 'pass' : 'fail'}${error}`,
  );
}

async function runStructuredMain(): Promise<void> {
  // The keyed lane loads only here, behind a dynamic import, so the offline
  // default and the existing --live lane never import it.
  const { runStructuredEval } = await import('./structured-runner');
  const structuredReport = await runStructuredEval();

  printLaneResults('structured', structuredReport.results);
  for (const result of structuredReport.results) {
    for (const attempt of result.attempts) {
      printStructuredAttempt(result.id, attempt);
    }
  }

  const report = {
    startedAt: structuredReport.startedAt,
    mode: structuredReport.mode,
    total: structuredReport.total,
    passed: structuredReport.passed,
    failed: structuredReport.failed,
    lanes: { structured: structuredReport },
  };
  console.log(`\n${report.passed}/${report.total} passed (${report.mode} mode)`);
  writeReport(report);
}

async function main(): Promise<void> {
  const mode = parseRunMode(process.argv);
  if (mode === 'structured') {
    await runStructuredMain();
    return;
  }
  const live = mode === 'live';
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

  printLaneResults('reply', responseReport.results);
  printLaneResults('judge', judgeReport.results);

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
  writeReport(report);
}

// Run only when invoked directly (`tsx tests/llm-eval/run.ts`), never on import.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main();
}
