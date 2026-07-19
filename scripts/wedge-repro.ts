// Faithful boot repro harness for the Supavisor pool-wedge (ticket #505, task T1).
//
// STAGING-ONLY operational harness — NOT shipped worker runtime. It boots the
// REAL worker as a fresh child process per trial, watches pg_stat_activity over a
// SEPARATE direct observer connection, and (for a reproduced wedge) characterizes
// the three established #500 facts before self-cleaning every backend it wedged.
//
// Invoked operationally (the operator runs this; the env is injected by Railway):
//
//   railway run --environment staging --service repworth-worker -- \
//     pnpm tsx scripts/wedge-repro.ts baseline   --confirm-staging <staging-project-ref>
//   railway run --environment staging --service repworth-worker -- \
//     pnpm tsx scripts/wedge-repro.ts treatment  --confirm-staging <staging-project-ref>
//   railway run --environment staging --service repworth-worker -- \
//     pnpm tsx scripts/wedge-repro.ts both       --confirm-staging <staging-project-ref>
//
//   baseline  → spawns each trial's worker with BOOT_STAGGER_ENABLED=false (legacy
//               synchronous all-at-once boot). Expected: the wedge REPRODUCES, and
//               the harness characterizes permanence + state_change fixity +
//               poison-migration.
//   treatment → spawns with the cure ON (BOOT_STAGGER_ENABLED left unset). Expected:
//               ZERO wedge across repeated fresh boots. Exits non-zero if ANY trial
//               wedges (a cure regression), so it doubles as a pass/fail gate.
//   both      → baseline trials then treatment trials; exit code follows treatment.
//
// Topology mirrors production: the WORKER CHILD connects to the pooler (:6543,
// where the wedge forms); this parent HARNESS observes + terminates over its OWN
// direct (:5432 preferred) connection.
//
// TRANSPORT INSTRUMENTATION: intentionally NOT wired. The postgres.js `debug` hook
// fires PRE-write (queued, not socket.write() completion), the cork/uncork theory
// was already falsified for postgres.js 3.4.9, and enabling it would mean editing
// the production DB singleton (src/lib/db/server.ts). Per the task's minimal-
// production-intrusion preference, transport is DECLARED OPAQUE here — the harness
// relies on the PRIMARY empirical signal (external pg_stat_activity observation +
// treatment result). The summary prints this explicitly.
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDedicatedPostgresClient } from '../src/lib/db/server';
import { runDirectCli } from './run-direct-cli';

// ── safety guard (the most important part; the one part that MUST have tests) ──

/**
 * Production Supabase project refs — the UNCONDITIONAL denylist. Refs are
 * non-secret discriminators (they appear in public connection hosts / usernames),
 * so hardcoding them here is intentional and correct; never add a password. If
 * the connection target matches ANY of these, the harness aborts regardless of
 * any flag. Source: docs/runbooks/deployment-guide.md ("Concrete IDs").
 */
export const PROD_PROJECT_REFS = ['udeyaqnvpojbwgoaxwdg'] as const;

/** The staging ref, for operator-facing messages only. NOT a security check. */
export const KNOWN_STAGING_REF = 'kubdiqdhqbhwmqfditeg';

/**
 * PURE, unit-tested gate. `host` is a ref-BEARING connection descriptor built by
 * describeConnectionTarget() — `user@hostname:port`, never a password — so the
 * project ref is present whether the URL is a Supabase pooler (`postgres.<ref>@…`)
 * or a direct connection (`db.<ref>.supabase.co`). Throws to reject; returns void
 * to accept.
 *
 * Order matters: the prod denylist is checked FIRST and wins over any flag, so a
 * staging `--confirm-staging` value can never authorize a prod-looking target.
 */
export function assertStagingTarget(host: string, confirmRef: string): void {
  const target = host.toLowerCase();

  // 1. Unconditional prod reject — denylist beats every flag.
  for (const prodRef of PROD_PROJECT_REFS) {
    if (target.includes(prodRef)) {
      throw new Error(
        `REFUSING TO RUN: connection target matches a PRODUCTION project ref (${prodRef}). ` +
          `This harness boots a real worker and runs pg_terminate_backend — staging only.`,
      );
    }
  }

  // 2. Positive staging confirmation required — the operator must pass the ref AND
  //    it must actually be present in the connection target.
  const ref = confirmRef.trim().toLowerCase();
  if (!ref) {
    throw new Error(
      'REFUSING TO RUN: pass --confirm-staging <project-ref> with the expected staging Supabase project ref.',
    );
  }
  if (PROD_PROJECT_REFS.some((prodRef) => ref === prodRef || ref.includes(prodRef))) {
    throw new Error(
      `REFUSING TO RUN: --confirm-staging was given a production project ref (${ref}).`,
    );
  }
  if (!target.includes(ref)) {
    throw new Error(
      `REFUSING TO RUN: connection target does not contain the confirmed staging ref (${ref}). ` +
        `The --confirm-staging value must match the DB the harness is pointed at.`,
    );
  }
}

// ── connection-target parsing (never surfaces the password) ───────────────────

/**
 * A ref-bearing, password-FREE descriptor of a Postgres URL: `user@hostname:port`.
 * Fed to assertStagingTarget and used for logging. Throws on an unparseable URL.
 */
export function describeConnectionTarget(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('connection URL is not parseable');
  }
  const user = parsed.username || '(no-user)';
  const port = parsed.port || '(no-port)';
  return `${user}@${parsed.hostname}:${port}`;
}

/** Best-effort extract of the project ref for logging (host `db.<ref>.` or user `postgres.<ref>`). */
function extractProjectRefForLog(url: string): string {
  try {
    const parsed = new URL(url);
    const hostMatch = /^db\.([a-z0-9]{16,})\./i.exec(parsed.hostname);
    if (hostMatch) return hostMatch[1]!;
    const userMatch = /^[^.]+\.([a-z0-9]{16,})$/i.exec(parsed.username);
    if (userMatch) return userMatch[1]!;
    return '(ref-not-found)';
  } catch {
    return '(unparseable)';
  }
}

// ── CLI args ──────────────────────────────────────────────────────────────────

type Command = 'baseline' | 'treatment' | 'both';

interface HarnessConfig {
  command: Command;
  confirmRef: string;
  trials: number;
  /** Max wait for the child to log "running on port" before treating boot as timed out. */
  bootWindowMs: number;
  /** Idle-observation window (worker alive, loops still cycling) used to prove permanence + fixity. */
  settleMs: number;
  /** Gap between pg_stat_activity samples during the settle + migration windows. */
  sampleIntervalMs: number;
  /** After terminating one wedged pid, how long to watch for a different backend to re-wedge. */
  migrationWindowMs: number;
  /** Base TCP port for the spawned worker's Fastify listener; each trial gets base+index. */
  workerPortBase: number;
  /** Forward child stdout/stderr lines (prefixed) for debugging. */
  verbose: boolean;
}

const DEFAULTS = {
  trials: 2,
  bootWindowMs: 25_000,
  settleMs: 15_000,
  sampleIntervalMs: 2_500,
  migrationWindowMs: 15_000,
  workerPortBase: 4310,
};

// CLI arg parsing; one branch per flag.
// fallow-ignore-next-line complexity
function parseArgs(argv: string[]): HarnessConfig {
  const command = argv[2] as Command | undefined;
  if (command !== 'baseline' && command !== 'treatment' && command !== 'both') {
    throw new Error(
      `usage: wedge-repro.ts <baseline|treatment|both> --confirm-staging <ref> ` +
        `[--trials N] [--boot-window-ms N] [--settle-ms N] [--sample-interval-ms N] ` +
        `[--migration-window-ms N] [--worker-port-base N] [--verbose]`,
    );
  }

  const flags = new Map<string, string>();
  let verbose = false;
  for (let i = 3; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    if (token === '--verbose') {
      verbose = true;
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
    } else {
      flags.set(token.slice(2), argv[++i] ?? '');
    }
  }

  // CLI numeric-arg parsing with bounds; branchy by nature.
  // fallow-ignore-next-line complexity
  const num = (key: string, fallback: number, opts: { integer?: boolean } = {}): number => {
    const raw = flags.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--${key} must be a positive number`);
    }
    // Count-like args (trial count, port) index loops / listen ports directly — a
    // fractional value like 1.5 would silently round the loop count, so reject it.
    if (opts.integer && !Number.isInteger(parsed)) {
      throw new Error(`--${key} must be a positive integer`);
    }
    return parsed;
  };

  return {
    command,
    confirmRef: flags.get('confirm-staging') ?? '',
    trials: num('trials', DEFAULTS.trials, { integer: true }),
    bootWindowMs: num('boot-window-ms', DEFAULTS.bootWindowMs),
    settleMs: num('settle-ms', DEFAULTS.settleMs),
    sampleIntervalMs: num('sample-interval-ms', DEFAULTS.sampleIntervalMs),
    migrationWindowMs: num('migration-window-ms', DEFAULTS.migrationWindowMs),
    workerPortBase: num('worker-port-base', DEFAULTS.workerPortBase, { integer: true }),
    verbose,
  };
}

// ── pg_stat_activity observation ──────────────────────────────────────────────

type Sql = ReturnType<typeof createDedicatedPostgresClient>;

const OBSERVER_APP_NAME = 'wedge-repro-observer';

interface ActivityRow {
  pid: number;
  backend_start: Date;
  query_start: Date | null;
  state_change: Date | null;
}

/**
 * The WEDGE SIGNATURE: a backend stuck `state=active AND wait_event='ClientRead'`
 * — reading bytes the client never sends, which no server-side timeout heals.
 * Query text is deliberately NOT selected (never log review/response content).
 * The observer excludes its own backend + any sibling observer connection.
 */
async function sampleWedged(sql: Sql): Promise<ActivityRow[]> {
  return sql<ActivityRow[]>`
    SELECT pid, backend_start, query_start, state_change
    FROM pg_stat_activity
    WHERE state = 'active'
      AND wait_event = 'ClientRead'
      AND pid <> pg_backend_pid()
      AND (application_name IS DISTINCT FROM ${OBSERVER_APP_NAME})
  `;
}

/** Every backend pid present right now — the pre-spawn baseline for "new = ours" attribution. */
async function sampleAllPids(sql: Sql): Promise<Set<number>> {
  const rows = await sql<{ pid: number }[]>`
    SELECT pid FROM pg_stat_activity WHERE pid <> pg_backend_pid()
  `;
  return new Set(rows.map((r) => r.pid));
}

/**
 * Terminate a backend we attributed to this trial. Returns pg_terminate_backend's
 * boolean (false = pid already gone). Best-effort — a throw is logged, not fatal,
 * so cleanup of the remaining pids still proceeds.
 */
async function terminateBackend(sql: Sql, pid: number): Promise<boolean> {
  try {
    const [row] = await sql<{ terminated: boolean }[]>`
      SELECT pg_terminate_backend(${pid}) AS terminated
    `;
    return row?.terminated ?? false;
  } catch (error) {
    console.error(`[cleanup] pg_terminate_backend(${pid}) threw`, error);
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Append `value` to the string-set at `key`, creating the set on first use. */
function recordValue(map: Map<number, Set<string>>, key: number, value: string): void {
  const existing = map.get(key);
  if (existing) existing.add(value);
  else map.set(key, new Set([value]));
}

// ── worker child lifecycle ────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface SpawnedWorker {
  child: ChildProcess;
  /** Resolves 'ready' on the boot-complete log line, 'exited' if the child dies first, 'timeout' otherwise. */
  waitForBoot: (timeoutMs: number) => Promise<'ready' | 'exited' | 'timeout'>;
  /** Last N stderr lines from the child — surfaced on any non-'ready' boot outcome for diagnosis. */
  recentStderr: () => string[];
  kill: () => Promise<void>;
}

const STDERR_RING_MAX = 50;

/**
 * Spawn the REAL worker (`pnpm run worker` → `tsx worker/index.ts`) as a fresh,
 * DETACHED child so the whole process group can be signalled on cleanup. The
 * child inherits the Railway-injected staging env; we override ONLY the boot
 * toggle and the listen port. `MOCK_EXTERNAL_APIS` is intentionally NOT forced —
 * the boot-burst DB behavior (what wedges) is faithful; the child is short-lived
 * and killed promptly to bound any real side effects on staging.
 */
function spawnWorker(opts: { staggerEnabled: boolean; port: number; verbose: boolean }): SpawnedWorker {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(opts.port) };
  if (opts.staggerEnabled) {
    // Cure ON = default. Ensure no inherited "false" forces legacy boot.
    delete env.BOOT_STAGGER_ENABLED;
  } else {
    env.BOOT_STAGGER_ENABLED = 'false';
  }

  const child = spawn('pnpm', ['run', 'worker'], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let booted = false;
  let exited = false;
  const bootWaiters: Array<(outcome: 'ready' | 'exited') => void> = [];
  // Ring buffer of the child's most recent stderr — printed on ANY non-'ready'
  // boot outcome (timeout / early exit / spawn error), regardless of --verbose,
  // so an operator debugging a failed staging boot sees the actual error.
  const stderrRing: string[] = [];

  // Line-classifier over subprocess output — one branch per recognized marker.
  // fallow-ignore-next-line complexity
  const handleLine = (line: string, stream: 'out' | 'err'): void => {
    if (stream === 'err') {
      stderrRing.push(line);
      if (stderrRing.length > STDERR_RING_MAX) stderrRing.shift();
    }
    if (opts.verbose) console.log(`[worker-child:${stream}] ${line}`);
    // Boot-complete signal — emitted by worker/index.ts after app.listen resolves.
    if (!booted && line.includes('Worker service running on port')) {
      booted = true;
      for (const w of bootWaiters.splice(0)) w('ready');
    }
  };

  const wire = (stream: NodeJS.ReadableStream | null, tag: 'out' | 'err'): void => {
    if (!stream) return;
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        handleLine(buffer.slice(0, nl), tag);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    });
  };
  wire(child.stdout, 'out');
  wire(child.stderr, 'err');

  child.on('exit', (code, signal) => {
    exited = true;
    if (!booted) {
      console.error(`[worker-child] exited before boot (code=${code} signal=${signal})`);
    }
    for (const w of bootWaiters.splice(0)) w('exited');
  });

  // Spawn-level failure (ENOENT etc.). Without a listener the ChildProcess emits
  // an unhandled 'error' that would crash the whole harness; instead surface it as
  // a clean per-trial boot failure and capture the reason for the stderr dump.
  child.on('error', (err) => {
    exited = true;
    stderrRing.push(`[spawn error] ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[worker-child] spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    for (const w of bootWaiters.splice(0)) w('exited');
  });

  const waitForBoot = (timeoutMs: number): Promise<'ready' | 'exited' | 'timeout'> => {
    if (booted) return Promise.resolve('ready');
    if (exited) return Promise.resolve('exited');
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        const idx = bootWaiters.indexOf(waiter);
        if (idx !== -1) bootWaiters.splice(idx, 1);
        resolvePromise('timeout');
      }, timeoutMs);
      const waiter = (outcome: 'ready' | 'exited'): void => {
        clearTimeout(timer);
        resolvePromise(outcome);
      };
      bootWaiters.push(waiter);
    });
  };

  // Best-effort process teardown ladder — each branch is a distinct kill escalation.
  // fallow-ignore-next-line complexity
  const kill = async (): Promise<void> => {
    if (exited || child.pid === undefined) return;
    const pid = child.pid;
    // SIGTERM first: the worker's graceful shutdown closes its pool cleanly, which
    // reduces lingering (non-wedged) backends. Wedged backends survive by design
    // and are terminated separately via pg_terminate_backend.
    const signalGroup = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pid, sig); // negative pid → whole detached process group
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    signalGroup('SIGTERM');
    for (let waited = 0; waited < 5_000 && !exited; waited += 250) {
      await sleep(250);
    }
    if (!exited) signalGroup('SIGKILL');
  };

  return { child, waitForBoot, recentStderr: () => [...stderrRing], kill };
}

// ── per-trial run ─────────────────────────────────────────────────────────────

interface TrialResult {
  index: number;
  mode: 'baseline' | 'treatment';
  bootOutcome: 'ready' | 'exited' | 'timeout';
  wedgedPidCount: number;
  permanenceConfirmed: boolean | null;
  stateChangeFixity: 'pinned' | 'moved' | 'unknown' | null;
  migrationObserved: boolean | null;
  cleanupRemaining: number;
  note: string;
}

/**
 * One fresh-process trial. `attributedPids` accumulates EVERY backend this trial
 * attributed to itself (new-since-spawn AND wedge-signature), so the caller's
 * finally-block can terminate all of them even if this function throws midway.
 * `liveWorkers` tracks the spawned child at MAIN scope so the SIGINT/SIGTERM path
 * (which `process.exit`s past this function's `finally`) can still kill it.
 */
// Protocol-level repro steps are inherently branchy; splitting them would scatter the trial narrative the harness exists to keep linear.
// fallow-ignore-next-line complexity
async function runTrial(
  observer: Sql,
  config: HarnessConfig,
  index: number,
  mode: 'baseline' | 'treatment',
  attributedPids: Set<number>,
  liveWorkers: Set<SpawnedWorker>,
): Promise<TrialResult> {
  const result: TrialResult = {
    index,
    mode,
    bootOutcome: 'timeout',
    wedgedPidCount: 0,
    permanenceConfirmed: null,
    stateChangeFixity: null,
    migrationObserved: null,
    cleanupRemaining: 0,
    note: '',
  };

  // Pre-spawn snapshot: everything present now is NOT ours. We only ever attribute
  // (and therefore only ever terminate) a wedge-signature backend that appeared
  // AFTER this snapshot — a pre-existing backend can never be a termination target.
  const preexistingPids = await sampleAllPids(observer);
  const preexistingWedged = (await sampleWedged(observer)).filter((r) => preexistingPids.has(r.pid));
  if (preexistingWedged.length > 0) {
    console.log(
      `[trial ${index}/${mode}] NOTE: ${preexistingWedged.length} pre-existing wedged backend(s) ` +
        `present before spawn — NOT attributed, NOT terminated (pids ${preexistingWedged.map((r) => r.pid).join(',')}).`,
    );
  }

  const port = config.workerPortBase + index;
  const worker = spawnWorker({ staggerEnabled: mode === 'treatment', port, verbose: config.verbose });
  // Register at main scope BEFORE any await, so the signal path can kill it even
  // if this trial is interrupted mid-boot. Deregistered in the finally after kill.
  liveWorkers.add(worker);
  console.log(
    `[trial ${index}/${mode}] spawned worker (port ${port}, ` +
      `BOOT_STAGGER_ENABLED=${mode === 'treatment' ? 'unset→cure ON' : 'false→legacy boot'})`,
  );

  try {
    result.bootOutcome = await worker.waitForBoot(config.bootWindowMs);
    if (result.bootOutcome !== 'ready') {
      result.note = `boot ${result.bootOutcome} — no observation performed`;
      console.error(`[trial ${index}/${mode}] boot ${result.bootOutcome}`);
      // Dump the child's recent stderr regardless of --verbose: on a failed staging
      // boot this is the diagnostic the operator actually needs.
      const stderr = worker.recentStderr();
      if (stderr.length > 0) {
        console.error(`[trial ${index}/${mode}] last ${stderr.length} child stderr line(s):`);
        for (const stderrLine of stderr) console.error(`  [worker-child:err] ${stderrLine}`);
      } else {
        console.error(`[trial ${index}/${mode}] (child produced no stderr)`);
      }
      return result;
    }
    console.log(`[trial ${index}/${mode}] boot complete — observing for ${config.settleMs}ms (worker idle)`);

    // Sample across the settle window while the worker is ALIVE and its loops keep
    // cycling — that is the state in which #500 saw query_start restamp while
    // state_change stayed pinned. Track per-pid query_start / state_change history.
    const queryStarts = new Map<number, Set<string>>();
    const stateChanges = new Map<number, Set<string>>();
    let firstSampleWedged: Set<number> | null = null;
    let lastSampleWedged: Set<number> = new Set();

    const samples = Math.max(2, Math.round(config.settleMs / config.sampleIntervalMs));
    for (let s = 0; s < samples; s++) {
      await sleep(config.sampleIntervalMs);
      const rows = (await sampleWedged(observer)).filter((r) => !preexistingPids.has(r.pid));
      const nowWedged = new Set<number>();
      for (const row of rows) {
        nowWedged.add(row.pid);
        attributedPids.add(row.pid);
        if (row.query_start) recordValue(queryStarts, row.pid, row.query_start.toISOString());
        if (row.state_change) recordValue(stateChanges, row.pid, row.state_change.toISOString());
      }
      firstSampleWedged ??= nowWedged;
      lastSampleWedged = nowWedged;
    }

    result.wedgedPidCount = lastSampleWedged.size;

    if (mode === 'treatment') {
      // Cure validation: zero wedge across the whole idle window (not merely
      // first-boot self-healed). Any attributed wedge here is a regression.
      const anyEver = attributedPids.size;
      result.note = anyEver === 0
        ? 'CLEAN — zero wedge across the boot + settle window'
        : `WEDGE under cure (${anyEver} attributed pid(s)) — regression`;
      console.log(`[trial ${index}/${mode}] ${result.note}`);
      return result;
    }

    // ── baseline characterization ──────────────────────────────────────────
    if (result.wedgedPidCount === 0) {
      result.note = 'baseline produced NO wedge this trial (repro not achieved — report honestly)';
      console.log(`[trial ${index}/${mode}] ${result.note}`);
      return result;
    }

    // (1) Permanence — a pid wedged in the first settle sample AND still wedged in
    //     the last (worker was idle throughout, yet it never healed).
    const firstSet = firstSampleWedged ?? new Set<number>();
    const permanentPids = [...lastSampleWedged].filter((pid) => firstSet.has(pid));
    result.permanenceConfirmed = permanentPids.length > 0;

    // (2) state_change fixity — the documented #500 fact is: query_start restamps
    //     each poll cycle while state_change stays PINNED. Report what we actually
    //     saw across the samples for the permanent pids.
    let fixity: 'pinned' | 'moved' | 'unknown' = 'unknown';
    for (const pid of permanentPids) {
      const stateChangeMoved = (stateChanges.get(pid)?.size ?? 0) > 1;
      const queryStartMoved = (queryStarts.get(pid)?.size ?? 0) > 1;
      if (stateChangeMoved) {
        fixity = 'moved';
        break; // any moving state_change contradicts the fixity claim — report it
      }
      // state_change constant for this pid → pinned. Strongest evidence is
      // query_start ALSO having moved (restamped) over the same samples.
      fixity = 'pinned';
      if (queryStartMoved) break;
    }
    result.stateChangeFixity = fixity;
    console.log(
      `[trial ${index}/${mode}] permanence=${result.permanenceConfirmed} ` +
        `state_change=${fixity} (permanent pids: ${permanentPids.join(',') || 'none'})`,
    );

    // (3) Poison-migration — terminate ONE wedged pid, watch for a DIFFERENT
    //     backend to re-wedge within the migration window.
    if (permanentPids.length > 0) {
      const victim = permanentPids[0]!;
      const terminated = await terminateBackend(observer, victim);
      attributedPids.delete(victim); // terminated; no longer needs cleanup
      console.log(`[trial ${index}/${mode}] terminated wedged pid ${victim} (ok=${terminated}); watching for migration`);
      const seen = new Set<number>([...attributedPids, victim, ...preexistingPids]);
      let migrated = false;
      const migSamples = Math.max(2, Math.round(config.migrationWindowMs / config.sampleIntervalMs));
      for (let s = 0; s < migSamples && !migrated; s++) {
        await sleep(config.sampleIntervalMs);
        const rows = (await sampleWedged(observer)).filter((r) => !preexistingPids.has(r.pid));
        for (const row of rows) {
          attributedPids.add(row.pid);
          if (!seen.has(row.pid)) {
            migrated = true;
            console.log(`[trial ${index}/${mode}] MIGRATION observed — new backend ${row.pid} re-wedged`);
          }
        }
      }
      result.migrationObserved = migrated;
      if (!migrated) console.log(`[trial ${index}/${mode}] no migration within ${config.migrationWindowMs}ms`);
    }

    result.note = `REPRODUCED — ${result.wedgedPidCount} wedged pid(s)`;
    return result;
  } finally {
    await worker.kill();
    liveWorkers.delete(worker);
    // Terminate every still-attributed backend this trial wedged, then verify.
    for (const pid of attributedPids) await terminateBackend(observer, pid);
    await sleep(500);
    const stillWedged = (await sampleWedged(observer)).filter((r) => attributedPids.has(r.pid));
    result.cleanupRemaining = stillWedged.length;
    if (stillWedged.length > 0) {
      console.error(
        `[trial ${index}/${mode}] WARNING: ${stillWedged.length} attributed backend(s) still wedged after cleanup ` +
          `(pids ${stillWedged.map((r) => r.pid).join(',')})`,
      );
    }
    attributedPids.clear();
  }
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Ordered cleanup for the signal path (SIGINT/SIGTERM), extracted PURE so the
 * ordering is unit-testable without real processes. The order is LOAD-BEARING:
 * kill the worker CHILDREN FIRST — a child left alive is detached (its own process
 * group, so it never received the terminal signal) and keeps booting, which can
 * re-wedge pooler backends AFTER a one-shot terminate pass; THEN terminate the
 * attributed DB backends; THEN close the observer. Each step is awaited in turn,
 * and a step that rejects is logged, never skipping the later steps.
 */
export async function runEmergencyCleanup(deps: {
  killChildren: () => Promise<void>;
  terminateBackends: () => Promise<void>;
  closeObserver: () => Promise<void>;
}): Promise<void> {
  const step = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      console.error(`[cleanup] ${label} step failed`, error);
    }
  };
  await step('kill-children', deps.killChildren);
  await step('terminate-backends', deps.terminateBackends);
  await step('close-observer', deps.closeObserver);
}

async function runMode(
  observer: Sql,
  config: HarnessConfig,
  mode: 'baseline' | 'treatment',
  liveTrialPids: Set<number>,
  liveWorkers: Set<SpawnedWorker>,
): Promise<TrialResult[]> {
  const results: TrialResult[] = [];
  for (let i = 0; i < config.trials; i++) {
    const result = await runTrial(observer, config, i, mode, liveTrialPids, liveWorkers);
    results.push(result);
  }
  return results;
}

function printSummary(baseline: TrialResult[], treatment: TrialResult[]): void {
  console.log('\n================ WEDGE_REPRO SUMMARY ================');
  const line = (r: TrialResult): void =>
    console.log(
      `  ${r.mode} trial ${r.index}: boot=${r.bootOutcome} wedged=${r.wedgedPidCount} ` +
        `permanence=${r.permanenceConfirmed ?? '-'} state_change=${r.stateChangeFixity ?? '-'} ` +
        `migration=${r.migrationObserved ?? '-'} cleanup_remaining=${r.cleanupRemaining} :: ${r.note}`,
    );
  if (baseline.length) {
    const reproduced = baseline.filter((r) => r.wedgedPidCount > 0).length;
    console.log(`BASELINE (BOOT_STAGGER_ENABLED=false): ${reproduced}/${baseline.length} trial(s) reproduced the wedge`);
    baseline.forEach(line);
  }
  if (treatment.length) {
    const wedged = treatment.filter((r) => r.wedgedPidCount > 0).length;
    console.log(`TREATMENT (cure ON): ${wedged}/${treatment.length} trial(s) wedged (target: 0)`);
    treatment.forEach(line);
  }
  console.log('TRANSPORT TRACE: not wired — declared OPAQUE (postgres.js debug hook is pre-write and');
  console.log('  would require editing the production DB singleton; primary signal is pg_stat_activity).');
  console.log('====================================================\n');
}

// Diagnostic-harness orchestration; correctness is pinned by scripts/ci/__tests__/wedge-repro.test.ts, not unit granularity.
// fallow-ignore-next-line complexity
async function main(): Promise<number> {
  const config = parseArgs(process.argv);

  const workerPoolUrl = process.env.DATABASE_POOL_URL;
  if (!workerPoolUrl) throw new Error('DATABASE_POOL_URL is required (the pooler URL the worker child uses)');

  // Observer prefers a DIRECT connection (:5432) — un-flattened application_names
  // and no pooler in the observation path. Falls back to the pooler URL.
  const observerUrl = process.env.WEDGE_OBSERVER_URL || process.env.DATABASE_URL || workerPoolUrl;
  const observerIsDirect = observerUrl !== workerPoolUrl;

  // SAFETY GUARD — both the observation target AND the worker's wedge target must
  // be staging. The worker child is what boots + wedges, so its pooler URL is the
  // load-bearing check; the observer runs pg_terminate_backend, so it is too.
  assertStagingTarget(describeConnectionTarget(workerPoolUrl), config.confirmRef);
  assertStagingTarget(describeConnectionTarget(observerUrl), config.confirmRef);

  console.log(
    `[wedge-repro] target ref=${extractProjectRefForLog(workerPoolUrl)} ` +
      `confirmed=${config.confirmRef} observer=${observerIsDirect ? 'direct' : 'pooler(fallback)'} ` +
      `command=${config.command} trials=${config.trials}`,
  );
  if (!observerIsDirect) {
    console.log(
      '[wedge-repro] NOTE: no direct observer URL (WEDGE_OBSERVER_URL / DATABASE_URL) — ' +
        'observing over the pooler; application_name may be flattened.',
    );
  }

  const observer = createDedicatedPostgresClient(observerUrl, {
    max: 2,
    connection: { application_name: OBSERVER_APP_NAME, statement_timeout: 10_000 },
  });

  // Resources this run must guarantee are cleaned up on EVERY exit path (success,
  // error, SIGINT/SIGTERM): the spawned worker CHILDREN (source of new wedges) and
  // the attributed DB backends. runTrial's finally handles the normal + error
  // paths; these main-scope sets + the signal handler close the window during an
  // in-flight trial, where process.exit() would otherwise skip that finally.
  const liveTrialPids = new Set<number>();
  const liveWorkers = new Set<SpawnedWorker>();
  let cleaningUp = false;
  const emergencyCleanup = (): Promise<void> => {
    if (cleaningUp) return Promise.resolve();
    cleaningUp = true;
    return runEmergencyCleanup({
      // Kill children FIRST — they are the source of NEW pooler wedges.
      killChildren: async () => {
        for (const worker of liveWorkers) await worker.kill();
        liveWorkers.clear();
      },
      terminateBackends: async () => {
        for (const pid of liveTrialPids) await terminateBackend(observer, pid);
        liveTrialPids.clear();
      },
      closeObserver: () => observer.end({ timeout: 5 }),
    });
  };
  const onSignal = (): void => {
    console.error('\n[wedge-repro] signal received — killing worker children + terminating backends, then exiting');
    void emergencyCleanup().finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let baseline: TrialResult[] = [];
  let treatment: TrialResult[] = [];
  try {
    if (config.command === 'baseline' || config.command === 'both') {
      baseline = await runMode(observer, config, 'baseline', liveTrialPids, liveWorkers);
    }
    if (config.command === 'treatment' || config.command === 'both') {
      treatment = await runMode(observer, config, 'treatment', liveTrialPids, liveWorkers);
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await emergencyCleanup();
  }

  printSummary(baseline, treatment);

  // Exit code: treatment gates (any wedge under the cure = regression → non-zero).
  // Baseline is informational (a non-repro is a finding, not a harness failure).
  const treatmentWedged = treatment.some((r) => r.wedgedPidCount > 0);
  const cleanupLeak = [...baseline, ...treatment].some((r) => r.cleanupRemaining > 0);
  if (cleanupLeak) {
    console.error('[wedge-repro] FAILED cleanup — a wedged backend was left behind');
    return 1;
  }
  return treatmentWedged ? 1 : 0;
}

runDirectCli({
  importMetaUrl: import.meta.url,
  main,
  onError: (error) => {
    console.error('[wedge-repro] fatal', error);
    return 1;
  },
});
