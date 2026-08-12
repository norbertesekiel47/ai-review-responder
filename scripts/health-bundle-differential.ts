// Health-bundle differential (ticket #505, task T2) — the checked-in experiment
// that isolates Promise.all-vs-sequential × pool-size on the REAL health-check
// query mix and reproduces the Supavisor pooler pipelining CONNECTION WEDGE
// (CONTEXT.md: `state=active, wait_event=ClientRead`).
//
// It runs against an EPHEMERAL Supabase branch off staging where it is the SOLE
// client (deviations D5): the ADR-0007 application_name-attribution problem
// dissolves — every wedge-signature backend on the branch is provably ours, so
// cleanup can terminate-all-wedge with no per-backend attribution. Branch
// create/drop is the operator's step (T5 runbook); this script just takes the
// branch's TRANSACTION-pooler URL (:6543, transaction mode — must match staging's
// topology or the wedge won't form).
//
// Invocation (operator provisions/drops the branch):
//
//   pnpm tsx scripts/health-bundle-differential.ts \
//     --branch-pool-url <branch transaction-pooler url> \
//     --confirm-branch  <branch-project-ref> \
//     [--iterations N] [--observer-url <url>]
//
// Four arms, N iterations each (default 6), FRESH client per iteration so a wedge
// can't leak forward:
//   - concurrent-max2           : Promise.all, max:2, max_pipeline:100 → EXPECT wedge.
//   - concurrent-max2-pipeline1 : Promise.all, max:2, max_pipeline:1   → QUESTION under test.
//   - sequential-max2           : shipped sequence, max:2, max_pipeline:100 → EXPECT clean.
//   - concurrent-max6           : Promise.all, max:6, max_pipeline:100 → EXPECT clean.
//
// Detection is a 4-way taxonomy with MANDATORY observer corroboration (D3-A): a
// bare timeout is NOT a wedge — a read-only observer must confirm the ClientRead
// signature. Cleanup is best-effort client.end() (FIN unreliable per #477) THEN
// pg_terminate_backend of every wedge-signature backend on the branch, then a
// baseline barrier before the next arm. Final branch teardown is the operator's
// delete_branch.
import { createDedicatedPostgresClient } from '../src/lib/db/server';
import postgres from 'postgres';
import {
  checkFailedOutboxByTopic,
  checkOldestPendingOutbox,
  checkStaleDispatching,
  checkOpenFlaggedResponses,
  checkZeroDeliveryNotifications,
  checkBacklogDepth,
  runHealthChecks,
  resolveHealthAlertConfig,
  type HealthAlertConfig,
} from '../worker/background/pollers/health-alert/checks';
import { runDirectCli } from './run-direct-cli';
import { assertEphemeralBranchTarget, describeConnectionTarget, extractProjectRefForLog } from './staging-guard';

type Sql = ReturnType<typeof createDedicatedPostgresClient>;

/**
 * Bound each arm's work at 40s — deliberately GREATER than the 30s server-side
 * `statement_timeout` (src/lib/db/server.ts) and the 30s client-side
 * HEALTH_CHECK_TIMEOUT_MS. The wedge parks in `ClientRead` (a WAIT state, not a
 * running statement), so `statement_timeout` never heals it and the arm's
 * Promise.all never settles — 40s cleanly separates "resolved" from "wedged".
 */
export const DIFFERENTIAL_DEADLINE_MS = 40_000;

export const DIFFERENTIAL_ARMS = [
  { name: 'concurrent-max2', max: 2, maxPipeline: 100, mode: 'concurrent' },
  { name: 'concurrent-max2-pipeline1', max: 2, maxPipeline: 1, mode: 'concurrent' },
  { name: 'sequential-max2', max: 2, maxPipeline: 100, mode: 'sequential' },
  { name: 'concurrent-max6', max: 6, maxPipeline: 100, mode: 'concurrent' },
] as const;

const ARM_NAMES = DIFFERENTIAL_ARMS.map((arm) => arm.name);
type ArmName = (typeof ARM_NAMES)[number];

// ── CLI args (PURE) ────────────────────────────────────────────────────────────

export interface DifferentialConfig {
  branchPoolUrl: string;
  confirmBranchRef: string;
  /** Read-only observer connection; defaults to the branch pool URL when --observer-url is absent. */
  observerUrl: string;
  observerIsSeparate: boolean;
  iterations: number;
}

const DEFAULT_ITERATIONS = 6;

const USAGE =
  'usage: health-bundle-differential.ts --branch-pool-url <url> --confirm-branch <branch-ref> ' +
  '[--iterations N] [--observer-url <url>]';

// CLI arg parsing; one branch per flag — inherently branchy, correctness pinned by
// scripts/ci/__tests__/health-bundle-differential.test.ts.
// fallow-ignore-next-line complexity
export function parseArgs(argv: string[]): DifferentialConfig {
  const flags = new Map<string, string>();
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
    } else {
      flags.set(token.slice(2), argv[++i] ?? '');
    }
  }

  const branchPoolUrl = (flags.get('branch-pool-url') ?? '').trim();
  if (!branchPoolUrl) throw new Error(`--branch-pool-url is required. ${USAGE}`);
  const confirmBranchRef = (flags.get('confirm-branch') ?? '').trim();
  if (!confirmBranchRef) throw new Error(`--confirm-branch is required. ${USAGE}`);

  let iterations = DEFAULT_ITERATIONS;
  const rawIterations = flags.get('iterations');
  if (rawIterations !== undefined) {
    const parsed = Number(rawIterations);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      throw new Error('--iterations must be a positive integer');
    }
    iterations = parsed;
  }

  const observerFlag = (flags.get('observer-url') ?? '').trim();
  return {
    branchPoolUrl,
    confirmBranchRef,
    observerUrl: observerFlag || branchPoolUrl,
    observerIsSeparate: observerFlag.length > 0,
    iterations,
  };
}

/**
 * Apply the ephemeral-branch safety gate (D5) to BOTH the branch pool URL and the
 * read-only observer URL BEFORE any connection is opened. The prod denylist inside
 * assertEphemeralBranchTarget is defense-in-depth — the differential must be
 * impossible to point at prod/staging. Extracted so main's guard wiring is
 * unit-testable without a live DB.
 */
export function assertBranchTargets(config: DifferentialConfig): void {
  assertEphemeralBranchTarget(describeConnectionTarget(config.branchPoolUrl), config.confirmBranchRef);
  assertEphemeralBranchTarget(describeConnectionTarget(config.observerUrl), config.confirmBranchRef);
}

// ── detection taxonomy (PURE) ──────────────────────────────────────────────────

export type ArmOutcome = 'fulfilled' | 'rejected' | 'wedged' | 'hung-unknown';

export type DeadlineResult<T> =
  | { status: 'resolved'; value: T }
  | { status: 'rejected'; error: unknown }
  | { status: 'timeout' };

/**
 * Bound `work` at `deadlineMs`. Resolves to a `resolved`/`rejected` marker if the
 * work settles first, else a `timeout` marker. Does NOT cancel the work — a real
 * wedge never settles, and cleanup terminates the backend server-side. The
 * timer is cleared on settle so it can't keep the event loop alive.
 */
export async function runWithDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<DeadlineResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DeadlineResult<T>>((resolveTimer) => {
    timer = setTimeout(() => resolveTimer({ status: 'timeout' }), deadlineMs);
  });
  const settled: Promise<DeadlineResult<T>> = work.then(
    (value): DeadlineResult<T> => ({ status: 'resolved', value }),
    (error): DeadlineResult<T> => ({ status: 'rejected', error }),
  );
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

/**
 * The 4-way arm classifier (D3-A). `signaturePresent` is the read-only observer's
 * corroboration of the ClientRead wedge signature — MANDATORY: a bare timeout is
 * `hung-unknown` (inconclusive: slow query / pool exhaustion / network), never a
 * wedge, unless the signature is observed.
 */
export function classifyArm(result: DeadlineResult<unknown>, signaturePresent: boolean): ArmOutcome {
  if (result.status === 'resolved') return 'fulfilled';
  if (result.status === 'rejected') return 'rejected';
  return signaturePresent ? 'wedged' : 'hung-unknown';
}

/**
 * Collapse an arm's per-iteration outcomes to one representative outcome. `wedged`
 * wins (a single wedge proves the mechanism for the repro arm and is a regression
 * for a cure arm), then `rejected`, then `hung-unknown`, else `fulfilled`. An
 * empty list is treated as `hung-unknown` (no evidence → inconclusive).
 */
export function collapseArmOutcome(outcomes: ArmOutcome[]): ArmOutcome {
  if (outcomes.includes('wedged')) return 'wedged';
  if (outcomes.includes('rejected')) return 'rejected';
  if (outcomes.length === 0 || outcomes.includes('hung-unknown')) return 'hung-unknown';
  return 'fulfilled';
}

// ── run verdict / exit gating (PURE) ───────────────────────────────────────────

export interface RunArms {
  'concurrent-max2': ArmOutcome;
  'concurrent-max2-pipeline1': ArmOutcome;
  'sequential-max2': ArmOutcome;
  'concurrent-max6': ArmOutcome;
}

export type RunStatus =
  | 'depth-one-clean'
  | 'depth-one-wedged'
  | 'inconclusive'
  | 'cure-regression'
  | 'aborted-residual';

export interface RunVerdict {
  status: RunStatus;
  exitCode: number;
  reasons: string[];
}

/**
 * Expected-vs-actual exit gating. The legacy depth-100 repro and both clean controls
 * must behave as expected before the depth-1 arm is interpreted. A resolved or
 * corroborated-wedge depth-1 result is conclusive evidence either way; rejection or
 * an uncorroborated hang is inconclusive. Precedence is most-severe first.
 */
export function evaluateRun(arms: RunArms, residualSurvived: boolean): RunVerdict {
  const reasons: string[] = [];

  if (residualSurvived) {
    reasons.push('a wedge-signature backend survived terminate-all (baseline barrier breached) — branch pooler misbehaving');
  }

  const cureArmsWedged: ArmName[] = [];
  if (arms['sequential-max2'] === 'wedged') cureArmsWedged.push('sequential-max2');
  if (arms['concurrent-max6'] === 'wedged') cureArmsWedged.push('concurrent-max6');
  for (const arm of cureArmsWedged) {
    reasons.push(`${arm} wedged — cure REGRESSION (expected clean)`);
  }

  const reproConfirmed = arms['concurrent-max2'] === 'wedged';
  if (!reproConfirmed) {
    reasons.push(
      `concurrent-max2 did not wedge (outcome=${arms['concurrent-max2']}) — INCONCLUSIVE ` +
        '(possible branch-pooler-mode mismatch; NOT a cure regression)',
    );
  }

  if (residualSurvived) return { status: 'aborted-residual', exitCode: 1, reasons };
  if (cureArmsWedged.length > 0) return { status: 'cure-regression', exitCode: 1, reasons };
  if (!reproConfirmed) return { status: 'inconclusive', exitCode: 1, reasons };

  const cleanControls = [arms['sequential-max2'], arms['concurrent-max6']];
  if (cleanControls.some((outcome) => outcome !== 'fulfilled')) {
    return {
      status: 'inconclusive',
      exitCode: 1,
      reasons: [...reasons, 'one or more clean controls did not fulfill — depth-1 evidence cannot be interpreted'],
    };
  }

  const depthOne = arms['concurrent-max2-pipeline1'];
  if (depthOne === 'fulfilled') {
    return {
      status: 'depth-one-clean',
      exitCode: 0,
      reasons: ['legacy max_pipeline=100 wedged; max_pipeline=1 fulfilled; both clean controls fulfilled'],
    };
  }
  if (depthOne === 'wedged') {
    return {
      status: 'depth-one-wedged',
      exitCode: 0,
      reasons: ['legacy max_pipeline=100 and max_pipeline=1 both wedged; both clean controls fulfilled'],
    };
  }
  return {
    status: 'inconclusive',
    exitCode: 1,
    reasons: [...reasons, `max_pipeline=1 outcome=${depthOne} — depth-1 evidence is inconclusive`],
  };
}

// ── read-only wedge-signature observer + cleanup (live DB) ─────────────────────

/**
 * Sample the CONNECTION WEDGE signature (CONTEXT.md): backends stuck
 * `state=active AND wait_event='ClientRead'`. Read-only, pid-only — query TEXT is
 * NEVER selected (no review/response content). On the sole-client branch, any such
 * backend other than the observer's own is provably one of the differential's.
 */
async function sampleWedgeSignature(observer: Sql): Promise<number[]> {
  const rows = await observer<{ pid: number }[]>`
    SELECT pid
    FROM pg_stat_activity
    WHERE state = 'active'
      AND wait_event = 'ClientRead'
      AND pid <> pg_backend_pid()
  `;
  return rows.map((r) => r.pid);
}

/** Terminate EVERY wedge-signature backend on the branch (safe — sole client). Returns the count killed. */
async function terminateAllWedgeBackends(observer: Sql): Promise<number> {
  const rows = await observer<{ terminated: boolean }[]>`
    SELECT pg_terminate_backend(pid) AS terminated
    FROM pg_stat_activity
    WHERE state = 'active'
      AND wait_event = 'ClientRead'
      AND pid <> pg_backend_pid()
  `;
  return rows.filter((r) => r.terminated).length;
}

/** Best-effort FIN close of an arm's client. Documented UNRELIABLE (#477) — the pg_terminate ladder is the guarantee. */
async function bestEffortEnd(client: Sql): Promise<void> {
  try {
    await client.end({ timeout: 5 });
  } catch (error) {
    console.error('[differential] client.end threw (best-effort; FIN unreliable per #477)', error);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── arm firing (live DB) ───────────────────────────────────────────────────────

/** The exact pre-fix concurrent bundle: the 6 exported checks fired via Promise.all on ONE client. */
async function fireConcurrentBundle(sql: Sql, cfg: HealthAlertConfig): Promise<void> {
  await Promise.all([
    checkFailedOutboxByTopic(sql, cfg),
    checkOldestPendingOutbox(sql, cfg),
    checkStaleDispatching(sql, cfg),
    checkOpenFlaggedResponses(sql, cfg),
    checkZeroDeliveryNotifications(sql, cfg),
    checkBacklogDepth(sql, cfg),
  ]);
}

interface ArmRun {
  outcomes: ArmOutcome[];
  residualSurvived: boolean;
}

// One arm: N fresh-client iterations, each raced against the deadline, corroborated,
// then cleaned up with a baseline barrier. Inherently branchy repro protocol.
// fallow-ignore-next-line complexity
async function runArm(
  name: ArmName,
  clientMax: number,
  maxPipeline: number,
  fire: (sql: Sql, cfg: HealthAlertConfig) => Promise<unknown>,
  cfg: HealthAlertConfig,
  config: DifferentialConfig,
  observer: Sql,
  liveClients: Set<Sql>,
): Promise<ArmRun> {
  const outcomes: ArmOutcome[] = [];
  let residualSurvived = false;

  for (let i = 0; i < config.iterations; i++) {
    // `max_pipeline` is implemented by postgres.js 3.4.9 but omitted from its
    // public Options type. Keep the compatibility cast isolated to this experiment;
    // production client options remain unchanged.
    const clientOptions: postgres.Options<{}> & { max_pipeline: number } = {
      prepare: false,
      idle_timeout: 30,
      max_lifetime: 1800,
      connect_timeout: 10,
      max: clientMax,
      connection: { statement_timeout: 30_000 },
      max_pipeline: maxPipeline,
    };
    const client = postgres(config.branchPoolUrl, clientOptions);
    liveClients.add(client);

    const work = fire(client, cfg);
    // Detach: a wedged query never settles; swallow its eventual rejection (from the
    // pg_terminate below) so it never surfaces as an unhandledRejection after timeout.
    void work.catch(() => {});

    const result = await runWithDeadline(work, DIFFERENTIAL_DEADLINE_MS);
    let signaturePresent = false;
    if (result.status === 'timeout') {
      signaturePresent = (await sampleWedgeSignature(observer)).length > 0;
    }
    const outcome = classifyArm(result, signaturePresent);
    outcomes.push(outcome);
    console.log(`[${name}] iteration ${i + 1}/${config.iterations}: ${outcome}`);

    // Cleanup ladder: best-effort FIN, then terminate-all-wedge (sole-client → safe).
    await bestEffortEnd(client);
    liveClients.delete(client);
    const killed = await terminateAllWedgeBackends(observer);
    if (killed > 0) console.log(`[${name}] terminated ${killed} wedge-signature backend(s)`);

    // Baseline barrier: the branch must show zero wedge-signature backends before
    // the next iteration/arm. A residual that survived terminate-all → ABORT.
    await sleep(500);
    const residual = await sampleWedgeSignature(observer);
    if (residual.length > 0) {
      console.error(
        `[${name}] ABORT: ${residual.length} wedge-signature backend(s) survived terminate-all ` +
          `(pids ${residual.join(',')}) — branch pooler misbehaving`,
      );
      residualSurvived = true;
      break;
    }
  }

  return { outcomes, residualSurvived };
}

// ── reporting ──────────────────────────────────────────────────────────────────

function printSummary(arms: RunArms, perArm: Record<ArmName, ArmOutcome[]>, verdict: RunVerdict): void {
  console.log('\n============ HEALTH_BUNDLE_DIFFERENTIAL SUMMARY ============');
  for (const name of ARM_NAMES) {
    const expected = name === 'concurrent-max2'
      ? 'wedge'
      : name === 'concurrent-max2-pipeline1'
        ? 'question-under-test'
        : 'clean';
    console.log(
      `  ${name}: ${arms[name]} (expected ${expected}) :: iterations=[${perArm[name].join(', ')}]`,
    );
  }
  console.log(`VERDICT: ${verdict.status} (exit ${verdict.exitCode})`);
  for (const reason of verdict.reasons) console.log(`  - ${reason}`);
  console.log('===========================================================\n');
}

// ── entry point ────────────────────────────────────────────────────────────────

// Differential orchestration; correctness of the pure helpers is pinned by
// scripts/ci/__tests__/health-bundle-differential.test.ts, not unit granularity.
// fallow-ignore-next-line complexity
async function main(): Promise<number> {
  const config = parseArgs(process.argv);

  // SAFETY GUARD — both the branch target AND the observer must pass the ephemeral-
  // branch gate (prod denylist wins) BEFORE any connection is opened.
  assertBranchTargets(config);

  console.log(
    `[differential] branch ref=${extractProjectRefForLog(config.branchPoolUrl)} ` +
      `confirmed=${config.confirmBranchRef} observer=${config.observerIsSeparate ? 'separate' : 'branch-pool(shared)'} ` +
      `iterations=${config.iterations}`,
  );
  if (!config.observerIsSeparate) {
    console.log('[differential] NOTE: no --observer-url — sampling over the branch pool (may be flattened).');
  }

  const cfg = resolveHealthAlertConfig();
  const observer = createDedicatedPostgresClient(config.observerUrl, {
    max: 2,
    connection: { statement_timeout: 10_000 },
  });

  const liveClients = new Set<Sql>();
  let cleaningUp = false;
  // Staging operational harness, live-DB CLI (like scripts/wedge-repro.ts) — 0%
  // runtime coverage BY DESIGN, not risk; the pure helpers (classifyArm, collapseArmOutcome,
  // evaluateRun) ARE unit-tested.
  // fallow-ignore-next-line complexity
  const emergencyCleanup = async (): Promise<void> => {
    if (cleaningUp) return;
    cleaningUp = true;
    for (const client of liveClients) await bestEffortEnd(client);
    liveClients.clear();
    try {
      await terminateAllWedgeBackends(observer);
    } catch (error) {
      console.error('[differential] terminate-all during cleanup threw', error);
    }
    try {
      await observer.end({ timeout: 5 });
    } catch (error) {
      console.error('[differential] observer.end threw', error);
    }
  };
  const onSignal = (): void => {
    console.error('\n[differential] signal received — closing clients + terminating wedge backends, then exiting');
    void emergencyCleanup().finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const perArm: Record<ArmName, ArmOutcome[]> = {
    'concurrent-max2': [],
    'concurrent-max2-pipeline1': [],
    'sequential-max2': [],
    'concurrent-max6': [],
  };
  let residualSurvived = false;

  try {
    // Start-of-run baseline barrier: the branch must be clean before arm 1.
    const preExisting = await sampleWedgeSignature(observer);
    if (preExisting.length > 0) {
      console.error(`[differential] ${preExisting.length} pre-existing wedge-signature backend(s) — clearing before start`);
      await terminateAllWedgeBackends(observer);
      await sleep(500);
      if ((await sampleWedgeSignature(observer)).length > 0) {
        residualSurvived = true;
      }
    }

    for (const arm of DIFFERENTIAL_ARMS) {
      if (residualSurvived) break;
      const fire = arm.mode === 'concurrent'
        ? fireConcurrentBundle
        : (sql: Sql) => runHealthChecks(sql);
      const run = await runArm(
        arm.name,
        arm.max,
        arm.maxPipeline,
        fire,
        cfg,
        config,
        observer,
        liveClients,
      );
      perArm[arm.name] = run.outcomes;
      if (run.residualSurvived) residualSurvived = true;
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await emergencyCleanup();
  }

  const arms: RunArms = {
    'concurrent-max2': collapseArmOutcome(perArm['concurrent-max2']),
    'concurrent-max2-pipeline1': collapseArmOutcome(perArm['concurrent-max2-pipeline1']),
    'sequential-max2': collapseArmOutcome(perArm['sequential-max2']),
    'concurrent-max6': collapseArmOutcome(perArm['concurrent-max6']),
  };
  const verdict = evaluateRun(arms, residualSurvived);
  printSummary(arms, perArm, verdict);
  return verdict.exitCode;
}

runDirectCli({
  importMetaUrl: import.meta.url,
  main,
  onError: (error) => {
    console.error('[differential] fatal', error);
    return 1;
  },
});
