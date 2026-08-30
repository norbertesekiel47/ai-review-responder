#!/usr/bin/env node

// Owns .feature/review-transcript.jsonl — the two-sided Claude <-> Codex
// review record.
//
//   review-log.mjs round-start --axis <axis> [--round N]
//   review-log.mjs say --text "..." [--actor claude] [--round N]
//   review-log.mjs attach-codex --latest | --job <jobId> [--axis <axis>]
//   review-log.mjs finding --id F1 --severity high --title "..." [--at file:line]
//   review-log.mjs triage --id F1 --verdict ACCEPT|REJECT --reason "..."
//   review-log.mjs round-end --verdict APPROVED|REVISE [--round N]
//   review-log.mjs render
//
// Codex turns are NOT copied here. `attach-codex` records a pointer to the
// codex-companion job files; the live view reads verdict, findings and log
// tail from those files so the companion stays the single owner of its own
// output. Claude's turns and triage verdicts have no other sink, so they are
// written here.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildSnapshot,
  featureDir,
  listCodexJobs,
  repoRoot,
} from './lib/feature-snapshot.mjs';

const AXES = [
  'plan-skeptic',
  'spec-correctness',
  'standards-maintainability',
  'security',
  'database',
  'billing',
  'async',
  'ui',
];
const VERDICTS = ['APPROVED', 'REVISE'];
const TRIAGE = ['ACCEPT', 'REJECT'];
const SEVERITIES = ['high', 'medium', 'low'];

const USAGE = `usage:
  review-log.mjs round-start --axis <${AXES.join('|')}> [--round N]
  review-log.mjs say --text "..." [--actor claude|codex] [--round N]
  review-log.mjs attach-codex --latest | --job <jobId> [--axis <axis>] [--round N]
  review-log.mjs finding --id F1 --severity <${SEVERITIES.join('|')}> --title "..." [--at file:line] [--round N]
  review-log.mjs triage --id F1 --verdict <${TRIAGE.join('|')}> --reason "..."
  review-log.mjs round-end --verdict <${VERDICTS.join('|')}> [--round N]
  review-log.mjs render`;

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return flags;
}

const root = repoRoot();
const dir = featureDir(root);
const transcriptPath = join(dir, 'review-transcript.jsonl');

function entries() {
  if (!existsSync(transcriptPath)) return [];
  return readFileSync(transcriptPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// The open round is the highest round-start with no matching round-end.
function currentRound(all) {
  const started = new Set(
    all.filter((entry) => entry.kind === 'round-start').map((entry) => entry.round),
  );
  const ended = new Set(
    all.filter((entry) => entry.kind === 'round-end').map((entry) => entry.round),
  );
  const open = [...started].filter((round) => !ended.has(round));
  if (open.length > 0) return Math.max(...open);
  return started.size > 0 ? Math.max(...started) : 1;
}

function append(entry) {
  mkdirSync(dir, { recursive: true });
  const all = entries();
  const record = {
    seq: all.length + 1,
    ts: new Date().toISOString(),
    ...entry,
  };
  appendFileSync(transcriptPath, `${JSON.stringify(record)}\n`);
  return record;
}

// The feedback loop: every ACCEPT verdict lands in a durable per-axis
// checklist that future reviews on that axis receive as input. Two months of
// runs kept re-finding the same defect classes (tests that pass before the
// fix, mocks that blind a suite, silent live-DB skips) because each review
// started from zero. docs/reviews/ is committed, so the checklist rides the
// branch PR onto main and accumulates across features.
function recordAcceptedFinding(finding, reason) {
  const roundStart = entries()
    .filter((entry) => entry.kind === 'round-start' && entry.round === finding.round)
    .pop();
  const axis = roundStart?.axis;
  if (!axis) return null;

  const checklistDir = join(root, 'docs', 'reviews', 'finding-checklists');
  const checklistPath = join(checklistDir, `${axis}.md`);
  mkdirSync(checklistDir, { recursive: true });
  if (!existsSync(checklistPath)) {
    writeFileSync(checklistPath, [
      `# Accepted findings — ${axis}`,
      '',
      'Defect classes a /feature review ACCEPTED on a real branch. Reviewers on',
      'this axis receive this file and check the diff against every line. Lines',
      'are appended by review-log.mjs triage; edit only to prune entries that no',
      'longer apply.',
      '',
      '',
    ].join('\n'));
  }

  const existing = readFileSync(checklistPath, 'utf8');
  if (finding.title && existing.includes(finding.title)) return { axis, deduped: true };

  let branch = '';
  try {
    branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: root, encoding: 'utf8',
    }).trim();
  } catch { /* detached HEAD: omit the branch */ }

  const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const location = finding.location ? ` (${oneLine(finding.location)})` : '';
  const suffix = [branch, new Date().toISOString().slice(0, 10)]
    .filter(Boolean).join(' · ');
  appendFileSync(
    checklistPath,
    `- [${finding.severity ?? '-'}] ${oneLine(finding.title)}${location} — ${oneLine(reason)} · ${suffix}\n`,
  );
  return { axis, deduped: false };
}

// The live view is a viewer, so its absence never blocks a write — but the
// skill says to start it before the first review round, and the 1008 run
// proved the instruction alone gets skipped. Warn loudly instead.
function liveViewRunning() {
  try {
    const registry = JSON.parse(
      readFileSync(join(dir, 'live', 'server.json'), 'utf8'),
    );
    if (!registry?.pid) return false;
    process.kill(registry.pid, 0);
    return true;
  } catch {
    return false;
  }
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const all = entries();
const round = flags.round ? Number(flags.round) : currentRound(all);

switch (command) {
  case 'round-start': {
    if (!AXES.includes(flags.axis)) fail(`--axis must be one of ${AXES.join('|')}`);
    const started = all
      .filter((entry) => entry.kind === 'round-start')
      .map((entry) => entry.round);
    const next = flags.round ? Number(flags.round) : (started.length ? Math.max(...started) + 1 : 1);
    append({ kind: 'round-start', round: next, axis: flags.axis });
    console.log(`review round ${next} open (${flags.axis})`);
    if (!liveViewRunning()) {
      console.log(
        'note: live view is NOT running — start it: node .agents/skills/feature/scripts/live-view.mjs start',
      );
    }
    break;
  }

  case 'say': {
    if (typeof flags.text !== 'string') fail('--text is required');
    const actor = flags.actor === 'codex' ? 'codex' : 'claude';
    append({ kind: 'turn', round, actor, text: flags.text });
    console.log(`logged ${actor} turn in round ${round}`);
    break;
  }

  case 'attach-codex': {
    const jobs = listCodexJobs(root);
    if (jobs.length === 0) fail(`no codex-companion jobs recorded for ${root}`);

    const job = flags.latest === true || !flags.job
      ? jobs[0]
      : jobs.find((candidate) => candidate.id === flags.job);
    if (!job) fail(`codex job ${flags.job} not found for this worktree`);

    const codexDir = job.logFile ? join(job.logFile, '..') : null;
    append({
      kind: 'codex-job',
      round,
      axis: typeof flags.axis === 'string' ? flags.axis : null,
      jobId: job.id,
      jobKind: job.kindLabel ?? job.kind ?? null,
      logFile: job.logFile ?? null,
      statusFile: codexDir ? join(codexDir, `${job.id}.json`) : null,
    });
    console.log(`attached codex job ${job.id} (${job.kindLabel ?? job.kind}) to round ${round}`);
    break;
  }

  case 'finding': {
    if (!flags.id) fail('--id is required (F1, F2, ...)');
    if (!SEVERITIES.includes(flags.severity)) {
      fail(`--severity must be one of ${SEVERITIES.join('|')}`);
    }
    if (typeof flags.title !== 'string') fail('--title is required');
    append({
      kind: 'finding',
      round,
      id: String(flags.id).toUpperCase(),
      severity: flags.severity,
      title: flags.title,
      location: typeof flags.at === 'string' ? flags.at : null,
    });
    console.log(`logged finding ${flags.id} in round ${round}`);
    break;
  }

  case 'triage': {
    if (!flags.id) fail('--id is required');
    if (!TRIAGE.includes(flags.verdict)) fail(`--verdict must be one of ${TRIAGE.join('|')}`);
    if (typeof flags.reason !== 'string') fail('--reason is required');
    const id = String(flags.id).toUpperCase();
    const known = all.some((entry) => entry.kind === 'finding' && entry.id === id);
    if (!known) fail(`no logged finding ${id}; log the finding before triaging it`);
    append({ kind: 'triage', round, id, verdict: flags.verdict, reason: flags.reason });
    console.log(`${id} ${flags.verdict}`);
    if (flags.verdict === 'ACCEPT') {
      const finding = all.findLast?.((entry) => entry.kind === 'finding' && entry.id === id)
        ?? [...all].reverse().find((entry) => entry.kind === 'finding' && entry.id === id);
      const recorded = finding ? recordAcceptedFinding(finding, flags.reason) : null;
      if (recorded?.deduped) {
        console.log(`checklist: ${recorded.axis} already lists this finding`);
      } else if (recorded) {
        console.log(`checklist: recorded under docs/reviews/finding-checklists/${recorded.axis}.md`);
      }
    }
    break;
  }

  case 'round-end': {
    if (!VERDICTS.includes(flags.verdict)) fail(`--verdict must be one of ${VERDICTS.join('|')}`);
    // A round with no logged content is invisible to the transcript and the
    // live view — closing it would bless a review that left no record.
    const content = all.filter(
      (entry) => entry.round === round
        && ['turn', 'finding', 'codex-job'].includes(entry.kind),
    );
    if (content.length === 0) {
      fail(
        `round ${round} has no logged turns, findings, or codex jobs — log the round (say / finding / attach-codex) before closing it`,
      );
    }
    append({ kind: 'round-end', round, verdict: flags.verdict });
    console.log(`review round ${round} closed: ${flags.verdict}`);
    break;
  }

  case 'render': {
    const snapshot = buildSnapshot(root, { skipFingerprint: true });
    if (snapshot.rounds.length === 0) {
      console.log('no review rounds logged');
      break;
    }
    for (const item of snapshot.rounds) {
      const open = item.verdict ? item.verdict : 'open';
      console.log(`round ${item.round} · ${item.axis ?? 'unlabelled'} · ${open}`);
      for (const finding of item.findings) {
        const verdict = finding.verdict ?? 'untriaged';
        const at = finding.location ? ` (${finding.location})` : '';
        console.log(`  ${finding.id} ${finding.severity ?? '-'} ${verdict} · ${finding.title}${at}`);
      }
    }
    const untriaged = snapshot.findings.filter((finding) => !finding.verdict).length;
    if (untriaged > 0) console.log(`\n${untriaged} finding(s) awaiting root triage`);
    break;
  }

  default:
    fail(USAGE);
}
