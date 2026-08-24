// Single owner of the merged /feature run snapshot.
//
// Every reader — the terminal progress block, the live view server, and the
// published snapshot — builds its view from buildSnapshot(). No caller
// re-derives a fact from a raw file. Ownership is strict:
//
//   .feature/state.json          phase, branch, SHAs, review round counters
//   .feature/gate-status.json    repository gate result
//   .feature/codex-*.json        gate fingerprint freshness
//   .feature/intake.json         scope contract
//   .feature/progress.json       step ladder + tracer bullets (this skill)
//   .feature/review-transcript.jsonl  Claude <-> Codex review turns
//   .feature/live/server.json    live view server registration
//
// progress.json stores ONLY what no other file owns. Phase, branch and review
// round counts are read from state.json every time, never copied.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const STEPS = [
  { id: 'orient', label: 'orient & classify' },
  { id: 'intake', label: 'intake locked' },
  { id: 'armed', label: 'worktree armed' },
  { id: 'plan', label: 'plan approved' },
  { id: 'execute', label: 'execute tracers' },
  { id: 'gate', label: 'verified gate' },
  { id: 'review', label: 'review' },
  { id: 'ready', label: 'review-ready' },
];

export const STEP_IDS = STEPS.map((step) => step.id);
export const STEP_STATUSES = ['pending', 'active', 'done', 'skipped', 'blocked'];

const CODEX_STATE_ROOT = join(
  homedir(),
  '.claude/plugins/data/codex-openai-codex/state',
);
const CODEX_LOG_TAIL_LINES = 60;
const FINGERPRINT_TTL_MS = 10_000;

const fingerprintCache = new Map();

export function repoRoot(cwd = process.cwd()) {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

export function featureDir(root) {
  return join(root, '.feature');
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function tailLines(path, count) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim());
  return lines.slice(-count);
}

// ---------------------------------------------------------------- gate state

function gateState(root, { skipFingerprint = false } = {}) {
  const dir = featureDir(root);
  const gate = readJson(join(dir, 'gate-status.json'));
  if (!gate) return { status: 'absent', label: 'not run' };
  if (gate.passed !== true) {
    return { status: 'red', label: 'red', ranAt: gate.ranAt ?? gate.completedAt ?? null };
  }
  if (!existsSync(join(dir, 'codex-gate-fingerprint.json'))) {
    return { status: 'unfingerprinted', label: 'green, no fingerprint' };
  }
  if (skipFingerprint) return { status: 'green', label: 'green' };

  const cached = fingerprintCache.get(root);
  if (cached && Date.now() - cached.at < FINGERPRINT_TTL_MS) return cached.value;

  let value;
  try {
    execFileSync(
      'node',
      [join(root, '.agents/skills/feature/scripts/gate-fingerprint.mjs'), 'check'],
      { cwd: root, stdio: 'ignore' },
    );
    value = { status: 'current', label: 'green, fingerprint current' };
  } catch {
    value = { status: 'stale', label: 'stale (edits since fingerprint)' };
  }
  fingerprintCache.set(root, { at: Date.now(), value });
  return value;
}

// --------------------------------------------------------------- codex jobs

// Resolve the codex-companion state directory for a workspace without
// depending on how the companion hashes the directory name.
export function findCodexWorkspaceDir(workspaceRoot) {
  if (!existsSync(CODEX_STATE_ROOT)) return null;
  for (const entry of readdirSync(CODEX_STATE_ROOT)) {
    const statePath = join(CODEX_STATE_ROOT, entry, 'state.json');
    const state = readJson(statePath);
    const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
    if (jobs.some((job) => job.workspaceRoot === workspaceRoot)) {
      return join(CODEX_STATE_ROOT, entry);
    }
  }
  return null;
}

export function listCodexJobs(workspaceRoot) {
  const dir = findCodexWorkspaceDir(workspaceRoot);
  if (!dir) return [];
  const state = readJson(join(dir, 'state.json'), { jobs: [] });
  return (state.jobs ?? [])
    .filter((job) => job.workspaceRoot === workspaceRoot)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// The companion nests the model's own output one level down at
// `result.result` ({verdict, summary, findings, next_steps}); `result` itself
// is the companion's job envelope. Read the inner object first and fall back
// to the envelope so an older job shape still renders.
function readCodexJob(jobId, statusFile, logFile) {
  const job = readJson(statusFile);
  if (!job) return { id: jobId, status: 'missing', log: [] };

  const model = job.result?.result ?? job.result ?? {};
  const findings = Array.isArray(model.findings) ? model.findings : [];

  return {
    id: job.id ?? jobId,
    kind: job.kindLabel ?? job.kind ?? 'codex',
    title: job.title ?? 'Codex',
    status: job.status ?? 'unknown',
    phase: job.phase ?? null,
    startedAt: job.startedAt ?? job.createdAt ?? null,
    completedAt: job.completedAt ?? null,
    verdict: model.verdict ?? null,
    summary: model.summary ?? job.summary ?? null,
    findings: findings.map((finding, index) => ({
      ref: finding.id ?? `C${index + 1}`,
      severity: finding.severity ?? finding.priority ?? null,
      title: finding.title ?? finding.summary ?? '',
      location: codexLocation(finding),
      confidence: typeof finding.confidence === 'number' ? finding.confidence : null,
    })),
    log: tailLines(logFile ?? job.logFile, CODEX_LOG_TAIL_LINES),
  };
}

function codexLocation(finding) {
  if (finding.location) return finding.location;
  if (!finding.file) return null;
  if (finding.line_start == null) return finding.file;
  const end =
    finding.line_end != null && finding.line_end !== finding.line_start
      ? `-${finding.line_end}`
      : '';
  return `${finding.file}:${finding.line_start}${end}`;
}

// -------------------------------------------------------------- step ladder

function stepLadder(progress, state, transcript) {
  const stored = progress?.steps ?? {};
  const tracers = Array.isArray(progress?.tracers) ? progress.tracers : [];
  const tracersDone = tracers.filter((tracer) => tracer.status === 'done').length;
  const activeTracer = tracers.find((tracer) => tracer.status === 'active') ?? null;

  const rounds = transcript.filter((entry) => entry.kind === 'round-start').length;
  const planRounds = state?.planReviewRounds ?? 0;
  const branchRounds = state?.branchReviewRounds ?? 0;

  return STEPS.map((step, index) => {
    const entry = stored[step.id] ?? {};
    const status = STEP_STATUSES.includes(entry.status) ? entry.status : 'pending';
    let note = entry.note ?? '';

    if (step.id === 'execute' && tracers.length > 0) {
      const suffix = activeTracer ? ` · ${activeTracer.id} in progress` : '';
      note = `${tracersDone}/${tracers.length}${suffix}`;
    }
    // Round counters are only meaningful once the step has been entered.
    if (step.id === 'plan' && planRounds > 0 && !note && status !== 'pending') {
      note = `${planRounds} skeptic round${planRounds === 1 ? '' : 's'}`;
    }
    if (step.id === 'review' && branchRounds > 0 && !note && status !== 'pending') {
      note = `${branchRounds} review round${branchRounds === 1 ? '' : 's'}`;
    }

    let fraction = 0;
    if (status === 'done' || status === 'skipped') fraction = 1;
    else if (status === 'active') {
      fraction =
        step.id === 'execute' && tracers.length > 0
          ? tracersDone / tracers.length
          : 0.5;
    }

    return {
      index,
      id: step.id,
      label: step.label,
      status,
      note,
      fraction,
      at: entry.at ?? null,
    };
  }).map((step) => ({ ...step, rounds }));
}

// ------------------------------------------------------------------ rounds

function rollupRounds(transcript, codexJobs) {
  const byRound = new Map();
  const ensure = (round) => {
    if (!byRound.has(round)) {
      byRound.set(round, {
        round,
        axis: null,
        verdict: null,
        startedAt: null,
        endedAt: null,
        turns: [],
        findings: [],
      });
    }
    return byRound.get(round);
  };

  let current = 0;
  for (const entry of transcript) {
    const round = entry.round ?? current;
    switch (entry.kind) {
      case 'round-start': {
        current = entry.round ?? current + 1;
        const bucket = ensure(current);
        bucket.axis = entry.axis ?? bucket.axis;
        bucket.startedAt = entry.ts;
        break;
      }
      case 'round-end': {
        const bucket = ensure(round);
        bucket.verdict = entry.verdict ?? null;
        bucket.endedAt = entry.ts;
        break;
      }
      case 'turn':
        ensure(round).turns.push({
          kind: 'turn',
          ts: entry.ts,
          actor: entry.actor,
          text: entry.text,
        });
        break;
      case 'codex-job': {
        const bucket = ensure(round);
        const job = codexJobs.get(entry.jobId);
        bucket.turns.push({
          kind: 'codex-job',
          ts: entry.ts,
          actor: 'codex',
          axis: entry.axis ?? bucket.axis,
          job: job ?? { id: entry.jobId, status: 'missing', log: [] },
        });
        break;
      }
      case 'finding': {
        const bucket = ensure(round);
        bucket.findings.push({
          id: entry.id,
          severity: entry.severity ?? null,
          title: entry.title ?? '',
          location: entry.location ?? null,
          verdict: null,
          reason: null,
          ts: entry.ts,
        });
        break;
      }
      case 'triage': {
        // A triage settles exactly one finding. Matching every round that held
        // the id let a later round's verdict overwrite an earlier one, because
        // reviewers restart numbering at F1 each round — round 1's REJECT was
        // published as ACCEPT. Bind to the triage's own round, else the most
        // recent earlier round carrying that id, so a late triage still lands.
        const bucket = [...byRound.values()]
          .filter((item) => item.round <= round && item.findings.some((f) => f.id === entry.id))
          .sort((a, b) => b.round - a.round)[0];
        if (bucket) {
          const finding = bucket.findings.find((item) => item.id === entry.id);
          finding.verdict = entry.verdict;
          finding.reason = entry.reason ?? null;
          bucket.turns.push({
            kind: 'triage',
            ts: entry.ts,
            actor: 'claude',
            id: entry.id,
            verdict: entry.verdict,
            reason: entry.reason ?? null,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

// ----------------------------------------------------------------- snapshot

export function buildSnapshot(root = repoRoot(), options = {}) {
  const dir = featureDir(root);
  const state = readJson(join(dir, 'state.json'));
  const intake = readJson(join(dir, 'intake.json'));
  const progress = readJson(join(dir, 'progress.json'));
  const transcript = readJsonl(join(dir, 'review-transcript.jsonl'));
  const live = readJson(join(dir, 'live', 'server.json'));

  const codexJobs = new Map();
  for (const entry of transcript) {
    if (entry.kind !== 'codex-job' || codexJobs.has(entry.jobId)) continue;
    codexJobs.set(entry.jobId, readCodexJob(entry.jobId, entry.statusFile, entry.logFile));
  }

  const steps = stepLadder(progress, state, transcript);
  const percent = Math.round(
    (steps.reduce((total, step) => total + step.fraction, 0) / STEPS.length) * 100,
  );
  const rounds = rollupRounds(transcript, codexJobs);
  const findings = rounds.flatMap((round) =>
    round.findings.map((finding) => ({ ...finding, round: round.round })),
  );

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    active: Boolean(state || progress),
    root,
    branch: state?.branch ?? null,
    phase: state?.phase ?? null,
    headSha: state?.headSha ?? null,
    baseSha: state?.baseSha ?? null,
    classification: {
      size: progress?.size ?? intake?.size ?? null,
      risk: progress?.risk ?? intake?.risk ?? null,
      surface: progress?.surface ?? intake?.surface ?? null,
    },
    title: intake?.title ?? intake?.summary ?? null,
    percent,
    steps,
    tracers: Array.isArray(progress?.tracers) ? progress.tracers : [],
    gate: gateState(root, options),
    reviewRounds: {
      plan: state?.planReviewRounds ?? 0,
      branch: state?.branchReviewRounds ?? 0,
    },
    rounds,
    findings,
    live: live ?? null,
  };
}

// --------------------------------------------------------- terminal render

const SYMBOL = {
  done: '✓',
  active: '▸',
  pending: '○',
  skipped: '–',
  blocked: '✗',
};

const BAR_WIDTH = 24;

export function renderTerminal(snapshot) {
  if (!snapshot.active) {
    return '/feature · no run state in this worktree (.feature/ is empty)';
  }

  const { size, risk, surface } = snapshot.classification;
  const lane = [size, risk].filter(Boolean).join('·');
  const header = ['/feature', snapshot.branch ?? '(no branch)', lane || null, surface]
    .filter(Boolean)
    .join(' · ');

  const filled = Math.round((snapshot.percent / 100) * BAR_WIDTH);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;

  const labelWidth = Math.max(...STEPS.map((step) => step.label.length));
  const lines = snapshot.steps.map((step) => {
    const left = ` ${SYMBOL[step.status]} ${step.index} ${step.label.padEnd(labelWidth)}`;
    return step.note ? `${left}  ${step.note}` : left.trimEnd();
  });

  const footer = [` gate: ${snapshot.gate.label}`];
  if (snapshot.live?.url) {
    const openRound = snapshot.rounds.find((round) => !round.verdict);
    const detail = openRound
      ? `round ${openRound.round} open`
      : `${snapshot.rounds.length} round${snapshot.rounds.length === 1 ? '' : 's'}`;
    footer.push(` live: ${snapshot.live.url}  (${detail}, ${snapshot.findings.length} findings)`);
  }

  return [header, '', `[${bar}] ${String(snapshot.percent).padStart(3)}%`, '', ...lines, '', ...footer].join(
    '\n',
  );
}
