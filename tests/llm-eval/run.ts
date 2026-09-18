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
import type { ModerationCorpusReport } from './moderation-types';

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

export type RunMode = 'offline' | 'live' | 'structured' | 'moderation-corpus';

/**
 * `--structured-only` and `--moderation-corpus` are opt-in KEYED lanes, never a
 * default: both require `--live` because both call a real provider.
 */
export function parseRunMode(argv: readonly string[]): RunMode {
  const live = argv.includes('--live');
  if (argv.includes('--structured-only') && argv.includes('--moderation-corpus')) {
    throw new Error('--structured-only and --moderation-corpus are separate lanes; run one at a time');
  }
  if (argv.includes('--structured-only')) {
    if (!live) {
      throw new Error(
        '--structured-only requires --live: it calls both real providers ' +
          '(OPENAI_API_KEY and ANTHROPIC_API_KEY). Run `pnpm eval:llm --live --structured-only`.',
      );
    }
    return 'structured';
  }
  if (argv.includes('--moderation-corpus')) {
    if (!live) {
      throw new Error(
        '--moderation-corpus requires --live: it calls the real OpenAI Moderation API ' +
          '(OPENAI_API_KEY, OPENAI_MODERATION_ENABLED=true). ' +
          'Run `pnpm eval:llm --live --moderation-corpus`.',
      );
    }
    return 'moderation-corpus';
  }
  return live ? 'live' : 'offline';
}

/** Read `--flag <value>`. Returns undefined when the flag is absent. */
export function readFlagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

interface WriteReportOptions {
  /** Write here instead of the gitignored reports directory. */
  outPath?: string;
  /** Overrides the default `failed > 0` exit signal. */
  failed?: boolean;
}

function writeReport(
  report: { startedAt: string; failed: number },
  options: WriteReportOptions = {},
): void {
  const reportPath =
    options.outPath ??
    resolve(REPORTS_DIR, `${report.startedAt.replace(/[:.]/g, '-')}.json`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report written: ${reportPath}`);

  if (options.failed ?? report.failed > 0) {
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

function printModerationReport(
  report: ModerationCorpusReport,
  summariseProviders: (r: ModerationCorpusReport) => string,
): void {
  for (const result of report.results) console.log(moderationRowLine(result));
  console.log(`\n${moderationSummaryLine(report, summariseProviders)}`);
  for (const violation of report.violations) console.log(`VIOLATION  ${violation}`);
  console.log(`VERDICT: ${report.verdict} (${report.environment})`);
}

/** One evidence row: verdict, id, bucket, outcome, and who caught it. */
function moderationRowLine(result: ModerationCorpusReport['results'][number]): string {
  const correct = result.outcome === 'true_negative' || result.outcome === 'true_positive';
  const layers = [
    result.flaggedByLocal ? 'local' : null,
    result.flaggedByProvider ? 'provider' : null,
    result.flaggedBySafetyReview ? 'safety_review' : null,
  ]
    .filter(Boolean)
    .join('+');
  // Which provider answered the safety review, per row (deviation D5): the
  // Anthropic fallback means production may not use the one the corpus
  // measured, so the evidence names it rather than implying OpenAI.
  const answeredBy = result.safetyProvider ? ` safety-by=${result.safetyProvider}` : '';
  return (
    `${correct ? 'PASS' : 'FAIL'}  moderation/${result.id} [${result.bucket}] ` +
    `${result.outcome}${layers ? ` flagged-by=${layers}` : ''}${answeredBy}`
  );
}

/**
 * The totals line. The safety half is appended only in safety mode, keyed on
 * `safetyErrors` being defined, so a default-mode report stays byte-identical
 * to the runs already recorded as evidence.
 */
function moderationSummaryLine(
  report: ModerationCorpusReport,
  summariseProviders: (r: ModerationCorpusReport) => string,
): string {
  const base =
    `${report.passed}/${report.total} rows correct  ` +
    `FP=${report.falsePositives}/${report.safeTotal} ` +
    `(${(report.falsePositiveRate * 100).toFixed(1)}%)  ` +
    `FN=${report.falseNegatives}  providerMisses=${report.providerMisses}  ` +
    `providerErrors=${report.providerErrors}`;
  if (report.safetyErrors === undefined) return base;
  return (
    `${base}  safetyErrors=${report.safetyErrors}  ` +
    `injectionMisses=${report.safetyInjectionMisses ?? 0}  ` +
    `safetyProviders=${summariseProviders(report)}`
  );
}

/**
 * The provider-moderation corpus lane. Calls the real OpenAI Moderation API
 * through the production `moderateResponse`, so it is keyed and opt-in.
 *
 * Validation is environment-specific: staging evidence never makes production
 * ready. `--env` labels the recorded run, and `--out` writes the evidence JSON
 * outside the gitignored reports directory so it can be committed.
 *
 * Exported for tests only (red-team RT-06). The safety-mode wiring — the
 * `--with-safety-review` flag, the deviation-D3 `assertSafetyModeEnvironment`
 * ordering, and whether the safety corpus rows are appended — was reachable
 * only through the command an operator runs, so nothing covered it.
 */
export async function runModerationCorpusMain(argv: readonly string[]): Promise<void> {
  const environment = readFlagValue(argv, '--env');
  if (!environment) {
    throw new Error(
      '--moderation-corpus requires --env <name> (for example: staging, production). ' +
        'The evidence records which environment it proves.',
    );
  }
  // Fail loudly rather than record a clean-looking run that tested nothing:
  // with the flag off, moderateResponse returns the local decision and never
  // calls the provider.
  if (process.env.OPENAI_MODERATION_ENABLED !== 'true') {
    throw new Error(
      'OPENAI_MODERATION_ENABLED is not "true" in this process. ' +
        'moderateResponse would skip the provider entirely and every row would look clean. ' +
        'Set it in the target environment and re-run.',
    );
  }

  const withSafetyReview = argv.includes('--with-safety-review');

  // Keyed deps load only here, so the offline default stays import-light.
  const [
    { loadModerationCorpus, loadSafetyCorpus },
    { moderateResponse },
    { runModerationCorpus, assertSafetyModeEnvironment, makeCorpusSafetyReview, summariseSafetyProviders },
  ] = await Promise.all([
    import('./moderation-corpus-load'),
    import('../../src/lib/moderation/moderate'),
    import('./moderation-runner'),
  ]);

  // Deviation D3, and BEFORE any external call: reviewSafety short-circuits to
  // a mock CLEARANCE under MOCK_EXTERNAL_APIS (D2), so the run would record a
  // PASS that tested nothing. Same shape as the OPENAI_MODERATION_ENABLED
  // guard above — refusing afterwards still burns budget and still leaves a
  // transcript that looks like a run.
  if (withSafetyReview) assertSafetyModeEnvironment();

  // The injection rows are APPENDED, and live in their own file. Putting them
  // in moderation-corpus.jsonl would make the default command score 55 rows
  // against the 53 the 2026-09-17 evidence records (round-2 NEW A).
  const rows = withSafetyReview
    ? [...loadModerationCorpus(), ...loadSafetyCorpus()]
    : loadModerationCorpus();

  const report = await runModerationCorpus(rows, moderateResponse, environment, {
    ...(withSafetyReview ? { safetyReview: makeCorpusSafetyReview() } : {}),
  });

  printModerationReport(report, summariseSafetyProviders);
  writeReport(report, {
    outPath: readFlagValue(argv, '--out'),
    failed: report.verdict === 'FAIL',
  });
}

async function main(): Promise<void> {
  const mode = parseRunMode(process.argv);
  if (mode === 'structured') {
    await runStructuredMain();
    return;
  }
  if (mode === 'moderation-corpus') {
    await runModerationCorpusMain(process.argv);
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
