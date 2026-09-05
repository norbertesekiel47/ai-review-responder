// Token cost per /feature step, derived from the harness transcripts.
//
// The ladder (.feature/progress.json) records WHEN each step closed. The
// harness records HOW MUCH every model turn cost in
// ~/.claude/projects/<slug>/<session>.jsonl. Joining the two gives a per-step
// token bill without any new bookkeeping: a step's cost is every assistant
// turn between the previous step's close and its own.
//
// Owned facts: none. This module reads progress.json and the transcripts and
// writes only .feature/phase-cost.json, a derived cache the handoff may cite.
//
// Limits, stated so a reader does not over-trust the numbers:
//   - Steps 0-1 run in the parent checkout, whose transcript directory is
//     shared with every other session on the repo. When .feature/sessions
//     (written by the edit-surface guard) exists, only those sessions count;
//     otherwise every session whose cwd is the root counts and the row says
//     how many sessions it summed.
//   - Subagent turns land in the same transcript and are included. Codex
//     rounds are not: they run in another tool and are not in these files.
//   - A transcript entry per content block repeats the message usage; turns
//     are deduplicated by message id.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { STEPS } from './feature-snapshot.mjs';

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

// The harness names a project directory after the cwd with every character
// outside [A-Za-z0-9] replaced by '-'. Observed: /Users/x/RepWorth ->
// -Users-x-RepWorth, and the worktree path the same way.
export function transcriptDirFor(path) {
  return join(PROJECTS_ROOT, path.replace(/[^A-Za-z0-9]/g, '-'));
}

function mainWorktree(root) {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    });
    const first = out.split('\n').find((line) => line.startsWith('worktree '));
    return first ? first.slice('worktree '.length) : root;
  } catch {
    return root;
  }
}

function readSessions(root) {
  const path = join(root, '.feature', 'sessions');
  if (!existsSync(path)) return null;
  const ids = readFileSync(path, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function emptyBucket() {
  return { input: 0, cacheRead: 0, cacheCreate: 0, output: 0, turns: 0, sessions: new Set() };
}

function addUsage(bucket, usage, sessionId) {
  bucket.input += usage.input_tokens ?? 0;
  bucket.cacheRead += usage.cache_read_input_tokens ?? 0;
  bucket.cacheCreate += usage.cache_creation_input_tokens ?? 0;
  bucket.output += usage.output_tokens ?? 0;
  bucket.turns += 1;
  if (sessionId) bucket.sessions.add(sessionId);
}

// Every assistant turn (deduplicated by message id) from transcripts written
// after `since`, restricted to the given roots and, when known, sessions.
function collectTurns({ roots, since, sessions }) {
  const rootSet = new Set(roots);
  const seen = new Set();
  const turns = [];
  for (const root of roots) {
    const dir = transcriptDirFor(root);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(dir, name);
      if (statSync(file).mtimeMs < since - 60_000) continue;
      const sessionId = name.slice(0, -'.jsonl'.length);
      if (sessions && !sessions.has(sessionId)) continue;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"usage"')) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.type !== 'assistant' || !entry.message?.usage || !entry.timestamp) continue;
        if (entry.cwd && !rootSet.has(entry.cwd)) continue;
        const id = entry.message.id ?? `${sessionId}:${entry.uuid ?? line.length}`;
        if (seen.has(id)) continue;
        seen.add(id);
        turns.push({
          at: Date.parse(entry.timestamp),
          usage: entry.message.usage,
          sessionId: entry.sessionId ?? sessionId,
        });
      }
    }
  }
  return turns.sort((a, b) => a.at - b.at);
}

function windowsFrom(progress, now) {
  const steps = progress?.steps ?? {};
  const windows = [];
  let previous = null;
  for (const step of STEPS) {
    const record = steps[step.id];
    if (!record || record.status === 'pending') continue;
    const closedAt = record.at ? Date.parse(record.at) : null;
    if (record.status === 'skipped') {
      previous = closedAt ?? previous;
      continue;
    }
    if (record.status === 'done' && closedAt) {
      // The first closed step (orient, at `init`) has no earlier boundary, so
      // its window is empty: work before `init` is not measured rather than
      // guessed from an unbounded start.
      windows.push({ id: step.id, label: step.label, from: previous ?? closedAt, to: closedAt, open: false });
      previous = closedAt;
    } else {
      // active or blocked: cost so far
      windows.push({ id: step.id, label: step.label, from: previous, to: now, open: true });
    }
  }
  return windows;
}

export function phaseCosts(root, progress, { now = Date.now() } = {}) {
  const windows = windowsFrom(progress, now);
  if (progress?.runtime === 'codex' || (!progress?.runtime && process.env.CODEX_THREAD_ID)) {
    return {
      computedAt: new Date(now).toISOString(),
      availability: 'unavailable',
      reason: 'Native Codex per-phase usage is not exposed by this helper.',
      roots: [root],
      rows: windows.map((w) => ({ id: w.id, label: w.label, open: w.open, availability: 'unavailable' })),
      total: null,
    };
  }
  const runStart = windows[0]?.from ?? now;
  const roots = [...new Set([root, mainWorktree(root)])];
  const turns = collectTurns({ roots, since: runStart, sessions: readSessions(root) });

  const rows = windows.map((w) => {
    const bucket = emptyBucket();
    for (const turn of turns) {
      if (turn.at <= w.from) continue;
      if (turn.at > w.to) continue;
      addUsage(bucket, turn.usage, turn.sessionId);
    }
    const contextIn = bucket.input + bucket.cacheRead + bucket.cacheCreate;
    return {
      id: w.id,
      label: w.label,
      open: w.open,
      minutes: Math.round((w.to - w.from) / 60_000),
      turns: bucket.turns,
      sessions: bucket.sessions.size,
      input: bucket.input,
      cacheRead: bucket.cacheRead,
      cacheCreate: bucket.cacheCreate,
      output: bucket.output,
      contextIn,
      cachedShare: contextIn ? Math.round((bucket.cacheRead / contextIn) * 100) : 0,
    };
  });

  const total = rows.reduce(
    (acc, r) => ({ contextIn: acc.contextIn + r.contextIn, output: acc.output + r.output, minutes: acc.minutes + r.minutes }),
    { contextIn: 0, output: 0, minutes: 0 },
  );
  return { computedAt: new Date(now).toISOString(), roots, rows, total };
}

export function writePhaseCosts(root, report) {
  const path = join(root, '.feature', 'phase-cost.json');
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function renderCostRow(row) {
  if (row.availability === 'unavailable') return ` ${row.label}: usage unavailable in native Codex`;
  const flags = [];
  if (row.open) flags.push('so far');
  if (row.sessions > 1) flags.push(`${row.sessions} sessions summed`);
  const tail = flags.length ? `  (${flags.join(', ')})` : '';
  return ` ${row.label.padEnd(16)} ${fmt(row.contextIn).padStart(6)} in (${String(row.cachedShare).padStart(2)}% cached) · ${fmt(row.output).padStart(5)} out · ${String(row.minutes).padStart(3)} min · ${row.turns} turns${tail}`;
}

export function renderCosts(report) {
  if (report.availability === 'unavailable') return ` cost unavailable: ${report.reason}`;
  if (!report.rows.length) return ' cost: no closed steps yet';
  const lines = report.rows.map(renderCostRow);
  lines.push(
    ` ${'total'.padEnd(16)} ${fmt(report.total.contextIn).padStart(6)} in · ${fmt(report.total.output).padStart(5)} out · ${report.total.minutes} min`,
  );
  return lines.join('\n');
}
