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
  'src/lib/solicitation/approval.ts', // solicitation_batch subject — see NON_REVIEW_SUBJECT_CALLERS
  'src/lib/solicitation/ask-generation.ts', // solicitation_send_batch subject — see NON_REVIEW_SUBJECT_CALLERS
  'src/lib/solicitation/auto-approval.ts', // solicitation_send_batch subject — see NON_REVIEW_SUBJECT_CALLERS
  'src/lib/solicitation/dispatch.ts', // solicitation_ask subject — see NON_REVIEW_SUBJECT_CALLERS
  'src/lib/solicitation/outreach.ts', // solicitation_batch subject — see NON_REVIEW_SUBJECT_CALLERS
  'src/lib/solicitation/release.ts', // solicitation_send_batch subject — see NON_REVIEW_SUBJECT_CALLERS
  'worker/jobs/escalation-notice/EscalationNoticeWorker.ts', // in-file reviews FOR UPDATE before the spine writes
  'worker/jobs/publisher/failed-hook.ts', // anchorReviewLockOrder before terminal exhaustion checkpoints
  'worker/jobs/solicitation-send/failed-hook.ts', // solicitation_ask subject — see NON_REVIEW_SUBJECT_CALLERS
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
// law. Every entry states which locks its tx actually takes and why they
// cannot close a cycle back onto the reviews lane.
//
// weekly_insights explicitly locks only weekly_summaries + its
// account_week run row, though its spine INSERTs (agent_runs / steps /
// outcomes) also take implicit FK FOR KEY SHARE locks on the parent
// businesses + accounts rows. Those key-shares are cycle-free: they conflict
// only with exclusive parent-row locks (e.g. a reviews-lane tx holding
// businesses FOR UPDATE), and no such holder ever waits on weekly_summaries
// or a weekly-subject run — the weekly tx can wait, but no cycle can close
// back onto it. It must not grow a reviews/businesses lock
// later without leaving this carve-out and re-entering the global
// reviews → businesses → child rows → agent_runs order.
//
// solicitation/outreach.ts is closeBatchIfSettled (#624 T5). Its subject is a
// solicitation_batch, never a review: it locks solicitation_batches FOR UPDATE,
// then writes its own solicitation_send_batch run via recordStep / completeRun
// (or failSolicitationBatchRun) — the only agent_runs row it touches is that
// send parent's own. It takes NO reviews or businesses exclusive lock, and it
// INSERTs no agent_runs/agent_outcomes row; agent_run_steps FK-references only
// agent_runs (migration 071), so the step INSERT's implicit FK FOR KEY SHARE
// lands on the run row this tx already holds, and the terminal UPDATE changes
// no FK column — no businesses/accounts parent-row lock is taken at all.
//
// CORRECTED 2026-07-30 after the step-6 adversarial review (finding F1). An
// earlier revision of this comment justified the carve-out by asserting that
// "no holder of a run lock ever waits on solicitation_batches". That was FALSE
// as written: T5's original contract had the lane record the failure on the send
// parent BEFORE calling in, which took the agent_runs lock first and then the
// batch lock — run→batch — against every other caller's batch→run. That ABBA
// pair is now gone: the failure arrives as a parameter
// (CloseBatchIfSettledInput.failure) and this lane is single-ordered batch→run.
// The carve-out's conclusion holds, but it rests on that single order, NOT on
// the false claim it used to make. Do not restore the old wording.
//
// Same forward-looking warning as the weekly entry: it must not grow a
// reviews/businesses lock later without leaving this carve-out and re-entering
// the global reviews → businesses → child rows → agent_runs order — and it must
// not reintroduce any path that locks the send parent before the batch.
//
// solicitation/ask-generation.ts (#628) is the generation lane for the SAME
// solicitation_send_batch subject. Its documented lock order (file header,
// AMEND B11 + the closeBatchIfSettled contract) is outbox CAS → per-business
// advisory lock → batch row FOR UPDATE → spine (agent_runs) locks — batch →
// run is the sole order in the lane, the same single order the outreach.ts
// carve-out above rests on, so no ABBA pair exists between the two files.
// recordGenerationSteps / recordStep lock only the send parent's own run row;
// reviews are never touched and no businesses/accounts exclusive lock is
// taken. Same forward-looking warning: growing a reviews/businesses lock, or
// any path that locks the send parent before the batch, requires leaving this
// carve-out and re-entering the global order.
// solicitation/approval.ts (#629) is the OWNER-triggered lane for the same
// solicitation_send_batch subject: approveBatch and haltBatch. It is the third
// file in this lane and rests on the identical argument as the two above, which
// is why it belongs in the carve-out rather than in the global order.
//
// Its lock order is per-business advisory lock → solicitation_batches row
// FOR UPDATE → spine — batch → run, the SAME single order ask-generation.ts and
// outreach.ts rest on, so it introduces no ABBA pair against either. Both verbs
// route through one helper (lockBatchForAction) that takes the advisory lock and
// the batch row lock before any agent_runs read or write, and every run-spine
// call in the file — recordStep, and closeBatchIfSettled which terminalizes —
// happens strictly after that. reviews is never touched: the subject is a
// solicitation_batch and the only agent_runs row either verb reads or writes is
// that batch's own send parent. It INSERTs no agent_runs/agent_outcomes row.
//
// Here it DIVERGES from the outreach.ts entry above, and the divergence is
// recorded because the original wording of this paragraph copied outreach.ts's
// premise verbatim and that premise is FALSE in approval.ts: this file holds no
// agent_runs lock of its own, so recordStep's own SELECT … FOR UPDATE on the
// send parent is the transaction's FIRST lock on that row — not a re-take of
// one "the transaction already holds". The step INSERT's implicit FK
// FOR KEY SHARE then lands on a row recordStep just took. The conclusion is
// unchanged and in fact holds a fortiori: that lock is acquired strictly after
// both batch locks, so batch → run still holds, and no businesses/accounts
// parent-row lock is taken at all. Do not restore the copied sentence — a lock
// analysis resting on an untrue premise is worthless even when its conclusion
// happens to be right.
//
// One thing to watch that the other two entries do not have: approval.ts is
// reached from HTTP routes, not from a worker, so it is the lane's only
// user-latency-bearing caller of the advisory lock. That affects blocking time,
// not lock ORDER, and the order is what this carve-out is about.
//
// Same forward-looking warning as the entries above: it must not grow a
// reviews/businesses lock, and must not gain any path that locks the send parent
// before the batch, without leaving this carve-out and re-entering the global
// reviews → businesses → child rows → agent_runs order.
// dispatch.ts (#899) — subject `solicitation_ask`, the per-dispatch-attempt
// Lazy child, plus the send parent it terminalizes through closeBatchIfSettled.
// Its tx1 takes, IN THIS ORDER: the job_outbox attempt row FOR UPDATE, the
// per-business advisory xact lock, the solicitation_batches row FOR UPDATE, the
// solicitation_outreach row FOR UPDATE, and only then the agent_runs locks that
// startOrGetSolicitationAskRun / recordStep / completeRun take. So batch → run
// holds, exactly as the three entries above require.
//
// It takes NO reviews lock and NO businesses row lock: its only businesses read
// is readPostalAddressState's plain SELECT, which takes no row lock at all, and
// the spine INSERTs' implicit FK FOR KEY SHARE on businesses/accounts is the
// same cycle-free key-share the weekly entry documents.
//
// Same forward-looking warning as the entries above: it must not grow a
// reviews/businesses FOR UPDATE, and must not gain a path that locks either run
// row before the batch. Note in particular that the two SLOW Dispatch gate
// items (re-lint, re-moderation) run ABOVE tx1 with no lock held — moving them
// inside would hold every lock above across a ~10s provider call.
// worker/jobs/solicitation-send/failed-hook.ts (#899) — subject `solicitation_ask`,
// the same Lazy child dispatch.ts writes, reached on the TERMINAL BullMQ attempt
// only. Its single tx takes, IN THIS ORDER: the per-business advisory xact lock
// (statement #1, before any row lock), the job_outbox attempt row via
// markOutboxFailed, the solicitation_outreach row FOR UPDATE, then completeRun's
// agent_runs lock, then closeBatchIfSettled. Batch-scoped advisory → row →
// agent_runs, so batch → run holds exactly as the entries above require.
//
// It takes NO reviews lock and NO businesses row lock; it reads no businesses
// row at all. Its ONLY divergence from dispatch.ts is that it never takes the
// solicitation_batches row FOR UPDATE itself — closeBatchIfSettled does, after
// the advisory lock is already held, which is the same order by a shorter path.
//
// Same forward-looking warning as the entries above: it must not grow a
// reviews/businesses FOR UPDATE, and the advisory lock must stay statement #1 —
// holding the Outreach row while waiting for the batch row is an ABBA deadlock
// against the offboarding purge, which takes them in the documented order
// (worker/jobs/account-offboarding/purge-stages.ts:270-284).
//
// src/lib/solicitation/release.ts (#900) — subject `solicitation_send_batch`,
// the Send batch parent. It makes three spine writes, all from this one file:
// the `approval_downgraded` step on the Judge-downgrade path, `completeRun` on
// the **Lazy child** in the `unknown` sweep, and `closeBatchIfSettled` from four
// call sites (the sweep, both **Halt latch** sweeps through `latchSystemHalt`,
// and the backstop join).
//
// Every one of its transactions takes the solicitation_batches row FOR UPDATE as
// its FIRST row lock, before any agent_runs touch — batch → run, the sole order
// in this lane, and the one CloseBatchIfSettledInput.failure's docstring exists
// to protect. The Judge downgrade is the case worth stating: it locks the batch,
// CASes the approval columns, and only THEN records the step.
//
// It takes NO reviews lock and NO businesses row lock, and reads no businesses
// row at all. The releaser's candidate SCAN is cross-account (see the
// background-global-scan entry in scripts/ci/tenant-scope-allowlist.ts) but
// takes no locks — every locked write is scoped by account_id AND business_id.
//
// Same forward-looking warning as the entries above: it must not grow a
// reviews/businesses FOR UPDATE, and no path may lock an agent_runs row before
// the batch row. Note in particular that `readSendBreaker`, `isJudgeHealthy` and
// both cap counters run ABOVE every transaction with no lock held — moving any
// of them inside would hold the batch row across a platform-wide scan.
// (#631 added one lock to its Auto-approval-lane paths: `lockAutonomyAccount`'s
// accounts row FOR UPDATE, taken inside `applyAutoDowngrade`'s confirm hook
// and `releaseOutreachRow`, strictly AFTER the batch lock and BEFORE any
// agent_runs touch — batch → account → run, so the entry's batch → run claim
// is unchanged. See the auto-approval.ts entry below for why that exclusive
// accounts lock cannot close a cycle onto the reviews lane.)
//
// src/lib/solicitation/auto-approval.ts (#631) — subject
// `solicitation_send_batch`, the same Send batch parent as its lane siblings.
// Its two recordStep call sites, with each transaction's actual lock order:
//
//   1. `batch_approved` (autoApproveBatch), reached ONLY from the
//      ask-generation finale transaction via runFinaleAutoApproval (locked
//      decision 1; the caller contract is in the file). That tx holds, in
//      order: the outbox CAS, the per-business advisory lock, the
//      solicitation_batches row FOR UPDATE (all three the ask-generation.ts
//      entry above documents), then the accounts row FOR UPDATE
//      (`lockAutonomyAccount`, the documented batch-then-account order), and
//      only THEN recordStep's agent_runs FOR UPDATE — batch → run holds, and
//      the run lock is the transaction's last.
//   2. `veto_window_granted` (anchorOneBatch, the Veto anchor). Its own
//      per-candidate transaction takes the solicitation_batches row
//      FOR UPDATE as its FIRST statement, then recordStep's agent_runs lock —
//      batch → run again. NO account lock on this path: the anchor writes no
//      policy-gated state, and the deadline CAS re-asserts approval_method
//      and the halt/close columns under the batch lock instead.
//
// The divergence from every lane sibling, stated rather than papered over
// (the approval.ts entry above is the precedent for recording one): the
// finale path DOES take an exclusive accounts row lock — the same
// `lockAutonomyAccount` serialization the Settings and Governor writers take,
// which is the point (plan decision 3: no opt-out or suspension can commit
// between the condition read and the approval CAS). It is cycle-free against
// the reviews lane for the directional reason the weekly entry's key-share
// note establishes: a reviews-lane spine INSERT's implicit FK FOR KEY SHARE
// on accounts can WAIT behind this exclusive lock, but this transaction
// afterwards waits only on its own send parent's agent_runs row and on
// solicitation tables — rows no reviews-lane tx ever holds — so the wait is
// one-directional and no cycle can close back onto it. NEITHER path touches
// reviews or responses rows, and no businesses row lock is taken, so the
// reviews-before-response deadlock analysis is vacuous for this file exactly
// as it is for release.ts's entry above.
//
// Same forward-looking warning as the entries above, plus one of its own: it
// must not grow a reviews/businesses FOR UPDATE, no path may lock an
// agent_runs row before the batch row, and the account lock must STAY after
// the batch lock — an account-before-batch path would be an ABBA pair against
// release.ts's #631 arms and the finale itself, which are single-ordered
// batch → account.
const NON_REVIEW_SUBJECT_CALLERS = new Set([
  'src/lib/solicitation/approval.ts',
  'src/lib/solicitation/ask-generation.ts',
  'src/lib/solicitation/auto-approval.ts',
  'src/lib/solicitation/dispatch.ts',
  'src/lib/solicitation/outreach.ts',
  'src/lib/solicitation/release.ts',
  'worker/jobs/WeeklySummaryWorker.ts',
  'worker/jobs/solicitation-send/failed-hook.ts',
]);

const SCAN_ROOTS = ['src', 'worker'];
const SKIP_DIRS = new Set(['__tests__', 'fixtures', 'node_modules']);
// A CALL site — the `function ` lookbehind excludes the declarations
// themselves (run-spine.ts / outcomes.ts); the `for ` lookbehind excludes
// run-spine.ts's own "run not found for recordStep(...)" /
// "... for completeRun(...)" error-message strings, which are not call sites.
// startOrGetActiveRun is included because its INSERT/SELECT-FOR-UPDATE also
// locks the agent_runs row — a caller of only that function is a spine writer
// with the same cycle risk and must not escape the tripwire.
const CALL_SITE =
  /(?<!function )(?<!for )\b(?:recordOutcome|recordOwnerDecisionOutcome|recordStep|completeRun|startOrGetActiveRun)\s*\(/;

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

  it('pins the non-review-subject carve-out to exactly the weekly account_week and solicitation send-batch callers', () => {
    expect([...NON_REVIEW_SUBJECT_CALLERS]).toEqual([
      'src/lib/solicitation/approval.ts',
      'src/lib/solicitation/ask-generation.ts',
      'src/lib/solicitation/auto-approval.ts',
      'src/lib/solicitation/dispatch.ts',
      'src/lib/solicitation/outreach.ts',
      'src/lib/solicitation/release.ts',
      'worker/jobs/WeeklySummaryWorker.ts',
      'worker/jobs/solicitation-send/failed-hook.ts',
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
