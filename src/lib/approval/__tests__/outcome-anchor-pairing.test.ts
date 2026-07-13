import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Anchor-pairing TRIPWIRE for the agent-outcome lock-order contract (WS4).
//
// recordOutcome's INSERT takes an implicit FK FOR KEY SHARE on the agent_runs
// row, and recordStep (agent_runs FOR UPDATE) / completeRun (agent_runs
// UPDATE) take the same row lock with the same cycle risk; without the global
// reviews-first lock anchor (outcomes.ts / run-spine.ts / veto.ts headers), a
// caller that locks its response row first closes a deadlock cycle against
// processReview / mark-posted (which hold reviews → agent_runs / reviews →
// responses). This test forces HUMAN REVIEW of every new spine-writing file:
// adding a call site outside the allowlist, or dropping the anchor from an
// existing caller, fails here until the file is deliberately reviewed and
// listed — the same governance as the runLlmTask cost-guard allowlist
// (src/__tests__/cost-guard-contract.test.ts) and the JSONB string-guard
// carve-out in CLAUDE.md. It is a textual tripwire, NOT a proof of lock
// ordering; the positional pins in http-routes.test.ts and the
// veto/owner-decision integration suites are the proof.

const CALLER_ALLOWLIST = new Set([
  'src/lib/approval/callback-mode.ts', // anchorReviewLockOrder before lockPendingResponse
  'src/lib/approval/outcomes.ts', // owns anchorReviewLockOrder + recordOwnerDecisionOutcome
  'src/lib/approval/session-mode.ts', // anchorReviewLockOrder (same-tx re-take under runDashboardReviewAction)
  'src/lib/approval/token-mode.ts', // anchorReviewLockOrder before lockPendingResponse
  'src/lib/approval/veto.ts', // in-file reviews FOR UPDATE (owns the deadlock analysis)
  'src/lib/escalations/raise.ts', // lock held by caller — see LOCK_HELD_BY_CALLER
  'src/lib/escalations/transitions.ts', // in-file reviews FOR UPDATE as tx statement #1
  'src/lib/reviews/process-review.ts', // in-file reviews FOR UPDATE as tx statement #1 (canonical order owner)
  'src/lib/reviews/triage.ts', // in-file reviews FOR UPDATE as tx statement #1 (persistTriage)
  'worker/jobs/escalation-notice/EscalationNoticeWorker.ts', // in-file reviews FOR UPDATE before the spine writes
  'worker/jobs/publisher/failed-hook.ts', // anchorReviewLockOrder before terminal exhaustion checkpoints
  'worker/jobs/publisher/mark-posted.ts', // in-file reviews FOR UPDATE as tx statement #1
  'worker/jobs/ResponseGeneratorWorker.ts', // in-file reviews FOR UPDATE before terminal draft checkpoint
  'worker/jobs/response-generation/persist.ts', // in-file reviews FOR UPDATE as tx statement #1
  'worker/jobs/WeeklySummaryWorker.ts', // account_week lane — see NON_REVIEW_SUBJECT_CALLERS
]);

// Files whose reviews lock is owned by their (sole) composition path rather
// than appearing in the file itself. Each entry needs a written justification.
const LOCK_HELD_BY_CALLER = new Set([
  // raiseEscalation runs inside persistTriage's tx (src/lib/reviews/triage.ts),
  // which takes the reviews FOR UPDATE as its FIRST statement before calling
  // in — raise.ts's own header documents the caller-held lock contract.
  'src/lib/escalations/raise.ts',
]);

// Spine tenants with no review subject are outside the reviews-first lock
// law: weekly_insights touches only weekly_summaries + account_week spine
// rows. It must not grow a reviews/businesses lock later without leaving this
// carve-out and re-entering the global reviews → businesses → child rows →
// agent_runs order.
const NON_REVIEW_SUBJECT_CALLERS = new Set([
  'worker/jobs/WeeklySummaryWorker.ts',
]);

const SCAN_ROOTS = ['src', 'worker'];
const SKIP_DIRS = new Set(['__tests__', 'fixtures', 'node_modules']);
// A CALL site — the `function ` lookbehind excludes the declarations
// themselves (run-spine.ts / outcomes.ts); the `for ` lookbehind excludes
// run-spine.ts's own "run not found for recordStep(...)" /
// "... for completeRun(...)" error-message strings, which are not call sites.
const CALL_SITE =
  /(?<!function )(?<!for )\b(?:recordOutcome|recordOwnerDecisionOutcome|recordStep|completeRun)\s*\(/;

function hasReviewsLockPairing(text: string): boolean {
  if (text.includes('anchorReviewLockOrder(')) return true;
  return text.includes('FROM reviews') && text.includes('FOR UPDATE');
}

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkSourceFiles(join(dir, entry.name));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

function findCallerFiles(): { file: string; text: string }[] {
  const callers: { file: string; text: string }[] = [];
  for (const root of SCAN_ROOTS) {
    for (const filePath of walkSourceFiles(join(process.cwd(), root))) {
      const text = readFileSync(filePath, 'utf-8');
      if (CALL_SITE.test(text)) {
        callers.push({ file: relative(process.cwd(), filePath).split('\\').join('/'), text });
      }
    }
  }
  return callers.sort((a, b) => a.file.localeCompare(b.file));
}

describe('spine anchor-pairing contract: recordOutcome/recordStep/completeRun callers hold the reviews lock', () => {
  const callers = findCallerFiles();

  it('pins the non-review-subject carve-out to the weekly account_week caller only', () => {
    expect([...NON_REVIEW_SUBJECT_CALLERS]).toEqual([
      'worker/jobs/WeeklySummaryWorker.ts',
    ]);
  });

  it('every spine-writing file is in the reviewed-caller allowlist', () => {
    const unreviewed = callers.filter(({ file }) => !CALLER_ALLOWLIST.has(file)).map(({ file }) => file);
    expect(
      unreviewed,
      `New recordOutcome/recordStep/completeRun caller(s) detected: ${unreviewed.join(', ')}. ` +
        'Every spine-writing tx must hold the reviews row FOR UPDATE BEFORE ' +
        'any response lock (outcomes.ts caller contract; veto.ts header owns the ' +
        'deadlock analysis) — take the lock in-file or call anchorReviewLockOrder, ' +
        'then add the file to CALLER_ALLOWLIST here.',
    ).toHaveLength(0);
  });

  it('every review-subject caller pairs the outcome with a reviews lock (or a documented caller-held exception)', () => {
    const unpaired = callers
      .filter(({ file, text }) =>
        !LOCK_HELD_BY_CALLER.has(file) &&
        !NON_REVIEW_SUBJECT_CALLERS.has(file) &&
        !hasReviewsLockPairing(text))
      .map(({ file }) => file);
    expect(
      unpaired,
      `Spine-writing file(s) lost their reviews-lock pairing: ${unpaired.join(', ')}. ` +
        'The file must contain a reviews FOR UPDATE or an anchorReviewLockOrder call ' +
        '(outcomes.ts caller contract), or carry a justified LOCK_HELD_BY_CALLER entry.',
    ).toHaveLength(0);
  });

  it('the allowlists carry no stale entries', () => {
    const found = new Set(callers.map(({ file }) => file));
    const stale = [...CALLER_ALLOWLIST].filter((file) => !found.has(file));
    expect(
      stale,
      `Allowlisted file(s) no longer write to the run spine: ${stale.join(', ')}. ` +
        'Remove them — this is an allowlist, not folklore.',
    ).toHaveLength(0);

    const orphanExceptions = [...LOCK_HELD_BY_CALLER].filter((file) => !CALLER_ALLOWLIST.has(file));
    expect(
      orphanExceptions,
      `LOCK_HELD_BY_CALLER entries missing from CALLER_ALLOWLIST: ${orphanExceptions.join(', ')}.`,
    ).toHaveLength(0);

    const orphanNonReviewCallers = [...NON_REVIEW_SUBJECT_CALLERS]
      .filter((file) => !CALLER_ALLOWLIST.has(file) || !found.has(file));
    expect(
      orphanNonReviewCallers,
      `NON_REVIEW_SUBJECT_CALLERS entries missing from the live caller allowlist: ${orphanNonReviewCallers.join(', ')}.`,
    ).toHaveLength(0);
  });
});
