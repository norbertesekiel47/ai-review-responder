#!/usr/bin/env node
// queue-state.mjs — the /queue-run state controller.
//
// Owns the invariants an instruction-only skill cannot guarantee (each was a
// Codex plan-review finding before it was code):
//   - EXCLUSIVE per-run lock, lease-based. A PID cannot identify the owner:
//     the controller is a SESSION whose tool calls are short-lived processes,
//     so a PID-liveness rule would mark every lock stale the moment the
//     acquiring process exits. A lease + secret token is the session-shaped
//     equivalent; the acquiring PID is recorded for diagnostics only.
//   - GLOBAL reservation lock around every read-check-write on the SHARED
//     reservations.json — the per-run lock cannot stop two runs from
//     reserving the same surface.
//   - Reservations PERSIST ACROSS RUNS and release only with a controller
//     attestation (--verified merged|closed|abandoned): releasing at run end
//     would let the next run execute the overlap against unchanged main.
//   - Strict input validation: run ids allow no `/` or `..` (path
//     traversal); branch names must pass `git check-ref-format` AND carry
//     the run-owned `queue/<run-id>/` prefix.
//   - Atomic state writes (temp + rename) and an append-only journal, so a
//     crash between "intent" and "done" is recoverable from the journal.
//
// State layout under $QUEUE_RUN_HOME (default ~/.claude/queue-run):
//   <run-id>/state.json     — the index (git reality stays the truth)
//   <run-id>/journal.jsonl  — append-only transitions
//   <run-id>/run.lock       — lease lock {token, pid, expiresAtMs}
//   reservations.json       — cross-run surface reservations
//   reservations.lock       — short-lived global lock for the file above

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const HOME = process.env.QUEUE_RUN_HOME ?? join(homedir(), '.claude', 'queue-run');
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVATION_LOCK_STALE_MS = 60_000;
const DEFAULT_LEASE_SECONDS = 14_400;
const VERIFIED_RELEASE_STATES = new Set(['merged', 'closed', 'abandoned']);

// Exit codes: 0 ok · 1 usage/validation · 2 refused (overlap/budget) · 3 lock held.
const die = (code, message) => {
  console.error(`queue-state: ${message}`);
  process.exit(code);
};

const args = process.argv.slice(2);
const command = args.shift();

/** Positional args first, then `--flag value` pairs, in any order. */
function parseArgs(rest) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      flags[arg.slice(2)] = rest[i + 1];
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}
const { positional, flags } = parseArgs(args);

const requireRunId = (value) => {
  if (!value || !RUN_ID_RE.test(value)) {
    die(1, `invalid run id '${value ?? ''}' (want ${RUN_ID_RE}; no '/' or '..').`);
  }
  return value;
};

const runDir = (runId) => join(HOME, runId);
const statePath = (runId) => join(runDir(runId), 'state.json');
const journalPath = (runId) => join(runDir(runId), 'journal.jsonl');
const runLockPath = (runId) => join(runDir(runId), 'run.lock');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Atomic write: same-directory temp + rename, so readers never see a torn file. */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function appendJournal(runId, entry) {
  appendFileSync(journalPath(runId), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

// --- run lock (lease + token) ------------------------------------------------

function acquireRunLock(runId, leaseSeconds) {
  const path = runLockPath(runId);
  const lock = {
    schema: 1,
    token: randomBytes(16).toString('hex'),
    pid: process.pid,
    expiresAtMs: Date.now() + leaseSeconds * 1_000,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, JSON.stringify(lock), { flag: 'wx' });
      return lock.token;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readJson(path);
      if (holder.expiresAtMs > Date.now()) {
        die(3, `run '${runId}' is locked (expires ${new Date(holder.expiresAtMs).toISOString()}).`);
      }
      unlinkSync(path); // provably stale: the lease expired — reclaim and retry once
    }
  }
  die(3, `could not acquire run lock for '${runId}'.`);
}

function requireRunToken(runId, token) {
  const path = runLockPath(runId);
  if (!existsSync(path)) die(3, `run '${runId}' holds no lock — acquire one first.`);
  const holder = readJson(path);
  if (!token || holder.token !== token) die(3, `bad or missing --token for run '${runId}'.`);
  if (holder.expiresAtMs <= Date.now()) die(3, `run lock for '${runId}' has expired — re-acquire.`);
  return holder;
}

// --- global reservation lock -------------------------------------------------

const reservationsPath = () => join(HOME, 'reservations.json');
const reservationsLockPath = () => join(HOME, 'reservations.lock');

/** Held only across one read-check-write, so age-based staleness is sound here. */
function withReservationLock(fn) {
  const path = reservationsLockPath();
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, atMs: Date.now() }), { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readJson(path);
      if (Date.now() - holder.atMs > RESERVATION_LOCK_STALE_MS) {
        unlinkSync(path);
        continue;
      }
      if (Date.now() > deadline) die(3, 'global reservation lock is held; try again.');
      spawnSync('sleep', ['0.1']);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(path, { force: true });
  }
}

const readReservations = () =>
  existsSync(reservationsPath()) ? readJson(reservationsPath()) : { schema: 1, reservations: [] };

const normalizePath = (p) => p.replace(/^\.\//, '').replace(/\/+$/, '');

const pathsOverlap = (a, b) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

function findOverlaps(paths, reservations) {
  const wanted = paths.map(normalizePath);
  return reservations.filter((entry) =>
    entry.paths.some((held) => wanted.some((want) => pathsOverlap(normalizePath(held), want))),
  );
}

// --- commands ----------------------------------------------------------------

function cmdInit() {
  const runId = requireRunId(positional[0]);
  const ceiling = Number(flags.ceiling ?? 2_000_000);
  if (!Number.isFinite(ceiling) || ceiling <= 0) die(1, 'invalid --ceiling.');
  if (existsSync(statePath(runId))) die(1, `run '${runId}' already exists.`);
  mkdirSync(runDir(runId), { recursive: true });
  writeJsonAtomic(statePath(runId), { schema: 1, runId, ceiling, spent: 0, issues: {} });
  writeFileSync(journalPath(runId), '');
  console.log(JSON.stringify({ ok: true, runId, ceiling }));
}

function cmdLock() {
  const runId = requireRunId(positional[0]);
  if (!existsSync(runDir(runId))) die(1, `run '${runId}' does not exist — init first.`);
  const lease = Number(flags['lease-seconds'] ?? DEFAULT_LEASE_SECONDS);
  if (!Number.isFinite(lease) || lease < 0) die(1, 'invalid --lease-seconds.');
  console.log(JSON.stringify({ token: acquireRunLock(runId, lease) }));
}

function cmdRefresh() {
  const runId = requireRunId(positional[0]);
  const holder = requireRunToken(runId, flags.token);
  const lease = Number(flags['lease-seconds'] ?? DEFAULT_LEASE_SECONDS);
  holder.expiresAtMs = Date.now() + lease * 1_000;
  writeJsonAtomic(runLockPath(runId), holder);
  console.log(JSON.stringify({ ok: true }));
}

function cmdUnlock() {
  const runId = requireRunId(positional[0]);
  requireRunToken(runId, flags.token);
  unlinkSync(runLockPath(runId));
  console.log(JSON.stringify({ ok: true }));
}

function cmdTransition() {
  const runId = requireRunId(positional[0]);
  requireRunToken(runId, flags.token);
  const issue = flags.issue;
  if (!issue) die(1, 'transition requires --issue.');
  let patch;
  try {
    patch = JSON.parse(flags.patch ?? '');
  } catch {
    die(1, 'transition requires --patch with valid JSON.');
  }
  const state = readJson(statePath(runId));
  state.issues[issue] = { ...state.issues[issue], ...patch };
  appendJournal(runId, { kind: 'transition', issue, patch });
  writeJsonAtomic(statePath(runId), state);
  console.log(JSON.stringify({ ok: true, issue }));
}

function cmdJournal() {
  const runId = requireRunId(positional[0]);
  requireRunToken(runId, flags.token);
  let entry;
  try {
    entry = JSON.parse(flags.entry ?? '');
  } catch {
    die(1, 'journal requires --entry with valid JSON.');
  }
  appendJournal(runId, { kind: 'note', ...entry });
  console.log(JSON.stringify({ ok: true }));
}

function cmdSpend() {
  const runId = requireRunId(positional[0]);
  requireRunToken(runId, flags.token);
  const add = Number(flags.add);
  if (!Number.isFinite(add) || add < 0) die(1, 'spend requires a non-negative --add.');
  const state = readJson(statePath(runId));
  state.spent += add;
  appendJournal(runId, { kind: 'spend', add, spent: state.spent });
  writeJsonAtomic(statePath(runId), state);
  console.log(JSON.stringify({ ok: true, spent: state.spent }));
}

function cmdBudget() {
  const runId = requireRunId(positional[0]);
  const estimate = Number(flags.estimate);
  if (!Number.isFinite(estimate) || estimate < 0) die(1, 'budget requires a non-negative --estimate.');
  const state = readJson(statePath(runId));
  const remaining = state.ceiling - state.spent;
  if (estimate > remaining) {
    console.log(JSON.stringify({ ok: false, remaining, estimate }));
    process.exit(2);
  }
  console.log(JSON.stringify({ ok: true, remaining, estimate }));
}

function requireValidBranch(runId, branch) {
  if (!branch) die(1, 'missing --branch.');
  const check = spawnSync('git', ['check-ref-format', '--branch', branch], { encoding: 'utf8' });
  if (check.status !== 0) die(1, `branch '${branch}' fails git check-ref-format.`);
  if (!branch.startsWith(`queue/${runId}/`)) {
    die(1, `branch '${branch}' lacks the run-owned prefix 'queue/${runId}/'.`);
  }
  return branch;
}

function cmdValidateBranch() {
  const runId = requireRunId(positional[0]);
  requireValidBranch(runId, positional[1]);
  console.log(JSON.stringify({ ok: true }));
}

function cmdReserve() {
  const runId = requireRunId(positional[0]);
  requireRunToken(runId, flags.token);
  const issue = flags.issue;
  const branch = requireValidBranch(runId, flags.branch);
  const paths = (flags.paths ?? '').split(',').map(normalizePath).filter(Boolean);
  if (!issue || paths.length === 0) die(1, 'reserve requires --issue and --paths.');
  // process.exit skips finally blocks, so never exit INSIDE the lock — the
  // lock file would leak and block every caller for the staleness window.
  const overlaps = withReservationLock(() => {
    const store = readReservations();
    const found = findOverlaps(paths, store.reservations);
    if (found.length > 0) return found;
    store.reservations.push({ runId, issue, branch, paths, pr: null });
    writeJsonAtomic(reservationsPath(), store);
    return [];
  });
  if (overlaps.length > 0) {
    console.log(JSON.stringify({ ok: false, overlaps }));
    process.exit(2);
  }
  appendJournal(runId, { kind: 'reserve', issue, branch, paths });
  console.log(JSON.stringify({ ok: true, branch }));
}

function cmdSetPr() {
  const runId = requireRunId(flags['run-id']);
  requireRunToken(runId, flags.token);
  const pr = Number(flags.pr);
  if (!flags.branch || !Number.isFinite(pr)) die(1, 'set-pr requires --branch and --pr.');
  const found = withReservationLock(() => {
    const store = readReservations();
    const entry = store.reservations.find((r) => r.branch === flags.branch);
    if (!entry) return false;
    entry.pr = pr;
    writeJsonAtomic(reservationsPath(), store);
    return true;
  });
  if (!found) die(1, `no reservation for branch '${flags.branch}'.`);
  console.log(JSON.stringify({ ok: true }));
}

function cmdRelease() {
  const runId = requireRunId(flags['run-id']);
  requireRunToken(runId, flags.token);
  const verified = flags.verified;
  if (!VERIFIED_RELEASE_STATES.has(verified ?? '')) {
    die(1, `release requires --verified ${[...VERIFIED_RELEASE_STATES].join('|')} (a controller attestation from 'gh pr view').`);
  }
  if (!flags.branch) die(1, 'release requires --branch.');
  const removed = withReservationLock(() => {
    const store = readReservations();
    const before = store.reservations.length;
    store.reservations = store.reservations.filter((r) => r.branch !== flags.branch);
    if (store.reservations.length === before) return false;
    writeJsonAtomic(reservationsPath(), store);
    return true;
  });
  if (!removed) die(1, `no reservation for branch '${flags.branch}'.`);
  appendJournal(runId, { kind: 'release', branch: flags.branch, verified });
  console.log(JSON.stringify({ ok: true }));
}

function cmdCheckOverlap() {
  const paths = (flags.paths ?? '').split(',').map(normalizePath).filter(Boolean);
  if (paths.length === 0) die(1, 'check-overlap requires --paths.');
  const overlaps = withReservationLock(() => findOverlaps(paths, readReservations().reservations));
  if (overlaps.length > 0) {
    console.log(JSON.stringify({ ok: false, overlaps }));
    process.exit(2);
  }
  console.log(JSON.stringify({ ok: true }));
}

function cmdVerifyRepo() {
  const expect = flags.expect;
  if (!expect) die(1, 'verify-repo requires --expect.');
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  if (remote.status !== 0) die(1, 'git remote get-url origin failed — not a repo?');
  if (!remote.stdout.trim().includes(expect)) {
    die(1, `origin '${remote.stdout.trim()}' does not match expected '${expect}'.`);
  }
  console.log(JSON.stringify({ ok: true }));
}

const COMMANDS = {
  init: cmdInit,
  lock: cmdLock,
  refresh: cmdRefresh,
  unlock: cmdUnlock,
  transition: cmdTransition,
  journal: cmdJournal,
  spend: cmdSpend,
  budget: cmdBudget,
  reserve: cmdReserve,
  'set-pr': cmdSetPr,
  release: cmdRelease,
  'check-overlap': cmdCheckOverlap,
  'validate-branch': cmdValidateBranch,
  'verify-repo': cmdVerifyRepo,
};

const handler = COMMANDS[command ?? ''];
if (!handler) die(1, `unknown command '${command ?? ''}'. Commands: ${Object.keys(COMMANDS).join(', ')}.`);
mkdirSync(HOME, { recursive: true });
handler();
