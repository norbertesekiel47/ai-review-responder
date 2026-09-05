#!/usr/bin/env node

// Owns .feature/progress.json — the /feature step ladder and tracer bullets.
//
//   progress.mjs init --size <s> --risk <r> --surface <u>
//   progress.mjs carry <parent-repo-root|parent progress.json>
//   progress.mjs step <id> <status> [--note "..."]
//   progress.mjs tracers set "T1 title|T2 title|..."
//   progress.mjs tracer <id> <status> [--note "..."]
//   progress.mjs render
//   progress.mjs json
//
// It stores ONLY the facts no other file owns. Phase, branch, SHAs and review
// round counters stay in .feature/state.json and are read, never copied.

import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import {
  STEPS,
  STEP_IDS,
  STEP_STATUSES,
  buildSnapshot,
  featureDir,
  renderTerminal,
  repoRoot,
} from './lib/feature-snapshot.mjs';
import { phaseCosts, renderCostRow, renderCosts, writePhaseCosts } from './lib/phase-cost.mjs';

const SIZES = ['trivial', 'small', 'standard', 'epic'];
const RISKS = ['normal', 'high'];
const SURFACES = ['ui', 'backend', 'mixed'];
const TRACER_STATUSES = ['pending', 'active', 'done', 'blocked'];

const USAGE = `usage:
  progress.mjs route --size <${SIZES.join('|')}> --risk <${RISKS.join('|')}>
  progress.mjs init --size <${SIZES.join('|')}> --risk <${RISKS.join('|')}> --surface <${SURFACES.join('|')}>
  progress.mjs carry <parent-repo-root|parent progress.json>
  progress.mjs step <${STEP_IDS.join('|')}> <${STEP_STATUSES.join('|')}> [--note "..."]
  progress.mjs tracers set "T1 title|T2 title|..."
  progress.mjs tracer <id> <${TRACER_STATUSES.join('|')}> [--note "..."]
  progress.mjs render
  progress.mjs json
  progress.mjs cost`;

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) fail(`missing value for --${name}`);
      flags[name] = next;
      index += 1;
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

const root = repoRoot();
const dir = featureDir(root);
const progressPath = join(dir, 'progress.json');

function load() {
  if (!existsSync(progressPath)) return null;
  return JSON.parse(readFileSync(progressPath, 'utf8'));
}

function save(progress) {
  mkdirSync(dir, { recursive: true });
  const next = { ...progress, updatedAt: new Date().toISOString() };
  writeFileSync(progressPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function require_(progress) {
  if (!progress) fail('missing .feature/progress.json; run progress.mjs init first');
  return progress;
}

function emptySteps() {
  return Object.fromEntries(STEPS.map((step) => [step.id, { status: 'pending' }]));
}

// Two paths are the same file once symlinks are followed. A path that does not
// exist yet cannot be realpath'd, so fall back to lexical comparison.
function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

const [command, ...rest] = process.argv.slice(2);
const { flags, positional } = parseFlags(rest);

switch (command) {
  case 'route': {
    const { size, risk } = flags;
    if (!SIZES.includes(size)) fail(`--size must be one of ${SIZES.join('|')}`);
    if (!RISKS.includes(risk)) fail(`--risk must be one of ${RISKS.join('|')}`);
    const lane = size === 'epic' ? 'epic' : risk === 'high' || size === 'standard' ? 'guarded' : size;
    console.log(JSON.stringify({
      lane,
      implement: lane !== 'epic',
      arm: lane === 'guarded',
      plan: lane === 'guarded' || lane === 'epic',
      review: lane === 'epic' ? null : lane === 'trivial' ? 'root' : 'independent',
      verification: lane === 'epic' ? [] : lane === 'guarded'
        ? ['bash .agents/skills/feature/scripts/verified-gate.sh --review']
        : ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm build'],
    }, null, 2));
    break;
  }
  case 'init': {
    const { size, risk, surface } = flags;
    if (!SIZES.includes(size)) fail(`--size must be one of ${SIZES.join('|')}`);
    if (!RISKS.includes(risk)) fail(`--risk must be one of ${RISKS.join('|')}`);
    if (!SURFACES.includes(surface)) fail(`--surface must be one of ${SURFACES.join('|')}`);

    const existing = load();
    const runtime = flags.runtime ?? existing?.runtime ?? (process.env.CODEX_THREAD_ID ? 'codex' : 'claude');
    if (!['codex', 'claude'].includes(runtime)) fail('--runtime must be codex or claude');
    const steps = existing?.steps ?? emptySteps();
    // No note: both renderers already show the lane in their own header, so
    // a note here would repeat it beside step 0.
    steps.orient = { status: 'done', note: '', at: new Date().toISOString() };
    if (steps.intake?.status !== 'done') steps.intake = { status: 'active' };

    save({
      version: 1,
      runtime,
      size,
      risk,
      surface,
      steps,
      tracers: existing?.tracers ?? [],
    });
    console.log(renderTerminal(buildSnapshot(root, { skipFingerprint: true })));
    break;
  }

  // Steps 0 and 1 run before the worktree exists, so the ladder starts in the
  // parent checkout. `carry` moves it into the armed worktree, mirroring how
  // feature-setup.sh installs the intake from an outside path.
  case 'carry': {
    const [source] = positional;
    if (!source) fail('carry needs the parent repo root or its progress.json');

    const candidate = resolve(source);
    const sourcePath = existsSync(candidate) && statSync(candidate).isDirectory()
      ? join(candidate, '.feature', 'progress.json')
      : candidate;
    if (!existsSync(sourcePath)) fail(`no progress ladder at ${sourcePath}`);
    // realpath, not resolve: `resolve` does not follow symlinks, and the repo
    // root comes back symlink-resolved from git. On macOS `/tmp` and `/var` are
    // symlinks, so a source that IS this worktree slipped past the guard and
    // the ladder was read and written back with `armed` wrongly forced done.
    if (samePath(sourcePath, progressPath)) {
      fail('carry source and destination are the same worktree');
    }

    const carried = JSON.parse(readFileSync(sourcePath, 'utf8'));
    const runtime = flags.runtime ?? carried.runtime ?? (process.env.CODEX_THREAD_ID ? 'codex' : 'claude');
    if (!['codex', 'claude'].includes(runtime)) fail('--runtime must be codex or claude');
    const steps = { ...emptySteps(), ...(carried.steps ?? {}) };
    steps.armed = { status: 'done', note: 'ARMED', at: new Date().toISOString() };
    if (steps.plan?.status === 'pending') steps.plan = { status: 'active' };

    save({
      version: 1,
      size: carried.size,
      runtime,
      risk: carried.risk,
      surface: carried.surface,
      steps,
      tracers: Array.isArray(carried.tracers) ? carried.tracers : [],
    });
    console.log(renderTerminal(buildSnapshot(root)));
    break;
  }

  case 'step': {
    const [id, status] = positional;
    if (!STEP_IDS.includes(id)) fail(`step id must be one of ${STEP_IDS.join('|')}`);
    if (!STEP_STATUSES.includes(status)) fail(`status must be one of ${STEP_STATUSES.join('|')}`);

    const progress = require_(load());
    const steps = { ...(progress.steps ?? emptySteps()) };
    steps[id] = {
      status,
      note: flags.note ?? (status === 'pending' ? '' : steps[id]?.note ?? ''),
      at: new Date().toISOString(),
    };

    // Advancing a step to done opens the next pending step. The ladder is
    // forward-only by convention; a re-opened step is set explicitly.
    if (status === 'done') {
      const next = STEP_IDS[STEP_IDS.indexOf(id) + 1];
      if (next && steps[next]?.status === 'pending') {
        steps[next] = { ...steps[next], status: 'active', at: new Date().toISOString() };
      }
    }

    const saved = save({ ...progress, steps });
    console.log(renderTerminal(buildSnapshot(root)));

    // A closing step prints its own token bill so the cost of a phase is seen
    // at the boundary, not reconstructed at the end. Best-effort: a missing
    // transcript directory must never block the ladder.
    if (status === 'done') {
      try {
        const report = phaseCosts(root, saved);
        writePhaseCosts(root, report);
        const row = report.rows.find((entry) => entry.id === id);
        if (row) console.log(`\n cost:${renderCostRow(row)}`);
      } catch (error) {
        console.error(`(phase cost unavailable: ${error?.message ?? error})`);
      }
    }
    break;
  }

  case 'cost': {
    const report = phaseCosts(root, require_(load()));
    writePhaseCosts(root, report);
    console.log(renderCosts(report));
    break;
  }

  case 'tracers': {
    const [subcommand, spec] = positional;
    if (subcommand !== 'set') fail(USAGE);
    if (!spec) fail('tracers set needs a "T1 title|T2 title" list');

    const progress = require_(load());
    const tracers = spec
      .split('|')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry, index) => {
        const match = entry.match(/^(T\d+)\s+(.*)$/i);
        const id = match ? match[1].toUpperCase() : `T${index + 1}`;
        const title = match ? match[2] : entry;
        const previous = (progress.tracers ?? []).find((item) => item.id === id);
        return { id, title, status: previous?.status ?? 'pending' };
      });

    save({ ...progress, tracers });
    console.log(renderTerminal(buildSnapshot(root)));
    break;
  }

  case 'tracer': {
    const [id, status] = positional;
    if (!id) fail(USAGE);
    if (!TRACER_STATUSES.includes(status)) {
      fail(`status must be one of ${TRACER_STATUSES.join('|')}`);
    }

    const progress = require_(load());
    const key = id.toUpperCase();
    const tracers = (progress.tracers ?? []).map((tracer) =>
      tracer.id === key
        ? { ...tracer, status, note: flags.note ?? tracer.note }
        : tracer,
    );
    if (!tracers.some((tracer) => tracer.id === key)) fail(`unknown tracer ${key}`);

    save({ ...progress, tracers });
    console.log(renderTerminal(buildSnapshot(root)));
    break;
  }

  case 'render':
    console.log(renderTerminal(buildSnapshot(root)));
    break;

  case 'json':
    console.log(JSON.stringify(buildSnapshot(root), null, 2));
    break;

  default:
    fail(USAGE);
}
