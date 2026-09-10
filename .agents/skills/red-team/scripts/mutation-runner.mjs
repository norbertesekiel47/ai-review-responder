#!/usr/bin/env node

/**
 * mutation-runner.mjs — the crash-safe mechanics of a `/red-team` mutation pass.
 *
 * WHY A SCRIPT AND NOT PROSE IN THE SKILL. Three of these mechanics are
 * unverifiable as instructions: a durable journal written BEFORE the mutation
 * lands, a supervisor whose identity is recorded before it can run anything,
 * and a finalizer that refuses to overwrite content it did not write. Each has a
 * crash window that only a test can prove closed, so each lives here.
 *
 * THE JOURNAL IS THE CONTRACT. `.feature/red-team-journal.json` (gitignored run
 * scratch) is the only durable link between a mutation and its undo. The
 * INVOKING agent — not the subagent that ran the mutations — runs `finalize`,
 * and it works from the journal alone, so a dead subagent cannot strand a
 * mutation in the worktree.
 *
 * THE SUPERVISOR EXISTS FOR ONE REASON. `spawn`'s own timeout kills the process
 * it started, not the descendants Vitest forks. Each run is therefore launched
 * under a PAUSED `sh` that is its own session and process-group leader: the
 * parent journals its PGID and start time, and only then writes the release
 * byte that lets it `exec` the real command. `exec` preserves PID and start
 * time, so the journaled identity stays valid for the group's whole life. The
 * start time is a PID-REUSE GUARD, not an ornament: without it a stale journal
 * entry could target a PID the OS has since handed to something else.
 *
 * THE RELEASE CHANNEL IS THE PARENT'S STDIN PIPE, and that closes the first of
 * the two crash windows on its own: a parent that dies before releasing gives
 * the supervisor EOF, and `read … || exit 0` makes it exit WITHOUT executing
 * anything. The identity is already durable at that point, so a later `reap`
 * finds an empty group and closes the entry rather than guessing.
 *
 * WHEN THE LEADER IS GONE BUT THE GROUP IS NOT, the group is still safe to
 * target: POSIX forbids reusing a process-group ID while any member of that
 * group is alive, so an orphaned descendant cannot be a stranger's process.
 *
 * NOTHING HERE INTERPOLATES A REPOSITORY-CONTROLLED NAME INTO A SHELL STRING.
 * Every launch is an argument array with `shell: false`.
 *
 * Exit codes: 0 success, 1 failure or abort, 2 usage error, 124 run timeout.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Plan budget: ≤30 mutation runs per round, ≤120s per run. */
export const MAX_RUNS_PER_ROUND = 30;
export const RUN_TIMEOUT_MS = 120_000;

// One owner-approved ticket continuation, not a general CLI/env override.
// Original pin/inventory stay immutable until completion; see #1185 D3.
const CONTINUATION_AUTHORIZATION = 'owner-1185-budget-continuation';
const CONTINUATION_TEXT = 'Question: Approve the ticket-scoped verifier change needed to finish those 439 cases—at least 878 additional test runs? The red-team skill limits verification to “30 mutation runs per round,” which is the remaining blocker.\nOwner: I approve';

function authorizedBudget(root, journal) {
  if (journal.round !== 1) return null;
  try {
    if (git(root, ['branch', '--show-current']) !== 'feat/1185') return null;
    const sidecar = JSON.parse(readFileSync(
      join(root, 'docs/reviews/red-team/feat-1185-67f43e/findings.json'), 'utf8',
    ));
    if (sidecar.mode !== 'feature' || sidecar.branch !== 'feat/1185' || sidecar.round !== 1
      || sidecar.head_sha !== '0b374b6a9b76ac4eee3222d84b47eae3e359bf4d'
      || !Array.isArray(sidecar.inventory) || sidecar.inventory.length !== 453
      || !Array.isArray(sidecar.authorizations)) return null;
    const identities = sidecar.inventory.map(({ id, file, test }) => ({ id, file, test }));
    if (sha256(JSON.stringify(identities)) !== '64929f4afa45ccdc52c8efc2da2e106729e569ed84863259d9bf990a5d9d9f1a') return null;
    const authorization = sidecar.authorizations.find((entry) => (
      entry?.id === CONTINUATION_AUTHORIZATION && entry.date === '2026-09-09'
      && entry.text === CONTINUATION_TEXT
    ));
    if (!authorization) return null;
    return { id: authorization.id, maxRuns: 1400, sha256: sha256(JSON.stringify(authorization)) };
  } catch {
    // Unreadable or malformed evidence never enlarges the cap.
    return null;
  }
}

/** The suffix that makes a stranded dotenv backup findable by the status checker. */
export const DOTENV_BACKUP_SUFFIX = '.red-team-backup';

/** A process serving or watching this worktree can execute a mutation under an unscrubbed env. */
export const WATCHER_PATTERNS = [
  /\bnext\s+dev\b/,
  /\bnext-server\b/,
  /\btsx\s+watch\b/,
  /\bpnpm\s+dev\b/,
  /\bpnpm\s+worker\b/,
  /\bdev-stack\.sh\b/,
  /\bplaywright\s+test\b/,
  /\bvitest\s+(?:--)?watch\b/,
];

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Vitest's `-t` is a REGULAR EXPRESSION filter, not a test identifier. An
 * unescaped title containing `(`, `+` or `?` selects the wrong set — or none.
 */
export function escapeTestName(name) {
  return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The minimal environment both the baseline and the mutant run under.
 *
 * An ALLOWLIST, never a denylist: a denylist that omits `ZERNIO_*` or
 * `SUPABASE_SERVICE_KEY` is a credential leak the day a new provider lands.
 * Without a validated local database the repo's own live-DB kill switch is set,
 * because `resolveTestDatabaseUrl()` falls back to reading `.env.local` off disk.
 */
export function buildRunEnv({ path, tmpHome, testDatabaseUrl = null, mockExternalApis = 'true' }) {
  if (!tmpHome) throw new Error('buildRunEnv needs a temporary HOME');
  const env = {
    PATH: path,
    HOME: tmpHome,
    TMPDIR: join(tmpHome, 'tmp'),
    NODE_ENV: 'test',
    CI: 'true',
    MOCK_EXTERNAL_APIS: mockExternalApis,
  };
  if (testDatabaseUrl === null) {
    env.REPWORTH_DISABLE_LIVE_DB_SUITES = '1';
  } else {
    assertLocalDatabaseUrl(testDatabaseUrl);
    env.TEST_DATABASE_POOL_URL = testDatabaseUrl;
    env.DATABASE_POOL_URL = testDatabaseUrl;
  }
  return env;
}

export function assertLocalDatabaseUrl(value) {
  let host;
  try {
    host = new URL(value).hostname;
  } catch {
    throw new Error(`TEST_DATABASE_POOL_URL is not a URL: ${value}`);
  }
  if (!LOCAL_DB_HOSTS.has(host)) {
    throw new Error(
      `refusing a non-local test database host '${host}' — a mutation removes the guard that `
      + 'made a remote endpoint safe',
    );
  }
  return true;
}

/**
 * `ps -Ao pid=,command=` rows that look like a server or watcher on this tree.
 *
 * `ignorePids` excludes THIS process and its ancestors, and it is not an
 * optimisation. Measured on a real machine: the shell that invoked the check was
 * itself reported, because its command line embedded a script containing the
 * literal text `next dev`. That is the same self-match that makes a grep-based
 * guard block its own documentation. Everything else still matches on substring,
 * deliberately — a false positive here refuses a run, which is the safe
 * direction; a false negative mutates code under a live hot-reloader.
 */
export function findWatchers(psOutput, ignorePids = new Set()) {
  return psOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const pid = Number(line.split(/\s+/)[0]);
      return !(Number.isFinite(pid) && ignorePids.has(pid));
    })
    .filter((line) => WATCHER_PATTERNS.some((pattern) => pattern.test(line)));
}

/** This process and every ancestor, so the checker never reports itself. */
export function selfAncestry(startPid = process.pid) {
  const pids = new Set();
  let pid = startPid;
  for (let depth = 0; depth < 32 && pid > 1; depth += 1) {
    pids.add(pid);
    const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
    const parent = Number((result.stdout ?? '').trim());
    if (!Number.isFinite(parent) || parent <= 1 || pids.has(parent)) break;
    pid = parent;
  }
  return pids;
}

/**
 * Exactly one executed test, or the oracle proved nothing.
 *
 * `-t` is a regex, so a careless title can select a whole describe block; a kill
 * counted from that run says nothing about the test under examination.
 */
export function countExecutedTests(report) {
  const executed = [];
  for (const file of report?.testResults ?? []) {
    for (const assertion of file?.assertionResults ?? []) {
      if (assertion?.status === 'passed' || assertion?.status === 'failed') {
        executed.push(assertion.fullName ?? assertion.title ?? '<unnamed>');
      }
    }
  }
  return executed;
}

// ---------------------------------------------------------------------------
// journal
// ---------------------------------------------------------------------------

export function journalPathFor(root) {
  return join(root, '.feature', 'red-team-journal.json');
}

/** `round` defaults to 0: a journal that exists but has had no round opened yet. */
export function emptyJournal(round = 0) {
  return {
    version: 1,
    round,
    runs: 0,
    mutations: [],
    dotenv: { open: false, files: [] },
    supervisors: [],
  };
}

export function readJournal(root) {
  const path = journalPathFor(root);
  if (!existsSync(path)) return emptyJournal();
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Durable write: temp file, fsync, rename.
 *
 * The journal's whole value is surviving the process that wrote it, so a
 * buffered write that a crash discards would defeat the mechanism it exists for.
 */
export function writeJournal(root, journal) {
  const path = journalPathFor(root);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  const descriptor = openSync(temporary, 'w');
  try {
    writeSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}

// ---------------------------------------------------------------------------
// git and process probes
// ---------------------------------------------------------------------------

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

export function repoRoot(cwd = process.cwd()) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
}

/** The process start time, second resolution. The PID-reuse guard. */
export function processStartTime(pid) {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const value = (result.stdout ?? '').trim();
  return value.length > 0 ? value : null;
}

/**
 * Every RUNNING PID in `pgid`, from a portable `ps -Ao pid=,pgid=,stat=`.
 *
 * Zombies are excluded deliberately. A reaped-but-unwaited child still appears
 * in `ps` while its parent is busy, and it can no longer execute anything — so
 * counting it would make the finalizer report a group it had already emptied.
 */
export function groupMembers(pgid, psOutput = null) {
  const output = psOutput
    ?? spawnSync('ps', ['-Ao', 'pid=,pgid=,stat='], { encoding: 'utf8' }).stdout
    ?? '';
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]))
    .filter((parts) => !parts[2].startsWith('Z'))
    .filter((parts) => Number(parts[1]) === Number(pgid))
    .map((parts) => Number(parts[0]));
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

/**
 * Terminate and reap one journaled process group.
 *
 * Identity rule, and the two cases it separates:
 *  - the leader is ALIVE  → its start time must match the journal, or the PID
 *    was reused and this is a stranger's process. Refuse.
 *  - the leader is GONE but the group is not empty → POSIX forbids PGID reuse
 *    while a member lives, so the survivors are ours. Kill the group.
 */
export async function reapGroup(supervisor) {
  const { pid, pgid, startedAt } = supervisor;
  const leaderStart = processStartTime(pid);
  if (leaderStart !== null && leaderStart !== startedAt) {
    return { ok: false, reason: `pid ${pid} was reused (start time differs) — refusing to signal it` };
  }
  if (groupMembers(pgid).length === 0) return { ok: true, killed: 0 };

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') return { ok: false, reason: `kill ${signal} on ${pgid}: ${error.message}` };
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (groupMembers(pgid).length === 0) return { ok: true, killed: 1 };
      await sleep(100);
    }
  }
  const remaining = groupMembers(pgid);
  return remaining.length === 0
    ? { ok: true, killed: 1 }
    : { ok: false, reason: `process group ${pgid} still holds ${remaining.join(', ')}` };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function usage(message) {
  console.error('usage: mutation-runner.mjs <command> [options]');
  console.error('  commands: round-start | env | watchers | escape-test-name | assert-one-test |');
  console.error('            mutate | run | reap | finalize | dotenv-swap | dotenv-restore | status');
  if (message) console.error(`  ${message}`);
  process.exit(2);
}

function options(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      parsed._ = argv.slice(index + 1);
      break;
    }
    if (!token.startsWith('--')) usage(`unexpected argument '${token}'`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function commandEnv(root, parsed) {
  return buildRunEnv({
    path: process.env.PATH ?? '/usr/bin:/bin',
    tmpHome: parsed['tmp-home'] ? resolve(parsed['tmp-home']) : join(root, '.feature', 'red-team-home'),
    testDatabaseUrl: typeof parsed['test-db'] === 'string' ? parsed['test-db'] : null,
    mockExternalApis: typeof parsed['mock-external'] === 'string' ? parsed['mock-external'] : 'true',
  });
}

/**
 * TRUE when this branch's sidecar already records an owner authorization naming a
 * third round.
 *
 * It reads the sidecar rather than a flag or an env var on purpose: the
 * authorization has to survive in the committed evidence, where a reviewer sees it
 * beside the findings, and it has to exist BEFORE the round opens. Matching on
 * `branch` rather than re-deriving the slug keeps this from needing a second copy
 * of the checker's path logic — two derivations of one path can disagree, and a
 * disagreement here would either block a granted round or open an ungranted one.
 *
 * Fails CLOSED on anything it cannot read: no directory, no matching sidecar,
 * unparseable JSON, or no matching text all mean "not authorized".
 */
function hasThirdRoundAuthorization(root) {
  const reviewsDir = join(root, 'docs', 'reviews', 'red-team');
  if (!existsSync(reviewsDir)) return false;

  let branch;
  try {
    branch = git(root, ['branch', '--show-current']);
  } catch {
    return false;
  }
  if (!branch) return false;

  let entries;
  try {
    entries = readdirSync(reviewsDir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sidecarPath = join(reviewsDir, entry.name, 'findings.json');
    if (!existsSync(sidecarPath)) continue;
    let sidecar;
    try {
      sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    } catch {
      continue;
    }
    if (sidecar?.branch !== branch) continue;
    const authorizations = Array.isArray(sidecar.authorizations) ? sidecar.authorizations : [];
    if (authorizations.some((a) => /third round/i.test(String(a?.text ?? '')))) return true;
  }
  return false;
}

/**
 * Open a round: verify the journal is closed, then reset the run budget.
 *
 * The budget is "30 runs per ROUND", and the journal outlives a round — so
 * without this the second round would inherit the first round's counter and hit
 * the cap having executed nothing. Refusing to open over an unclean journal is
 * the same check in the other direction: a round must never start on top of an
 * unrestored mutation or an open dotenv swap.
 */
function cmdRoundStart(root) {
  const journal = readJournal(root);
  const blockers = [];
  if (journal.dotenv?.open === true) blockers.push('the dotenv swap is still open');
  for (const entry of journal.mutations ?? []) {
    if (entry.state !== 'restored') {
      blockers.push(`mutation of ${entry.path} is journaled '${entry.state}', not 'restored'`);
    }
  }
  for (const supervisor of journal.supervisors ?? []) {
    if (supervisor.active === true) {
      blockers.push(`supervisor pgid ${supervisor.pgid} is still journaled active`);
    }
  }
  if (blockers.length > 0) {
    console.error('round-start: REFUSED — the previous round did not finalize');
    for (const blocker of blockers) console.error(`  ${blocker}`);
    console.error('  Run `finalize` and resolve any abort before opening a new round.');
    return 1;
  }
  const round = (journal.round ?? 0) + 1;
  // Two rounds is still what a run reaches on its own. A THIRD opens only on an
  // owner authorization already recorded in the sidecar, and nothing past three
  // opens at all.
  //
  // Why the exception exists (#1184, after the same wall on #1178 and #1186): a
  // round-2 finding whose fix touches the tree makes the sidecar stale by
  // construction, and with no third round the only ways out were to leave a known
  // defect unfixed or to hand-edit `head_sha` — an evidence file rewriting its own
  // provenance. The escape is deliberately not free: the authorization must ALREADY
  // be in the sidecar before the round opens, so a third round is something the
  // owner granted rather than something a stuck agent decided for itself.
  if (round > 3) {
    console.error(`round-start: REFUSED — round ${round} exceeds the hard cap of 3`);
    return 1;
  }
  if (round === 3 && !hasThirdRoundAuthorization(root)) {
    console.error('round-start: REFUSED — a third round needs a recorded owner authorization');
    console.error("  Add an entry to the sidecar's `authorizations` array whose text names the");
    console.error('  third round (e.g. "third round authorized"), then re-run round-start.');
    return 1;
  }
  writeJournal(root, emptyJournal(round));
  console.log(`round-start: round ${round} open, ${MAX_RUNS_PER_ROUND} mutation runs available`);
  return 0;
}

function cmdEnv(root, parsed) {
  const env = commandEnv(root, parsed);
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  console.log(JSON.stringify(env, null, 2));
  return 0;
}

function cmdWatchers(parsed) {
  const output = typeof parsed['ps-source'] === 'string'
    ? readFileSync(resolve(parsed['ps-source']), 'utf8')
    : (spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).stdout ?? '');
  const matches = findWatchers(
    output,
    typeof parsed['ps-source'] === 'string' ? new Set() : selfAncestry(),
  );
  if (matches.length === 0) {
    console.log('watchers: none — no dev server, watch worker, or E2E server is serving this worktree');
    return 0;
  }
  console.error('watchers: ABORT — a process is watching or serving this worktree:');
  for (const line of matches) console.error(`  ${line}`);
  console.error('  Hot reload can execute a mutation under that process\'s unscrubbed environment.');
  return 1;
}

function cmdAssertOneTest(parsed) {
  if (typeof parsed.report !== 'string') usage('assert-one-test needs --report <json-file>');
  let report;
  try {
    report = JSON.parse(readFileSync(resolve(parsed.report), 'utf8'));
  } catch (error) {
    console.error(`assert-one-test: unreadable report — ${error.message}`);
    return 1;
  }
  const executed = countExecutedTests(report);
  if (executed.length === 1) {
    console.log(`assert-one-test: exactly one test executed — ${executed[0]}`);
    return 0;
  }
  console.error(`assert-one-test: INCONCLUSIVE — ${executed.length} test(s) executed, expected exactly 1`);
  for (const name of executed.slice(0, 5)) console.error(`  ${name}`);
  return 1;
}

function cmdMutate(root, parsed) {
  if (typeof parsed.file !== 'string' || typeof parsed.mutant !== 'string') {
    usage('mutate needs --file <tracked-path> --mutant <file-holding-the-mutant>');
  }
  const target = resolve(root, parsed.file);
  if (!existsSync(target)) {
    console.error(`mutate: ${parsed.file} does not exist`);
    return 1;
  }
  const mutantSource = readFileSync(resolve(parsed.mutant));

  // The original blob is written into the object database BEFORE the mutation,
  // so the finalizer can always restore it even from a fresh process.
  const originalOid = git(root, ['hash-object', '-w', '--', target]);
  const journal = readJournal(root);
  journal.mutations.push({
    path: parsed.file,
    originalOid,
    patchSha256: sha256(mutantSource),
    mutantOid: null,
    state: 'pending',
    at: new Date().toISOString(),
  });
  writeJournal(root, journal);

  writeFileSync(target, mutantSource);
  const mutantOid = git(root, ['hash-object', '-w', '--', target]);
  const entry = journal.mutations[journal.mutations.length - 1];
  entry.mutantOid = mutantOid;
  entry.state = 'applied';
  writeJournal(root, journal);

  console.log(`mutate: ${parsed.file} ${originalOid.slice(0, 12)} -> ${mutantOid.slice(0, 12)}`);
  return 0;
}

async function cmdRun(root, parsed) {
  const argv = parsed._;
  if (argv.length === 0) usage('run needs the command after `--`');
  const journal = readJournal(root);
  const authorization = authorizedBudget(root, journal);
  const maxRuns = authorization?.maxRuns ?? MAX_RUNS_PER_ROUND;
  if (journal.runs >= maxRuns) {
    console.error(`run: mutation budget exhausted (${maxRuns} runs this round)`);
    console.error('  Mark the remaining candidates skipped-budget; the status becomes INCOMPLETE_BUDGET.');
    return 1;
  }
  const timeout = Number(parsed.timeout ?? RUN_TIMEOUT_MS);
  const env = commandEnv(root, parsed);
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });

  // A PAUSED supervisor: `sh` blocks on a read, so the parent can journal its
  // identity before anything runs. `exec` then preserves that identity.
  // `--no-release` deliberately LEAVES the supervisor paused, so its output
  // streams are discarded rather than inherited: an orphan holding the parent's
  // pipes open would make the caller wait for a process it just abandoned.
  const paused = parsed['no-release'] === true;
  const supervisor = spawn(
    '/bin/sh',
    ['-c', 'read RELEASE || exit 0; exec "$@"', 'red-team-supervisor', ...argv],
    {
      cwd: root,
      detached: true,
      env,
      stdio: paused ? ['pipe', 'ignore', 'ignore'] : ['pipe', 'inherit', 'inherit'],
    },
  );
  const pid = supervisor.pid;
  const startedAt = processStartTime(pid);
  journal.runs += 1;
  if (authorization && !journal.budgetAuthorization) {
    journal.budgetAuthorization = { ...authorization, firstRun: journal.runs };
  }
  journal.supervisors.push({
    pid,
    pgid: pid,
    startedAt,
    active: true,
    command: argv[0],
    at: new Date().toISOString(),
  });
  writeJournal(root, journal);

  if (paused) {
    supervisor.unref();
    supervisor.stdin.end();
    console.log(`run: supervisor ${pid} journaled and left PAUSED (--no-release)`);
    return 0;
  }

  supervisor.stdin.write('go\n');
  supervisor.stdin.end();

  const outcome = await new Promise((resolveRun) => {
    const timer = setTimeout(() => resolveRun({ timedOut: true }), timeout);
    supervisor.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolveRun({ timedOut: false, code, signal });
    });
  });

  const reaped = await reapGroup({ pid, pgid: pid, startedAt });
  const current = readJournal(root);
  const record = current.supervisors.find((entry) => entry.pid === pid);
  if (record) record.active = !reaped.ok;
  writeJournal(root, current);

  if (!reaped.ok) {
    console.error(`run: could not reap the process group — ${reaped.reason}`);
    return 1;
  }
  if (outcome.timedOut) {
    console.error(`run: TIMEOUT after ${timeout}ms; the whole process group was terminated and reaped`);
    return 124;
  }
  console.log(`run: exited code=${outcome.code} signal=${outcome.signal ?? 'none'} (group reaped)`);
  return outcome.code === 0 ? 0 : 1;
}

async function cmdReap(root) {
  const journal = readJournal(root);
  const failures = [];
  for (const supervisor of journal.supervisors) {
    if (supervisor.active !== true) continue;
    const result = await reapGroup(supervisor);
    if (result.ok) supervisor.active = false;
    else failures.push(result.reason);
  }
  writeJournal(root, journal);
  if (failures.length > 0) {
    console.error('reap: FAILED');
    for (const reason of failures) console.error(`  ${reason}`);
    return 1;
  }
  console.log(`reap: every journaled process group is empty (${journal.supervisors.length} recorded)`);
  return 0;
}

function restoreMutations(root, journal) {
  const failures = [];
  const restored = [];
  for (const entry of journal.mutations) {
    if (entry.state === 'restored') continue;
    const target = resolve(root, entry.path);
    if (!existsSync(target)) {
      failures.push(`${entry.path} is missing — refusing to recreate it`);
      continue;
    }
    const current = git(root, ['hash-object', '--', target]);
    if (current === entry.originalOid) {
      entry.state = 'restored';
      continue;
    }
    if (current !== entry.mutantOid) {
      // NEITHER the original nor the mutant we journaled. Foreign content is
      // never overwritten: an unrelated edit made during the run would be lost.
      failures.push(
        `${entry.path} holds neither the original (${entry.originalOid.slice(0, 12)}) nor the `
        + `journaled mutant (${String(entry.mutantOid).slice(0, 12)}) — ABORT, nothing touched`,
      );
      continue;
    }
    const original = execFileSync('git', ['cat-file', 'blob', entry.originalOid], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(target, original);
    const verified = git(root, ['hash-object', '--', target]);
    if (verified !== entry.originalOid) {
      failures.push(`${entry.path} did not verify after restore (${verified.slice(0, 12)})`);
      continue;
    }
    entry.state = 'restored';
    restored.push(entry.path);
  }
  return { failures, restored };
}

function restoreDotenv(root, journal) {
  const failures = [];
  const restored = [];
  for (const file of journal.dotenv.files) {
    const target = resolve(root, file.path);
    const backup = resolve(root, file.backupPath);
    if (!existsSync(backup)) {
      // The backup is gone. Two very different worlds, told apart by the one
      // hash the journal DOES carry:
      //
      //   * the destination is NOT the scrubbed copy → someone already put the
      //     real file back by hand (the documented resolution after an abort).
      //     Accept it and close the entry. Without this the journal stays open
      //     forever and every transition fails with no way out — measured, not
      //     hypothesised.
      //   * the destination IS still the scrubbed copy → the real content is
      //     gone. That stays a hard failure; closing it would bless a scrubbed
      //     dotenv as if it were the operator's own file.
      if (existsSync(target) && sha256(readFileSync(target)) !== file.scrubbedSha256) {
        restored.push(`${file.path} (already restored by hand)`);
        continue;
      }
      failures.push(
        `${file.backupPath} is gone and ${file.path} is still the scrubbed copy — the real `
        + 'file is LOST; restore it from your own backup before any transition',
      );
      continue;
    }
    if (existsSync(target)) {
      const actual = sha256(readFileSync(target));
      if (actual !== file.scrubbedSha256) {
        // Someone edited the scrubbed file during the run. Keeping both beats
        // silently discarding an edit we cannot read.
        failures.push(
          `${file.path} no longer matches the scrubbed copy this run wrote — ABORT, both files kept`,
        );
        continue;
      }
      rmSync(target);
    }
    renameSync(backup, target);
    restored.push(file.path);
  }
  if (failures.length === 0) {
    journal.dotenv = { open: false, files: [] };
  }
  return { failures, restored };
}

async function cmdFinalize(root) {
  const reapCode = await cmdReap(root);
  if (reapCode !== 0) {
    console.error('finalize: ABORT — a process group is still live; files were NOT restored');
    return 1;
  }
  const journal = readJournal(root);
  const mutations = restoreMutations(root, journal);
  const dotenv = restoreDotenv(root, journal);
  writeJournal(root, journal);

  const failures = [...mutations.failures, ...dotenv.failures];
  if (failures.length > 0) {
    console.error(`finalize: FAILED (${failures.length} issue(s))`);
    for (const reason of failures) console.error(`  ${reason}`);
    console.error('  Resolve by hand. Never let a report be written over an unrestored tree.');
    return 1;
  }
  console.log(
    `finalize: restored ${mutations.restored.length} mutated file(s) and `
    + `${dotenv.restored.length} dotenv file(s); journal closed`,
  );
  return 0;
}

function cmdDotenvSwap(root, parsed) {
  const names = typeof parsed.files === 'string' ? parsed.files.split(',') : ['.env.local', '.env'];
  const journal = readJournal(root);
  if (journal.dotenv.open === true) {
    console.error('dotenv-swap: a swap is already open — run dotenv-restore first');
    return 1;
  }
  const scrubbed = [
    '# red-team scrubbed replacement. The real file is at the journaled backup path.',
    'MOCK_EXTERNAL_APIS=true',
    ...(typeof parsed['test-db'] === 'string' ? [`TEST_DATABASE_POOL_URL=${parsed['test-db']}`] : []),
    '',
  ].join('\n');
  if (typeof parsed['test-db'] === 'string') assertLocalDatabaseUrl(parsed['test-db']);

  const files = [];
  for (const name of names) {
    const target = resolve(root, name);
    if (!existsSync(target)) continue;
    const backupPath = `${name}${DOTENV_BACKUP_SUFFIX}`;
    const backup = resolve(root, backupPath);
    if (existsSync(backup)) {
      console.error(`dotenv-swap: ${backupPath} already exists — an earlier run did not finalize`);
      return 1;
    }
    // Rename FIRST: the real file is never overwritten in place, so a crash
    // between the two steps leaves it recoverable at the backup path.
    renameSync(target, backup);
    writeFileSync(target, scrubbed);
    files.push({ path: name, backupPath, scrubbedSha256: sha256(scrubbed) });
  }
  journal.dotenv = { open: files.length > 0, files };
  writeJournal(root, journal);
  console.log(`dotenv-swap: swapped ${files.length} file(s): ${files.map((f) => f.path).join(', ') || 'none'}`);
  return 0;
}

function cmdDotenvRestore(root) {
  const journal = readJournal(root);
  const result = restoreDotenv(root, journal);
  writeJournal(root, journal);
  if (result.failures.length > 0) {
    console.error('dotenv-restore: FAILED');
    for (const reason of result.failures) console.error(`  ${reason}`);
    return 1;
  }
  console.log(`dotenv-restore: restored ${result.restored.length} file(s)`);
  return 0;
}

async function main(argv) {
  const command = argv[0];
  if (!command || command.startsWith('--')) usage('a command is required');
  const parsed = options(argv.slice(1));
  const root = repoRoot();

  switch (command) {
    case 'round-start': return cmdRoundStart(root);
    case 'env': return cmdEnv(root, parsed);
    case 'watchers': return cmdWatchers(parsed);
    case 'escape-test-name': {
      const name = parsed._[0] ?? parsed.name;
      if (typeof name !== 'string') usage('escape-test-name needs -- <name>');
      console.log(escapeTestName(name));
      return 0;
    }
    case 'assert-one-test': return cmdAssertOneTest(parsed);
    case 'mutate': return cmdMutate(root, parsed);
    case 'run': return cmdRun(root, parsed);
    case 'reap': return cmdReap(root);
    case 'finalize': return cmdFinalize(root);
    case 'dotenv-swap': return cmdDotenvSwap(root, parsed);
    case 'dotenv-restore': return cmdDotenvRestore(root);
    case 'status': {
      console.log(JSON.stringify(readJournal(root), null, 2));
      return 0;
    }
    default: return usage(`unknown command '${command}'`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(`mutation-runner: ${error.message}`);
    process.exit(1);
  }
}
