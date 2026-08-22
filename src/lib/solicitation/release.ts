// The Solicitation release lane (#900) — one deep module behind one function.
//
// PHASE ORDER, and the order is the contract rather than an implementation
// detail:
//
//   1. `unknown` sweep (D12d)   — first, so a wedged row can settle its batch
//                                 in this same tick.
//   2. `send_window_elapsed`    — before release, so an overdue batch never
//                                 releases.
//   3. `batch_expired` (B7)
//   4. RELEASE phase            — the only phase gated on
//                                 `SOLICITATION_SEND_ENABLED`.
//   5. backstop join (D11)      — `closeBatchIfSettled` over every still-open
//                                 batch, RE-SCANNED rather than replayed from
//                                 the ids phases 1-4 touched: the batch whose
//                                 join was lost is by construction one no other
//                                 phase can select. One implementation, two
//                                 callers; the backstop cannot drift from the
//                                 inline path.
//
// THE FLAG GATES PHASE 4 ONLY, and that departs from the `JudgeSweepPoller`
// precedent deliberately. If the whole cycle were flag-gated, flipping
// `SOLICITATION_SEND_ENABLED` off mid-drip would stop phase 2, so the batch's
// `queued` rows would never be reclaimed and migration 091's
// `solicitation_batches_one_active_send_per_business` index would block that
// location forever. That is the permanent wedge issue #915 exists to close.
//
// RELEASE-LEVEL GOVERNOR ORDER, quoted from amendment B6's closing paragraph
// rather than inferred: circuit breaker -> platform ceiling -> account cap ->
// `subscriptionGrantsFullAccess`, then the Judge availability split (#619 D18).
// B6's per-child item numbering is a DIFFERENT list and does not govern here.
// A wrong order is silent — issue #910's B3.2.
//
// The Judge is evaluated LAST, and that position is load-bearing: a downgrade
// clears `approved_at`, so evaluating it before the account cap would destroy
// the approval evidence of a batch the cap alone would simply have stopped.
//
// THREE COUNTERS DECREMENT PER SUCCESSFUL RELEASE, never once per tick: the
// per-tick budget, the platform remainder and that account's remainder. Nine
// prior attempts against a platform cap of ten leave ONE slot, so a budget-two
// tick must release one row and not two. A single check at the top of the phase
// is exactly the overrun this shape exists to prevent.
//
// Caps are enforced HERE ONLY (amendment B3) — a single loop, which is what
// replaces atomic-reservation machinery. SINGLE-REPLICA DOES NOT MEAN
// SINGLE-CONCURRENT-CYCLE, and the intake's original wording said it did:
// `worker/background/guarded-poll.ts` frees the single-flight flag at the 45s
// deadline and the timed-out cycle KEEPS RUNNING DETACHED, so the next tick can
// start a second cycle beside it. What bounds the overrun is that both cap
// figures are re-read from the database per cycle and count COMMITTED
// `queued_at` rows — an overlapping cycle already sees what the detached one
// committed, so the excess is at most the detached cycle's
// selected-but-uncommitted rows, i.e. its remaining per-tick budget. That is a
// re-read, NOT a reservation: if this loop is ever parallelized across
// replicas, the resolution must be revisited (P2 entry in
// docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md).
//
// THE PER-CHILD **Dispatch gate** IS #899's AND RUNS NOWHERE IN THIS FILE. What
// this module decides is whether a `rendered` attempt may become `queued`; what
// happens to a `queued` attempt is the send worker's question.
//
// Invariant #15: this module takes its DB client as an explicit parameter and
// never imports `@/lib/db/server`. Its composition root is
// `worker/background/pollers/SolicitationReleasePoller.ts`.

import * as Sentry from '@sentry/node';
import type { Sql, TransactionSql } from 'postgres';
import { completeRun, recordStep } from '@/lib/agents/run-spine';
import { getWorkerConfig } from '@/lib/config/worker';
import { judgeEnabled } from '@/lib/responses/judge-flags';
import { isJudgeHealthy } from '@/lib/responses/judge-health';
import { enqueueSolicitationSend } from '@/lib/shared/job-outbox-helpers';
import { createWorkerLogger, toError } from '@/lib/shared/logger';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';
import { latchSystemHalt } from './approval';
import { solicitationSendEnabled } from './flags';
import {
  BATCH_APPROVAL_WINDOW_DAYS,
  BATCH_SEND_WINDOW_HOURS,
  closeBatchIfSettled,
  UNKNOWN_GRACE_MINUTES,
} from './outreach';
import { readSendBreaker } from './send-breaker';
import {
  countAccountDispatchAttemptsToday,
  countPlatformDispatchAttemptsToday,
  DEFAULT_DAILY_SEND_CAP_ACCOUNT,
  resolveAccountDailySendCap,
  resolvePlatformDailyCap,
} from './send-caps';

const logger = createWorkerLogger('[SolicitationRelease]');

/** The one reason a Judge downgrade ever carries. Written into the spine step. */
const JUDGE_UNAVAILABLE_REASON = 'judge_unavailable';

/** Stable Sentry title — Sentry groups `captureMessage` by its text, so one
 *  title collapses a fleet-wide Judge outage into ONE issue that keeps
 *  receiving events rather than N issues. */
const DOWNGRADE_ALERT_MESSAGE = 'Solicitation batch approval downgraded: Judge unavailable';

/**
 * The one reason an `unknown` terminalization ever carries. Migration 091 pairs
 * `unknown` with `send_indeterminate` EXCLUSIVELY on the Outreach row, so the
 * two are never spelled apart; the **Lazy child**'s error names the same reason
 * so one wedge reads as one fact on both sides of the spine.
 */
const SEND_INDETERMINATE_REASON = 'send_indeterminate';

/** Stable Sentry title, for the same reason `DOWNGRADE_ALERT_MESSAGE` is one:
 *  `captureMessage` groups by its text, so a fleet-wide provider incident that
 *  wedges N dispatches collapses into ONE issue that keeps receiving events. */
const UNKNOWN_ALERT_MESSAGE =
  'Solicitation dispatch terminalized unknown: send outcome indeterminate';

/**
 * Which release-level gate withheld a release. A closed union — a new member
 * means a new gate, and every gate is named in the module header's order.
 */
export type ReleaseWithheldReason =
  | 'flag_off'
  | 'breaker_open'
  | 'platform_ceiling'
  | 'account_cap'
  | 'subscription'
  | 'judge_unhealthy'
  | 'per_tick_budget';

export interface ReleaseCycleReport {
  released: number;
  /** The FIRST gate that stopped the whole release phase, or null when it ran. */
  releasePhaseStoppedBy: ReleaseWithheldReason | null;
  /** Per-account and per-batch withholds, counted by reason. */
  withheldByReason: Partial<Record<ReleaseWithheldReason, number>>;
  downgraded: number;
  heldForJudge: number;
  sendWindowElapsed: number;
  batchExpired: number;
  unknownTerminalized: number;
  backstopClosed: number;
  /**
   * Items whose body threw and were isolated to that item (round-1 finding on
   * error isolation). It belongs on the REPORT and not only in Sentry because
   * the poller logs the whole report every tick, so a phase that fails EVERY
   * item — the shape that starves the lane — reads as `itemFailures: 50` in the
   * cycle line rather than as a silent absence of work.
   */
  itemFailures: number;
}

/**
 * What one phase's per-item loop did: the items it acted on, and the items it
 * isolated. Both halves are per-PHASE; the cycle report folds them through
 * `tallyPhase`.
 */
interface PhaseTally {
  handled: number;
  failed: number;
}

export interface ReleaseCycleOptions {
  /** Outreach rows released platform-wide per tick. Default RELEASE_PER_TICK_BUDGET. */
  perTickBudget?: number;
  /** Candidate rows scanned per phase. Default RELEASE_SCAN_LIMIT. */
  scanLimit?: number;
}

/**
 * The drip's pacing lever, and the only one this lane owns.
 *
 * The deliverability spec §7.1 asks dispatch to yield to transactional mail on
 * the shared 10 req/s Resend TEAM limit. The releaser is the only producer of
 * `solicitation_send` jobs, so bounding its output per tick is the scheduling
 * act available to it. At a 60s cadence a full 10-row account daily cap drips
 * over five minutes. True priority-yielding against a shared limiter is NOT
 * built here.
 */
export const RELEASE_PER_TICK_BUDGET = 2;

/** Rows scanned per phase per tick. Bounds the tick, and every phase logs what it dropped. */
export const RELEASE_SCAN_LIMIT = 50;

/** Stable prefix for the isolated-item log line, for the same grouping reason
 *  the two alert titles above are constants. The phase is a Sentry TAG rather
 *  than part of the text so one query answers "which phase is poisoned". */
const ITEM_FAILURE_MESSAGE = 'Solicitation release item failed and was isolated';

/**
 * Run ONE item's body, isolating a throw to that item.
 *
 * **WHY EVERY PER-ITEM LOOP NEEDS THIS, stated once here.** The five phases run
 * in sequence and every scan is `ORDER BY … ASC`, so without isolation a single
 * deterministically-failing item is re-selected as the FIRST row of its phase on
 * every subsequent tick and aborts every phase after it — platform-wide, and
 * permanently. That is issue #915's wedge arriving through the door built to
 * close it. One poisoned item must cost one item, not the lane.
 *
 * NOT A SILENT CATCH. Every failure is logged with the ids needed to find the
 * row, counted into `ReleaseCycleReport.itemFailures`, and raised to Sentry —
 * the log line is the fallback sink for Sentry itself being unreachable, so it
 * lives outside that guard, exactly as `alertUnknownTerminalization` does.
 *
 * It does NOT wrap a phase's SCAN, and a scan throw does NOT reach the
 * crash-net. `createGuardedPoll` catches everything `runReleaseCycle` throws and
 * never rethrows (`worker/background/guarded-poll.ts`), so the throw is never an
 * `unhandledRejection` and `worker/index.ts`'s classifier never sees it; what it
 * leaves behind is one `logger.error` JSON line, and the logger has NO Sentry
 * hook (`src/lib/shared/logger.ts`). A scan, `readSendBreaker` or
 * `groupByAccount` throw therefore aborts every LATER phase — P5's backstop join
 * included — on every tick for as long as the condition persists, which is a
 * wider blast radius than any item failure. `alertPhaseFailure` is that class's
 * sink: it alerts and RETHROWS, so the containment behaviour is unchanged and
 * only the alerting is added.
 */
async function isolateItem<T>(
  phase: string,
  context: Record<string, string>,
  tally: { failed: number },
  body: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await body();
  } catch (error) {
    recordItemFailure(phase, context, tally, error);
    return undefined;
  }
}

/**
 * The sink `isolateItem` wraps, exposed separately because the RELEASE phase
 * cannot use the wrapper: its per-account body carries `continue` and `break`
 * that target the enclosing loops, and neither may cross a function boundary.
 * A bare `try`/`catch` around that body plus this call is the same act.
 */
function recordItemFailure(
  phase: string,
  context: Record<string, string>,
  tally: { failed: number },
  error: unknown,
): void {
  tally.failed += 1;
  const cause = toError(error);
  try {
    Sentry.captureException(cause, {
      level: 'warning',
      tags: { subsystem: 'solicitation-release', phase },
      extra: { ...context },
    });
  } catch {
    // The log line below is the fallback sink for Sentry itself being
    // unreachable, so it lives OUTSIDE this guard.
  }
  logger.error(ITEM_FAILURE_MESSAGE, cause, { phase, ...context });
}

/** Stable prefix for the phase-level failure line, grouped like the others. The
 *  phase is a Sentry TAG, so one query separates "which phase is poisoned" from
 *  the item-level issues that carry the same tag. */
const PHASE_FAILURE_MESSAGE = 'Solicitation release phase failed and aborted the cycle';

/**
 * Give a PHASE-level throw the alerting sink the per-item catch already has,
 * then RETHROW.
 *
 * **IT CHANGES NO CONTROL FLOW.** The cycle still aborts, `createGuardedPoll`
 * still catches, and the tick still ends without the phases after this one —
 * that containment is deliberate and unchanged. What this closes is the
 * asymmetry `isolateItem`'s docstring describes: an ITEM failure (blast radius
 * one row) raised a Sentry issue while a SCAN failure (blast radius every later
 * phase, every tick, P5's backstop join included) raised nothing at all. A
 * `selectReleaseCandidates` that starts timing out under PgBouncer's
 * `statement_timeout` is exactly that shape — the lane silently stops closing
 * batches and no alert fires.
 *
 * `readSendBreaker`'s throw comes through here too, and belongs here: the throw
 * IS the fail-closed halt signal (#622 §3.2B), and a halt signal that suppresses
 * P5 for as long as it persists is worth an alert. Alerting is not catching —
 * the rethrow is what keeps that invariant intact.
 */
async function alertPhaseFailure<T>(phase: string, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    const cause = toError(error);
    try {
      Sentry.captureException(cause, {
        level: 'warning',
        tags: { subsystem: 'solicitation-release', phase },
      });
    } catch {
      // The log line below is the fallback sink for Sentry itself being
      // unreachable, so it lives OUTSIDE this guard.
    }
    logger.error(PHASE_FAILURE_MESSAGE, cause, { phase });
    throw error;
  }
}

/** Fold one phase's tally into the cycle report: the handled count is that
 *  phase's own field, the isolated failures accumulate across the tick. */
function tallyPhase(report: ReleaseCycleReport, tally: PhaseTally): number {
  report.itemFailures += tally.failed;
  return tally.handled;
}

/**
 * Run one release cycle.
 *
 * Deliberately the module's ONLY export beyond its vocabulary: the phase order
 * is a domain rule, so a caller that could run the phases separately could run
 * them wrongly. The phases' predicates are disjoint, which is what makes each
 * one testable through this single interface by seeding only its own state.
 */
export async function runReleaseCycle(
  sql: Sql,
  options?: ReleaseCycleOptions,
): Promise<ReleaseCycleReport> {
  const perTickBudget = options?.perTickBudget ?? RELEASE_PER_TICK_BUDGET;
  const scanLimit = options?.scanLimit ?? RELEASE_SCAN_LIMIT;

  const report: ReleaseCycleReport = {
    released: 0,
    releasePhaseStoppedBy: null,
    withheldByReason: {},
    downgraded: 0,
    heldForJudge: 0,
    sendWindowElapsed: 0,
    batchExpired: 0,
    unknownTerminalized: 0,
    backstopClosed: 0,
    itemFailures: 0,
  };

  // The list IS the phase order, and the order is the contract stated in the
  // module header. Nothing here may be reordered or run conditionally.
  // `alertPhaseFailure` wraps each one for ALERTING ONLY — it rethrows, so a
  // phase-level throw still aborts the tick exactly as it did.
  report.unknownTerminalized = tallyPhase(
    report,
    await alertPhaseFailure('unknown_sweep', () => sweepUnknownOutreach(sql, scanLimit)),
  );
  report.sendWindowElapsed = tallyPhase(
    report,
    await alertPhaseFailure('send_window_elapsed', () => sweepSendWindowElapsed(sql, scanLimit)),
  );
  report.batchExpired = tallyPhase(
    report,
    await alertPhaseFailure('batch_expired', () => sweepBatchExpired(sql, scanLimit)),
  );
  await alertPhaseFailure('release', () =>
    runReleasePhase(sql, { perTickBudget, scanLimit }, report),
  );
  report.backstopClosed = tallyPhase(
    report,
    await alertPhaseFailure('backstop_join', () => runBackstopJoin(sql, scanLimit)),
  );

  return report;
}

// ── phase 5: the backstop join (D11) ────────────────────────────────────────

/**
 * The backstop join (D11) — `closeBatchIfSettled` over every still-open batch,
 * one transaction each.
 *
 * ONE IMPLEMENTATION, TWO CALLERS. The other caller is the send worker's
 * terminal transaction, which joins as it terminalizes the last live Outreach
 * row; this is the backstop for the tick where that call was LOST. A second
 * implementation here would be a second definition of a **Settled batch** — and
 * the glossary asks that condition of the domain table exactly once, which is
 * why nothing in this function spells `rendered`, `queued` or `sending`.
 *
 * IT RE-SCANS rather than replaying the ids the earlier phases touched, and the
 * two readings of "every still-open batch the tick saw" are NOT interchangeable.
 * The batch this phase exists for is by definition one no other phase touched:
 * every row of it is already terminal, so P1 finds no `sending` row, P4's
 * `EXISTS` finds no `rendered` row, and both expiry sweeps see a batch inside
 * its windows. Accumulating ids would leave the backstop reachable only for
 * batches something else had already closed inline — which is every batch
 * except the one whose join was lost.
 *
 * NO `failure` IS DECLARED, and that is the whole difference between a backstop
 * and a terminalizer. `closed_without_parent` is reachable ONLY when the caller
 * hands over a failure (see its own docstring): without one, a parentless batch
 * is an ordinary built batch awaiting approval and must be left alone. This
 * caller therefore cannot observe that status at all — a parentless batch
 * answers `no_send_parent` here, and nothing is written.
 *
 * Counts what was CLOSED, matching the two sweeps' "counts what was latched".
 * `not_settled` is the ordinary answer for a live batch and is the cheap one —
 * the grouped tally short-circuits before the parent lookup. `already_closed`
 * is a writer that won the race between the scan and the lock. Neither is an
 * event, so neither is reported.
 */
async function runBackstopJoin(sql: Sql, scanLimit: number): Promise<PhaseTally> {
  const batches = await selectOpenSendBatches(sql, scanLimit);

  const tally: PhaseTally = { handled: 0, failed: 0 };
  for (const batch of batches) {
    const result = await isolateItem(
      'backstop_join',
      { batch_id: batch.id, account_id: batch.account_id, business_id: batch.business_id },
      tally,
      () =>
        sql.begin(async (tx) =>
          closeBatchIfSettled(tx, {
            batchId: batch.id,
            accountId: batch.account_id,
            businessId: batch.business_id,
          }),
        ),
    );
    if (result?.status === 'closed') tally.handled += 1;
  }
  return tally;
}

/**
 * P5 — batches still open in the send lane.
 *
 * **THE THREE ARMS ARE MIGRATION 091's `solicitation_batches_one_active_send_per_business`
 * PREDICATE, BYTE FOR BYTE** (`approved_at IS NOT NULL AND send_closed_at IS
 * NULL AND halted_at IS NULL`), and that identity is the reason the set is this
 * one rather than a wider "anything unclosed". A batch matching it is exactly a
 * batch OCCUPYING its location's single active-send slot, so an unclosed batch
 * in this set is a wedged location — the failure #915 exists to close — while an
 * unclosed batch outside it wedges nothing. The unique partial index also serves
 * the scan.
 *
 * A HALTED batch is deliberately out of scope, twice over: it holds no slot, and
 * its join already has an inline owner in `latchSystemHalt`, which calls this
 * same function under the same batch lock in the transaction that latches it.
 * A never-approved batch is out of scope for the reason `closeBatchIfSettled`
 * states itself — it has not entered the send lane, and closing it would slam
 * the door on a batch the owner still has days to approve.
 *
 * `approved_at ASC` for the same reason P2 and P4 order that way: the oldest
 * approval leads, so a lost join is never starved behind a newer batch.
 */
async function selectOpenSendBatches(
  sql: Sql,
  scanLimit: number,
): Promise<SweepCandidateBatch[]> {
  return sql<SweepCandidateBatch[]>`
    SELECT b.id, b.account_id, b.business_id
      FROM solicitation_batches b
     WHERE b.approved_at IS NOT NULL
       AND b.halted_at IS NULL
       AND b.send_closed_at IS NULL
     ORDER BY b.approved_at ASC
     LIMIT ${scanLimit}
  `;
}

// ── phase 1: the `unknown` sweep (D12d) ─────────────────────────────────────

/** P1's projection: the Outreach row's tenant triple plus the batch it belongs
 *  to, which is the row the terminalizing transaction locks FIRST. `ask_id` is
 *  deliberately absent — the **Lazy child** is resolved from the value the CAS
 *  returns UNDER the batch lock, never from this unlocked read. */
interface WedgedOutreachRow {
  id: string;
  account_id: string;
  business_id: string;
  batch_id: string;
}

/**
 * The `unknown` sweep (D12d) — the sweep issue #915 names as the blocker on
 * ever flipping `SOLICITATION_SEND_ENABLED` on.
 *
 * D10 deliberately excludes `sending` from the halt sweep, so a dispatch that
 * died between #899's tx1 and tx2 has NO other escape: it blocks
 * `closeBatchIfSettled` forever and permanently consumes that location's one
 * active-send slot under 091's `solicitation_batches_one_active_send_per_business`.
 * That is why this phase runs FIRST — a row it resolves can settle its batch in
 * the same tick, through phase 2, phase 3 or phase 5's join.
 *
 * PER-ROW, and structurally unlike the two sweeps that follow it. Those latch a
 * BATCH and hand the whole body to `latchSystemHalt`; this one terminalizes ONE
 * Outreach row, terminalizes that row's **Lazy child**, and joins — three writes
 * this module owns, in one transaction per row. Deliberately NOT sharing a body
 * with either of them: same loop shape, entirely different transaction.
 *
 * Counts what was TERMINALIZED, not what was scanned. Zero rows from the CAS
 * means the outbox watchdog re-pended the row between the scan and the lock —
 * nothing happened, so nothing is reported and nothing is alerted.
 */
async function sweepUnknownOutreach(sql: Sql, scanLimit: number): Promise<PhaseTally> {
  const rows = await selectWedgedSendingOutreach(sql, scanLimit);

  const tally: PhaseTally = { handled: 0, failed: 0 };
  for (const row of rows) {
    const moved = await isolateItem(
      'unknown_sweep',
      {
        outreach_id: row.id,
        batch_id: row.batch_id,
        account_id: row.account_id,
        business_id: row.business_id,
      },
      tally,
      () => sql.begin(async (tx) => terminalizeWedgedOutreach(tx, row)),
    );
    if (moved !== true) continue;
    tally.handled += 1;
    alertUnknownTerminalization(row);
  }
  return tally;
}

/**
 * P1 — dispatch attempts wedged in `sending`. BOTH BELTS, and they do DIFFERENT
 * jobs — see the note on the outer belt below before deleting either.
 *
 * The grace period is not evidence of a wedge by itself: a job the OutboxPoller
 * is still carrying is a normal delivery in progress, and terminalizing it would
 * race a real provider send. The absence of an in-flight outbox row is not
 * evidence by itself either: the outbox watchdog re-pends on a 15-minute window,
 * so a row can be momentarily un-owned while recovering normally, which is
 * exactly why `UNKNOWN_GRACE_MINUTES` must exceed that window.
 *
 * THE OUTER `NOT EXISTS` BELOW IS A BOUNDING ARM, NOT THE CORRECTNESS GUARD, AND
 * NO TEST PINS IT. The correctness guard is the same clause REPEATED inside
 * `terminalizeWedgedOutreach`'s CAS, which is what actually refuses a row the
 * watchdog re-pended after this unlocked scan; `does not terminalize a sending
 * row whose outbox row is re-pended after selection` is its sole pin. Deleting
 * this outer clause therefore leaves the whole suite GREEN — verified by probe,
 * not assumed — so it reads as redundant and is not.
 *
 * What it buys is a BOUNDED scan. Without it this statement selects every
 * past-grace `sending` row including the ones the CAS will reject, and those
 * rejects consume `scanLimit`. A backlog of more than `scanLimit` rows that are
 * past grace AND still legitimately in flight would then crowd genuinely wedged
 * rows out of every tick — starving the one sweep that can unwedge a location,
 * which is issue #915's failure mode arriving through the door built to close
 * it. That backlog has NOT been shown reachable in practice; the belt is cheap
 * insurance against a case whose cost is unbounded and whose likelihood is
 * merely unquantified.
 *
 * No batch predicate, and that absence is the point rather than an omission. A
 * wedged row on a halted or overdue batch is the case D12d singles out — the
 * halt sweep will not touch it, so this sweep is its ONLY resolver.
 *
 * The in-flight status list is spelled by hand, members AND order, per
 * `src/lib/shared/job-outbox-status.ts` — it is a byte-for-byte contract that
 * cannot be parameterized, and `ci:outbox-status` checks both.
 */
async function selectWedgedSendingOutreach(
  sql: Sql,
  scanLimit: number,
): Promise<WedgedOutreachRow[]> {
  return sql<WedgedOutreachRow[]>`
    SELECT o.id, o.account_id, o.business_id, o.batch_id
      FROM solicitation_outreach o
     WHERE o.delivery_status = 'sending'
       AND o.sending_at <= NOW() - make_interval(mins => ${UNKNOWN_GRACE_MINUTES})
       AND NOT EXISTS (
         SELECT 1 FROM job_outbox jo
          WHERE jo.topic = ${QUEUE_NAMES.SOLICITATION_SEND}
            AND jo.aggregate_id = o.id
            AND jo.status IN ('pending', 'dispatching', 'dispatched')
       )
     ORDER BY o.sending_at ASC
     LIMIT ${scanLimit}
  `;
}

/**
 * Terminalize ONE wedged Outreach row: the batch lock, the `sending` → `unknown`
 * CAS, the **Lazy child**'s terminal transition and the settlement join, in ONE
 * transaction. Returns whether the row moved.
 *
 * **LOCK ORDER IS BATCH → RUN THROUGHOUT**, the sole order in this lane. The
 * batch row is locked before anything, every `agent_runs` write follows it, and
 * `closeBatchIfSettled` re-takes the same batch lock last. Taking the run lock
 * first would be the ABBA deadlock `CloseBatchIfSettledInput.failure` exists to
 * prevent.
 *
 * ONE transaction is a correctness requirement, not tidiness. A split
 * implementation commits `unknown` and can then die before terminalizing the
 * child — leaving it `running` forever, which trips `deriveRunDisplayState`'s
 * 48h `stalled` rule and re-opens the wedge from the spine side, one row over.
 */
async function terminalizeWedgedOutreach(
  tx: TransactionSql,
  row: WedgedOutreachRow,
): Promise<boolean> {
  const [locked] = await tx<{ id: string }[]>`
    SELECT b.id
      FROM solicitation_batches b
     WHERE b.id = ${row.batch_id}::uuid
       AND b.account_id = ${row.account_id}::uuid
       AND b.business_id = ${row.business_id}::uuid
     FOR UPDATE OF b
  `;
  // ASSERT, do not branch. `solicitation_outreach.batch_id` is a foreign key and
  // the tenant triple came off the row itself, so a batch that is not there for
  // its own child's account and business is a broken invariant, not a race.
  // Same call this lane's join already makes (`closeBatchIfSettled` throws on
  // exactly this read).
  if (locked === undefined) {
    throw new Error(
      `sweepUnknownOutreach: batch ${row.batch_id} not found for outreach ${row.id}'s account and business`,
    );
  }

  // THE LIE WITH TEETH, and why it is spelled `unknown` here and `failed` one
  // statement below. On the OUTREACH ROW, `failed` would be a lie the restraint
  // policy acts on: its `over_contacted` check reads prior sends, so calling a
  // message that may already have reached a real person "not sent" can put that
  // customer in a future batch and email them twice. `unknown` is the honest
  // answer — possibly contacted, never a confirmed send. On the CHILD RUN,
  // `failed` is not that lie: nothing reads `agent_runs` for over-contact.
  //
  // 091 pairs `unknown` with `send_indeterminate` exclusively — never spell
  // either alone.
  //
  // THE `NOT EXISTS` IS REPEATED FROM P1 ON PURPOSE. P1 runs outside this
  // transaction, so the outbox watchdog can re-pend the row between the scan and
  // this UPDATE; a `delivery_status = 'sending'` guard alone would then write
  // `unknown` over a normal recovery already in flight. Zero rows means the
  // watchdog won — skip the row and write nothing else for it.
  const [terminal] = await tx<{ ask_id: string }[]>`
    UPDATE solicitation_outreach o
       SET delivery_status = 'unknown',
           disposition_reason = 'send_indeterminate',
           updated_at = NOW()
     WHERE o.id = ${row.id}::uuid
       AND o.account_id = ${row.account_id}::uuid
       AND o.business_id = ${row.business_id}::uuid
       AND o.delivery_status = 'sending'
       AND NOT EXISTS (
         SELECT 1 FROM job_outbox jo
          WHERE jo.topic = ${QUEUE_NAMES.SOLICITATION_SEND}
            AND jo.aggregate_id = o.id
            AND jo.status IN ('pending', 'dispatching', 'dispatched')
       )
    RETURNING o.ask_id
  `;
  if (terminal === undefined) return false;

  const child = await findRunningLazyChild(tx, row, terminal.ask_id);
  if (child !== null) {
    // NO `solicitation_sent` OUTCOME. D12d: `unknown` is "possibly contacted"
    // for over-contact purposes and NOT a confirmed send for metrics or
    // `review_attributed`, so the value ledger must stay silent about it.
    await completeRun(tx, child, 'failed', {
      code: SEND_INDETERMINATE_REASON,
      outreach_id: row.id,
    });
  }

  await closeBatchIfSettled(tx, {
    batchId: row.batch_id,
    accountId: row.account_id,
    businessId: row.business_id,
  });
  return true;
}

/**
 * The **Lazy child** left `running` by the process that died mid-dispatch.
 *
 * Resolved by subject rather than by `solicitation_outreach.agent_run_id`: the
 * child is per-dispatch-ATTEMPT and its subject is the ask, so the subject key
 * is the join `startOrGetSolicitationAskRun` itself writes. Scoped by account
 * AND business — `subject_id` is a bare TEXT key carrying no tenant proof.
 *
 * `status = 'running'` is what makes this the CRASHED attempt's child and not a
 * historical one: a terminal child belongs to an attempt that already accounted
 * for itself, and re-terminalizing it would be a no-op that reads like a fact.
 *
 * `null` is a legitimate answer, deliberately NOT an assertion — and the reason
 * is NOT the one this docstring used to give. Per-item isolation now means a
 * throw here would cost one row rather than the tick (`isolateItem`), so
 * "it would abort phases 2 and 3" is no longer true and is no longer the
 * argument. The argument is what a throw would DECLINE TO DO: the Outreach
 * terminalization is the act that unwedges the location, the child transition is
 * the spine's half of it, and refusing the first because the second has nothing
 * to write would leave the row `sending` forever — the exact wedge issue #915
 * exists to close, re-created by the sweep built to close it. A `sending` row
 * normally does have a running child (#899's tx1 mints it before the CAS); when
 * it does not, terminalizing the row alone is strictly better than terminalizing
 * neither.
 */
async function findRunningLazyChild(
  tx: TransactionSql,
  row: WedgedOutreachRow,
  askId: string,
): Promise<string | null> {
  const [child] = await tx<{ id: string }[]>`
    SELECT r.id
      FROM agent_runs r
     WHERE r.kind = 'solicitation_ask'
       AND r.subject_type = 'solicitation_ask'
       AND r.subject_id = ${askId}
       AND r.account_id = ${row.account_id}::uuid
       AND r.business_id = ${row.business_id}::uuid
       AND r.status = 'running'
     ORDER BY r.started_at DESC
     LIMIT 1
  `;
  return child?.id ?? null;
}

/**
 * The alert D12d requires, one per terminalization.
 *
 * It is the ONLY signal that a send may have reached a customer unattributably:
 * the row may correspond to a delivered email whose `provider_message_id` died
 * with the process that sent it, so nothing else in the system will ever
 * report it.
 *
 * Best-effort, AFTER the durable write and in its own catch, matching
 * `applyJudgeSplit` below: an alerting failure must never flip a completed
 * terminalization into a failed tick. ids only — this lane's rendered subject,
 * body and recipient handle never leave the database.
 */
function alertUnknownTerminalization(row: WedgedOutreachRow): void {
  try {
    Sentry.captureMessage(UNKNOWN_ALERT_MESSAGE, {
      level: 'warning',
      tags: { subsystem: 'solicitation-release', reason: SEND_INDETERMINATE_REASON },
      extra: {
        outreach_id: row.id,
        batch_id: row.batch_id,
        account_id: row.account_id,
        business_id: row.business_id,
      },
    });
  } catch {
    // The log line below is the fallback sink for Sentry itself being
    // unreachable, so it lives OUTSIDE this guard.
  }
  logger.warn(UNKNOWN_ALERT_MESSAGE, {
    outreach_id: row.id,
    batch_id: row.batch_id,
    account_id: row.account_id,
    business_id: row.business_id,
    reason: SEND_INDETERMINATE_REASON,
  });
}

// ── phase 2: the `send_window_elapsed` sweep ────────────────────────────────

/** The sweep projection, shared by P2, P3 and P5: the tenant triple and nothing
 *  else. P5 shares it because those three ids ARE `closeBatchIfSettled`'s whole
 *  input, so the backstop needs no projection of its own — the phases differ in
 *  predicate, not in what they read. Everything a **Halt latch** needs beyond
 *  it — the **Batch state** it
 *  stamps as `state_at_halt`, the **Send batch parent** it appends
 *  `batch_halted` to — the latch derives itself from the row it locks, so a
 *  second projection here would be a second reader of facts that must be read
 *  once, under that lock. One type, because both sweeps hand the latch the same
 *  three ids; the sweeps themselves stay separate — different predicate,
 *  different ordering column, different halt reason. */
interface SweepCandidateBatch {
  id: string;
  account_id: string;
  business_id: string;
}

/**
 * The `send_window_elapsed` sweep — an approved batch whose 72h send window ran
 * out, latched with no actor.
 *
 * Runs BEFORE the release phase (see the module header): an overdue batch must
 * never release, and reclaiming its `rendered`/`queued` rows is what frees 091's
 * `solicitation_batches_one_active_send_per_business` index for that location.
 *
 * ONE transaction per batch, and its whole body is the latch call. **The latch
 * owns the cancel, the spine step and the settlement join** — this sweep writes
 * nothing of its own, because a second writer of any of those three is a second
 * receipt for one halt. It does not hand-roll a `SELECT … FOR UPDATE` either:
 * `latchSystemHalt` re-reads the row `FOR UPDATE OF b` itself, and skips only
 * the ADVISORY lock, which no sweep takes.
 *
 * Counts what was LATCHED, not what was scanned. `not_latched` is a batch
 * another writer terminalized between the scan and the lock — nothing happened,
 * so nothing is reported.
 */
async function sweepSendWindowElapsed(sql: Sql, scanLimit: number): Promise<PhaseTally> {
  const batches = await selectSendWindowElapsedBatches(sql, scanLimit);

  const tally: PhaseTally = { handled: 0, failed: 0 };
  for (const batch of batches) {
    const result = await isolateItem(
      'send_window_sweep',
      { batch_id: batch.id, account_id: batch.account_id, business_id: batch.business_id },
      tally,
      () =>
        sql.begin(async (tx) =>
          latchSystemHalt(tx, {
            batchId: batch.id,
            accountId: batch.account_id,
            businessId: batch.business_id,
            reason: 'send_window_elapsed',
          }),
        ),
    );
    if (result?.status === 'latched') tally.handled += 1;
  }
  return tally;
}

/**
 * P2 — batches past the send window.
 *
 * `approved_at` is the anchor rather than `built_at`: the window this reason
 * names is the one that opens when the owner approves. `<=` is the boundary the
 * release predicate's `>` complements exactly, so no batch can be both overdue
 * and releasable in the same tick.
 *
 * No live-Outreach `EXISTS` arm, unlike P4. A batch whose rows are all terminal
 * but whose `send_closed_at` is still NULL is exactly the wedge this lane
 * exists to clear: it must be selected so the latch's join can close it.
 *
 * `halted_at IS NULL` also carries the idempotence — the latch's CAS makes the
 * halt monotone, so a batch this sweep already handled never comes back.
 */
async function selectSendWindowElapsedBatches(
  sql: Sql,
  scanLimit: number,
): Promise<SweepCandidateBatch[]> {
  return sql<SweepCandidateBatch[]>`
    SELECT id, account_id, business_id
      FROM solicitation_batches
     WHERE approved_at IS NOT NULL
       AND approved_at <= NOW() - make_interval(hours => ${BATCH_SEND_WINDOW_HOURS})
       AND halted_at IS NULL
       AND send_closed_at IS NULL
     ORDER BY approved_at ASC
     LIMIT ${scanLimit}
  `;
}

// ── phase 3: the `batch_expired` sweep ──────────────────────────────────────

/**
 * The `batch_expired` sweep (amendment B7) — a batch NEITHER lane approved
 * before its 7-day approval window ran out, latched with no actor.
 *
 * This is what makes D2's "≤10 days by construction" true for the never-approved
 * case, and B7 states the obligation as a test: such a batch closes cleanly and
 * raises no stalled alert. `deriveRunDisplayState` calls a **Send batch parent**
 * stalled at `STALLED_THRESHOLD_SEND_BATCH_DAYS` (11), so a sweep anchored on
 * the 7-day window makes that threshold unreachable rather than merely unlikely.
 *
 * Deliberately NOT sharing a body with `sweepSendWindowElapsed` above. The two
 * differ in predicate, in ordering column and in halt reason; what they share is
 * the latch, and the latch is already the one shared implementation.
 *
 * ONE transaction per batch, and its whole body is the latch call — the same
 * contract phase 2 keeps: **the latch owns the cancel, the spine step and the
 * settlement join**, and it re-reads the row `FOR UPDATE OF b` itself, so this
 * sweep hand-rolls no `SELECT … FOR UPDATE` of its own.
 *
 * Counts what was LATCHED, not what was scanned.
 */
async function sweepBatchExpired(sql: Sql, scanLimit: number): Promise<PhaseTally> {
  const batches = await selectExpiredBatches(sql, scanLimit);

  const tally: PhaseTally = { handled: 0, failed: 0 };
  for (const batch of batches) {
    const result = await isolateItem(
      'batch_expired_sweep',
      { batch_id: batch.id, account_id: batch.account_id, business_id: batch.business_id },
      tally,
      () =>
        sql.begin(async (tx) =>
          latchSystemHalt(tx, {
            batchId: batch.id,
            accountId: batch.account_id,
            businessId: batch.business_id,
            reason: 'batch_expired',
          }),
        ),
    );
    if (result?.status === 'latched') tally.handled += 1;
  }
  return tally;
}

/**
 * P3 — batches past the approval window with nobody having approved them.
 *
 * `built_at` is the anchor, because that is where `BATCH_APPROVAL_WINDOW_DAYS`
 * is anchored for its two other readers (`deriveBatchState` in JS,
 * `closeBatchIfSettled` in SQL) — the **Batch state** this sweep terminalizes is
 * exactly the deferred `expired` those two already derive. `<=` spells the same
 * boundary they do, so no batch can read `expired` on the owner's screen and
 * still be a release candidate here.
 *
 * **THE `EXISTS` OVER `agent_runs` IS THE PREDICATE'S POINT, not a refinement.**
 * It is what B7 means by "that have a Send batch parent". A WATCH-MODE batch has
 * no send lane at all: it was built, never dispatched, and no parent was ever
 * minted. Latching it would stamp `batch_expired` — a send-lane reason — on a
 * batch that was never in the send lane, and would cancel its Outreach rows with
 * a disposition describing a lane it never entered. Delete this arm and every
 * watch-mode batch in the platform is latched on its eighth day.
 *
 * `approved_at IS NULL` keeps P3 disjoint from P2 (which requires the opposite),
 * so the two sweeps can never both select one batch in a tick.
 *
 * `halted_at IS NULL` also carries the idempotence — the latch's CAS makes the
 * halt monotone, so a batch this sweep already handled never comes back.
 */
async function selectExpiredBatches(
  sql: Sql,
  scanLimit: number,
): Promise<SweepCandidateBatch[]> {
  return sql<SweepCandidateBatch[]>`
    SELECT b.id, b.account_id, b.business_id
      FROM solicitation_batches b
     WHERE b.approved_at IS NULL
       AND b.built_at IS NOT NULL
       AND b.built_at <= NOW() - make_interval(days => ${BATCH_APPROVAL_WINDOW_DAYS})
       AND b.halted_at IS NULL
       AND b.send_closed_at IS NULL
       AND EXISTS (
         SELECT 1 FROM agent_runs r
          WHERE r.kind = 'solicitation_send_batch'
            AND r.subject_type = 'solicitation_batch'
            AND r.subject_id = b.id::text
            AND r.account_id = b.account_id
            AND r.business_id = b.business_id
       )
     ORDER BY b.built_at ASC
     LIMIT ${scanLimit}
  `;
}

// ── phase 4: the release phase ──────────────────────────────────────────────

/** P4's projection. `sending_started_at` and `approval_window_open` are both
 *  here because the Judge split reads them to choose downgrade vs hold, and a
 *  HOLD must take no lock at all — so every fact that decision needs has to
 *  arrive with the candidate. `approval_window_open` is computed by the DATABASE
 *  clock for the reason every other window arm in this module is (#520: a JS
 *  `Date` round-trip loses microseconds). */
interface ReleaseCandidateBatch {
  id: string;
  account_id: string;
  business_id: string;
  sending_started_at: Date | null;
  approval_window_open: boolean;
}

/**
 * One row of P4's scan, which returns the candidate projection AND the fairness
 * arm's exclusion count in ONE statement. The batch half is nullable because a
 * cap-bound tick has no candidates and the count must still arrive; see
 * `selectReleaseCandidates` for why the count cannot come from anywhere else.
 */
interface ReleaseCandidateRow {
  capped_accounts_withheld: number;
  id: string | null;
  account_id: string | null;
  business_id: string | null;
  sending_started_at: Date | null;
  approval_window_open: boolean | null;
}

/** P4's scan, narrowed: the candidates the phase may act on, and the accounts
 *  the daily cap removed from the candidate window this tick. */
interface ReleaseCandidateScan {
  batches: ReleaseCandidateBatch[];
  cappedAccountsWithheld: number;
}

interface AccountSendPolicyRow {
  daily_send_cap: number | null;
}

interface AccountSubscriptionRow {
  subscription_status: string;
}

interface SendParentRow {
  send_parent_run_id: string | null;
}

/** What the Judge split did to one batch. `skipped` is the RACE arm: the CAS
 *  matched nothing, so nothing was downgraded and nothing was held. Two writers
 *  reach it — a concurrent **Halt latch**, and the approval window shutting
 *  between the scan and the lock. Both are one-tick states: the next tick
 *  re-scans and reports the honest outcome (`held`, or no candidate at all). */
type JudgeSplitOutcome = 'downgraded' | 'held' | 'skipped';

/**
 * Count withholds under one reason. `count` is a parameter for exactly one
 * caller — the fairness arm, which withholds a whole set of accounts at once —
 * and a zero or negative count writes NOTHING: an idle tick must report
 * `withheldByReason: {}` rather than a map of zeroes, because "no work was due"
 * and "work was withheld" are the two states this field exists to separate.
 */
function withhold(
  report: ReleaseCycleReport,
  reason: ReleaseWithheldReason,
  count = 1,
): void {
  if (count <= 0) return;
  report.withheldByReason[reason] = (report.withheldByReason[reason] ?? 0) + count;
}

/**
 * The release phase, governors in amendment B6's order.
 *
 * `releasePhaseStoppedBy` names a PHASE-level stop — the three checks below run
 * once and refuse every account. `withheldByReason` counts per-account and
 * per-batch withholds, including the running counters running out mid-tick.
 * The two are disjoint on purpose: an operator reading a stop reason is being
 * told "nothing could release", and one reading a withhold count is being told
 * "some rows could not, and here is which dial".
 */
async function runReleasePhase(
  sql: Sql,
  bounds: { perTickBudget: number; scanLimit: number },
  report: ReleaseCycleReport,
): Promise<void> {
  // 1. The master switch. Cheapest, and it asks "does this feature exist"
  //    before anything queries the database.
  if (!solicitationSendEnabled()) {
    report.releasePhaseStoppedBy = 'flag_off';
    return;
  }

  // 2. The **Send breaker**, and it gets NO try/catch. `readSendBreaker`
  //    returns state or THROWS, and the throw IS the halt signal (#622 §3.2B):
  //    a caller that catches it and proceeds has broken the invariant, and it
  //    would pass every "breaker open" test, because the breaker is not open.
  const breaker = await readSendBreaker(sql);
  if (breaker.open) {
    report.releasePhaseStoppedBy = 'breaker_open';
    return;
  }

  // 3. The platform ceiling. Cross-account by design — it is the blast-radius
  //    bound for a runaway fan-out, so a per-account view cannot express it.
  const platformCap = resolvePlatformDailyCap(
    getWorkerConfig().SOLICITATION_PLATFORM_DAILY_CAP,
  );
  let platformRemaining = platformCap - (await countPlatformDispatchAttemptsToday(sql));
  if (platformRemaining <= 0) {
    report.releasePhaseStoppedBy = 'platform_ceiling';
    return;
  }

  let budgetRemaining = bounds.perTickBudget;
  if (budgetRemaining <= 0) {
    withhold(report, 'per_tick_budget');
    return;
  }

  // Judge availability is read ONCE per tick and LAZILY: a tick with nothing
  // releasable must not pay for the health probe, and a tick with something
  // releasable must not ask twice and get two answers mid-drip.
  let judgeAvailability: boolean | undefined;
  const judgeAvailable = async (): Promise<boolean> => {
    if (judgeAvailability === undefined) {
      // BOTH reads fail closed (D18). `judgeEnabled()` first, so a switched-off
      // Judge never runs the probe — and never releases either.
      judgeAvailability = judgeEnabled() ? await isJudgeHealthy(sql) : false;
    }
    return judgeAvailability;
  };

  const scan = await selectReleaseCandidates(sql, bounds.scanLimit);
  // THE FAIRNESS ARM'S EXCLUSIONS ARE COUNTED HERE, and they must be: an
  // account the scan excluded never enters `byAccount`, so the per-account gate
  // below never runs for it and never reaches `withhold(report, 'account_cap')`.
  // Without this line a fully cap-bound tick reported `released: 0`,
  // `withheldByReason: {}` and `releasePhaseStoppedBy: null` — byte-identical to
  // a tick with no work due. That is the DESIGNED steady state, not an edge
  // case: the cap forces a 25-ask batch across at least three calendar days, so
  // most ticks of a healthy ramp are cap-bound, and this counter is the dial the
  // ramp reads to tell "paced" from "capped".
  withhold(report, 'account_cap', scan.cappedAccountsWithheld);
  const byAccount = groupByAccount(scan.batches);

  let stopPhase = false;
  let budgetWarned = false;
  /** Only `failed` is folded — this phase's "handled" is `report.released`. */
  const isolated = { failed: 0 };
  /** Warn, not info: the staging ramp reads this line to tell "paced" from
   *  "capped". Once per tick — the budget can only run out once. */
  const logBudgetExhausted = (): void => {
    if (budgetWarned) return;
    budgetWarned = true;
    logger.warn('Per-tick release budget exhausted; remainder deferred to the next tick', {
      per_tick_budget: bounds.perTickBudget,
      released: report.released,
    });
  };

  for (const [accountId, accountBatches] of byAccount) {
    if (stopPhase) break;
    if (budgetRemaining <= 0) {
      withhold(report, 'per_tick_budget');
      logBudgetExhausted();
      break;
    }
    if (platformRemaining <= 0) {
      withhold(report, 'platform_ceiling');
      break;
    }

    // THIS PHASE HAS TWO ISOLATION UNITS, and each one is the unit its work
    // actually belongs to (see `isolateItem`).
    //
    // The ACCOUNT is the outer one, and it covers exactly the two gate reads
    // below: the cap read and the subscription read are per-account questions,
    // so a throw from either costs that account its tick and no one else's.
    //
    // The BATCH is the inner one, and it is the finer unit the work inside the
    // batch loop deserves: `applyJudgeSplit`, `selectRenderedOutreach` and
    // `releaseOutreachRow` are per-batch and per-row, so one poisoned batch must
    // cost that batch and leave its SIBLINGS releasable. Without the inner
    // `try` a single failing batch discarded the account's whole remaining tick
    // — deterministically, every tick, until those batches crossed the 72h send
    // window — which is issue #915's wedge narrowed, not closed.
    //
    // Bare `try`s rather than `isolateItem` because the bodies' `continue` and
    // `break` target these loops and may not cross a function boundary.
    try {
      // 4. The account cap, BEFORE the subscription (B6's closing paragraph). The
      //    order matters and is silent when wrong: both gates refuse, only the
      //    reported reason lies, and the operator chases the wrong dial.
      const cap = resolveAccountDailySendCap({
        dailySendCap: await readAccountDailySendCap(sql, accountId),
      });
      let accountRemaining = cap - (await countAccountDispatchAttemptsToday(sql, accountId));
      if (accountRemaining <= 0) {
        withhold(report, 'account_cap');
        continue;
      }

      // 5. Entitlement, never a raw equality against 'active' (invariant #11). A
      //    lapsed subscription is RECOVERABLE inside the send window: the rows
      //    stay `rendered`, so paying resumes the drip with no intervention.
      const status = await readAccountSubscriptionStatus(sql, accountId);
      if (!subscriptionGrantsFullAccess(status)) {
        withhold(report, 'subscription');
        continue;
      }

      for (const batch of accountBatches) {
        try {
          if (budgetRemaining <= 0) {
            withhold(report, 'per_tick_budget');
            logBudgetExhausted();
            stopPhase = true;
            break;
          }
          if (platformRemaining <= 0) {
            withhold(report, 'platform_ceiling');
            stopPhase = true;
            break;
          }
          if (accountRemaining <= 0) {
            withhold(report, 'account_cap');
            break;
          }

          // 6. The Judge split, LAST and only for a batch that has passed every
          //    other gate and still has capacity. A downgrade is DESTRUCTIVE, so
          //    it must never fire for a batch the account cap alone would have
          //    stopped.
          if (!(await judgeAvailable())) {
            withhold(report, 'judge_unhealthy');
            const outcome = await applyJudgeSplit(sql, batch);
            if (outcome === 'downgraded') report.downgraded += 1;
            else if (outcome === 'held') report.heldForJudge += 1;
            continue;
          }

          const candidates = await selectRenderedOutreach(sql, batch, bounds.scanLimit);
          for (const outreachId of candidates) {
            if (budgetRemaining <= 0) {
              withhold(report, 'per_tick_budget');
              logBudgetExhausted();
              stopPhase = true;
              break;
            }
            if (platformRemaining <= 0) {
              withhold(report, 'platform_ceiling');
              stopPhase = true;
              break;
            }
            if (accountRemaining <= 0) {
              withhold(report, 'account_cap');
              break;
            }

            if (!(await releaseOutreachRow(sql, batch, outreachId))) continue;

            // All three, on EVERY release. See the module header.
            report.released += 1;
            budgetRemaining -= 1;
            platformRemaining -= 1;
            accountRemaining -= 1;
          }
        } catch (error) {
          // The batch id is what an operator needs to find the poisoned unit,
          // and the account-level catch below cannot name it.
          recordItemFailure(
            'release',
            { account_id: accountId, batch_id: batch.id },
            isolated,
            error,
          );
        }
      }
    } catch (error) {
      recordItemFailure('release', { account_id: accountId }, isolated, error);
    }
  }

  report.itemFailures += isolated.failed;
}

/**
 * P4 — release candidates.
 *
 * `veto_deadline_at IS NOT NULL` is D9's FAIL-CLOSED rule: a batch approved
 * through a path that forgot to stamp a deadline is never released, and is
 * never treated as "deadline already past" either. The `approved_at >` arm is
 * belt-and-braces behind P2 — the sweep has already run this tick, but a batch
 * can cross the window between the two, and the release transaction re-asserts
 * it a third time under the batch lock.
 *
 * **THE `capped_accounts` CTE IS A FAIRNESS ARM, and it is what stops a capped
 * account from starving the platform** (round-1 finding on P4 starvation). The
 * scan is `ORDER BY approved_at ASC LIMIT ${scanLimit}` and the account cap is
 * evaluated AFTER it, so before this arm existed a capped account's batches
 * stayed candidates for their whole 72h window while releasing nothing: one
 * account with 51+ locations, or five with 11+, fill the candidate window with
 * batches that can only be `continue`d, and every other account releases zero
 * until its rows age out and are cancelled. That is the locked edge case "no row
 * is skipped permanently" failing in the strongest possible way. Oldest-first
 * ordering makes it worse rather than better — the oldest approvals belong to
 * the accounts that have had the most time to spend a daily cap.
 *
 * **IT IS A BOUNDING ARM, NOT THE ENFORCED CAP**, and the distinction is the
 * same one P1's outer `NOT EXISTS` draws. `resolveAccountDailySendCap` stays the
 * single owner of the enforced number; this arm cannot re-derive it, because
 * `LEAST(configured, 10)` lives in TypeScript and a second SQL spelling of it
 * would be a second owner that can drift. What it uses instead is the fact that
 * makes the dial safe in the first place: **the dial moves toward restraint
 * only**, so a resolved cap is never ABOVE `DEFAULT_DAILY_SEND_CAP_ACCOUNT`, so
 * an account with that many dispatch attempts today is capped whatever it
 * configured. The arm can therefore only ever UNDER-exclude — an account that
 * lowered its own cap still reaches the TypeScript gate and is `continue`d
 * exactly as before — and never over-exclude, which would starve an account that
 * could still send. Under-excluding is the safe direction; over-excluding would
 * be a new defect.
 *
 * The counting basis is `queued_at` in the UTC day, matching
 * `countAccountDispatchAttemptsToday` including its trailing `AT TIME ZONE
 * 'UTC'` — that conversion is load-bearing, not redundant (see that function's
 * docstring). This is a bound, so a drift makes the arm weaker, never wrong.
 *
 * **THE ARM ALSO REPORTS WHAT IT EXCLUDED, and the shape of this statement is
 * what that costs** (round-2 finding on the silent `account_cap` counter). An
 * excluded account never reaches the per-account gate, so nothing downstream can
 * count it; the count has to come from the scan or not at all, and it has to
 * arrive even when the scan returns NO candidate rows — the fully cap-bound tick
 * is exactly the case the counter exists for. Hence one `eligible` CTE carrying
 * the whole candidate predicate ONCE, a `candidates` CTE that applies the
 * ordering and the `LIMIT` to the un-capped ones, a one-row `withheld` aggregate
 * over the capped ones, and a `LEFT JOIN` that keeps that single row when there
 * are no candidates. The alternative — a second statement — would be a SECOND
 * spelling of the candidate predicate, i.e. a second owner that can drift, which
 * is what this module refuses everywhere else.
 *
 * `COUNT(DISTINCT account_id)` over the CAPPED half of `eligible`, not over
 * `capped_accounts`: an account at its cap with nothing releasable withheld
 * nothing, and reporting it would make an idle tick look cap-bound — the very
 * confusion this counter removes.
 */
async function selectReleaseCandidates(
  sql: Sql,
  scanLimit: number,
): Promise<ReleaseCandidateScan> {
  const rows = await sql<ReleaseCandidateRow[]>`
    WITH capped_accounts AS (
      SELECT account_id
        FROM solicitation_outreach
       WHERE queued_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       GROUP BY account_id
      HAVING COUNT(*) >= ${DEFAULT_DAILY_SEND_CAP_ACCOUNT}
    ),
    eligible AS (
      SELECT b.id, b.account_id, b.business_id, b.approved_at, b.sending_started_at,
             b.built_at > NOW() - make_interval(days => ${BATCH_APPROVAL_WINDOW_DAYS})
               AS approval_window_open,
             EXISTS (
               SELECT 1 FROM capped_accounts c WHERE c.account_id = b.account_id
             ) AS account_capped
        FROM solicitation_batches b
       WHERE b.approved_at IS NOT NULL
         AND b.halted_at IS NULL
         AND b.send_closed_at IS NULL
         AND b.veto_deadline_at IS NOT NULL
         AND NOW() >= b.veto_deadline_at
         AND b.approved_at > NOW() - make_interval(hours => ${BATCH_SEND_WINDOW_HOURS})
         AND EXISTS (
           SELECT 1 FROM solicitation_outreach o
            WHERE o.batch_id = b.id
              AND o.account_id = b.account_id
              AND o.business_id = b.business_id
              AND o.delivery_status = 'rendered'
         )
    ),
    candidates AS (
      SELECT * FROM eligible
       WHERE NOT account_capped
       ORDER BY approved_at ASC
       LIMIT ${scanLimit}
    ),
    withheld AS (
      SELECT COUNT(DISTINCT account_id)::int AS capped_accounts_withheld
        FROM eligible
       WHERE account_capped
    )
    SELECT w.capped_accounts_withheld, c.id, c.account_id, c.business_id,
           c.sending_started_at, c.approval_window_open
      FROM withheld w
      LEFT JOIN candidates c ON TRUE
     ORDER BY c.approved_at ASC
  `;

  // The `LEFT JOIN` guarantees at least one row; a row with a NULL `id` is the
  // aggregate alone, not a batch. Every candidate column is NOT NULL in 091 or
  // computed non-null here, so one null id identifies that row completely.
  const batches: ReleaseCandidateBatch[] = [];
  for (const row of rows) {
    if (row.id === null || row.account_id === null || row.business_id === null) continue;
    if (row.approval_window_open === null) continue;
    batches.push({
      id: row.id,
      account_id: row.account_id,
      business_id: row.business_id,
      sending_started_at: row.sending_started_at,
      approval_window_open: row.approval_window_open,
    });
  }
  return { batches, cappedAccountsWithheld: rows[0]?.capped_accounts_withheld ?? 0 };
}

/** Insertion-ordered, so the oldest approval still leads inside each account. */
function groupByAccount(
  batches: readonly ReleaseCandidateBatch[],
): Map<string, ReleaseCandidateBatch[]> {
  const byAccount = new Map<string, ReleaseCandidateBatch[]>();
  for (const batch of batches) {
    const existing = byAccount.get(batch.account_id);
    if (existing === undefined) byAccount.set(batch.account_id, [batch]);
    else existing.push(batch);
  }
  return byAccount;
}

/** The account-level solicitation policy row. NULL — no row, or no configured
 *  cap — resolves to the platform default inside `resolveAccountDailySendCap`. */
async function readAccountDailySendCap(sql: Sql, accountId: string): Promise<number | null> {
  const [row] = await sql<AccountSendPolicyRow[]>`
    SELECT daily_send_cap
      FROM auto_approval_policies
     WHERE account_id = ${accountId}::uuid
       AND persona = 'solicitation'
       AND action_class = 'sending'
       AND location_id IS NULL
     LIMIT 1
  `;
  return row?.daily_send_cap ?? null;
}

async function readAccountSubscriptionStatus(
  sql: Sql,
  accountId: string,
): Promise<string | undefined> {
  const [row] = await sql<AccountSubscriptionRow[]>`
    SELECT subscription_status
      FROM accounts
     WHERE id = ${accountId}::uuid
  `;
  return row?.subscription_status;
}

async function selectRenderedOutreach(
  sql: Sql,
  batch: ReleaseCandidateBatch,
  scanLimit: number,
): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT o.id
      FROM solicitation_outreach o
     WHERE o.batch_id = ${batch.id}::uuid
       AND o.account_id = ${batch.account_id}::uuid
       AND o.business_id = ${batch.business_id}::uuid
       AND o.delivery_status = 'rendered'
     ORDER BY o.rendered_at ASC
     LIMIT ${scanLimit}
  `;
  return rows.map((row) => row.id);
}

/**
 * The Judge availability split (#619 D18), applied to ONE batch.
 *
 * **DOWNGRADE ONLY WHEN THE BATCH CAN ACTUALLY BE RE-APPROVED.** The downgrade's
 * whole promise is the one `user_visible_behavior` states — "the batch reappears
 * as approvable in the Requests panel" — so it is legal in exactly the two
 * conditions that keep that promise true, and a HOLD everywhere else:
 *
 *   - `sending_started_at IS NULL` — the drip has not begun. Mid-drip the batch
 *     cannot go back to the owner at all, and 091's
 *     `solicitation_batches_send_ordering` CHECK makes a mid-drip downgrade
 *     impossible at the database anyway.
 *   - `approval_window_open` — `built_at` is still inside
 *     `BATCH_APPROVAL_WINDOW_DAYS`. Past it the **Batch state** the downgrade
 *     leaves behind is the deferred `expired`, which `approveBatch` refuses (D2),
 *     so the batch does not reappear as approvable — it reappears as unactionable
 *     and P3 latches it `batch_expired` on the NEXT tick, destroying an
 *     owner-approved batch with no notification on either step (round-1 finding).
 *     Holding instead lets P2 terminalize it `send_window_elapsed`, which is the
 *     honest reason: what actually ran out is the send window.
 *
 * Both conditions are read from the candidate projection, i.e. from a SCAN-TIME
 * snapshot, so `downgradeApproval`'s CAS re-asserts the window under the batch
 * lock. This check is the CHEAP one that avoids taking a lock at all; the CAS is
 * the AUTHORITATIVE one.
 *
 * A HOLD writes nothing and takes no lock — every fact this decision needs
 * arrives on the candidate projection, so the batch is never even locked.
 * Releases resume on recovery, or the 72h window expires and the batch
 * terminalizes cancelled.
 */
async function applyJudgeSplit(
  sql: Sql,
  batch: ReleaseCandidateBatch,
): Promise<JudgeSplitOutcome> {
  if (batch.sending_started_at !== null || !batch.approval_window_open) return 'held';

  const parentRunId = await sql.begin(async (tx) => downgradeApproval(tx, batch));
  if (parentRunId === undefined) return 'skipped';

  // Best-effort, AFTER the durable write and in its own catch: an alerting
  // failure must never flip a completed downgrade into a failed tick.
  try {
    Sentry.captureMessage(DOWNGRADE_ALERT_MESSAGE, {
      level: 'warning',
      tags: { subsystem: 'solicitation-release', reason: JUDGE_UNAVAILABLE_REASON },
      extra: {
        batch_id: batch.id,
        account_id: batch.account_id,
        business_id: batch.business_id,
        send_parent_run_id: parentRunId,
      },
    });
  } catch {
    // Same shape as `emitConsentEvent` and `llmCircuitBreaker.emitTransition`:
    // the log line below is the fallback sink for Sentry itself being
    // unreachable, so it lives OUTSIDE this guard.
  }
  logger.warn(DOWNGRADE_ALERT_MESSAGE, {
    batch_id: batch.id,
    account_id: batch.account_id,
    business_id: batch.business_id,
    reason: JUDGE_UNAVAILABLE_REASON,
  });
  return 'downgraded';
}

/**
 * The downgrade, in its own transaction: lock the batch row, CAS the four
 * approval columns to NULL together, then record the spine step.
 *
 * Returns the Send batch parent's run id on a downgrade (`null` when the batch
 * never minted one), or `undefined` when the CAS matched nothing.
 *
 * **`halted_at IS NULL AND send_closed_at IS NULL` are load-bearing** (round-1
 * finding 7). A **Halt latch** does NOT clear `approved_at`. Without those two
 * arms a candidate that waited on the batch lock while an owner halted the
 * batch would still match: it would erase the approval evidence of an
 * already-terminalized batch and append a false `approval_downgraded` receipt
 * after the fact.
 *
 * **SO IS THE `built_at` ARM, and for the same reason one step further out**
 * (round-2 finding). `approval_window_open` reaches `applyJudgeSplit` on the
 * candidate projection, i.e. as a SCAN-TIME snapshot; the window can shut
 * between that scan and this lock, and a downgrade taken a moment after it shut
 * reproduces exactly the chain the hold exists to prevent — `expired` **Batch
 * state**, `approveBatch` refuses it (D2), P3 latches `batch_expired` next tick,
 * no notification on either step. Re-asserting the window HERE makes the
 * decision against the row under lock, spelled in SQL so the DATABASE clock
 * decides it, exactly as the send-window arm in `releaseOutreachRow` is.
 *
 * All four approval columns move together, or the Requests panel shows a batch
 * it cannot act on — 091's approval-consistency CHECK says the same thing.
 */
async function downgradeApproval(
  tx: TransactionSql,
  batch: ReleaseCandidateBatch,
): Promise<string | null | undefined> {
  const [locked] = await tx<SendParentRow[]>`
    SELECT (
             SELECT r.id
               FROM agent_runs r
              WHERE r.kind = 'solicitation_send_batch'
                AND r.subject_type = 'solicitation_batch'
                AND r.subject_id = b.id::text
                AND r.account_id = ${batch.account_id}::uuid
                AND r.business_id = ${batch.business_id}::uuid
              ORDER BY r.started_at DESC
              LIMIT 1
           ) AS send_parent_run_id
      FROM solicitation_batches b
     WHERE b.id = ${batch.id}::uuid
       AND b.account_id = ${batch.account_id}::uuid
       AND b.business_id = ${batch.business_id}::uuid
     FOR UPDATE OF b
  `;
  if (locked === undefined) return undefined;

  const [downgraded] = await tx<{ id: string }[]>`
    UPDATE solicitation_batches
       SET approved_at = NULL,
           approval_method = NULL,
           approved_by_user_id = NULL,
           veto_deadline_at = NULL
     WHERE id = ${batch.id}::uuid
       AND account_id = ${batch.account_id}::uuid
       AND business_id = ${batch.business_id}::uuid
       AND approved_at IS NOT NULL
       AND sending_started_at IS NULL
       AND halted_at IS NULL
       AND send_closed_at IS NULL
       AND built_at > NOW() - make_interval(days => ${BATCH_APPROVAL_WINDOW_DAYS})
    RETURNING id
  `;
  if (downgraded === undefined) return undefined;

  // The DURABLE record; the Sentry warning is ephemeral. No owner notification
  // (locked decision 4) — the batch simply reappears as approvable, which the
  // CAS's own `built_at` arm above is what makes true.
  if (locked.send_parent_run_id !== null) {
    await recordStep(tx, {
      runId: locked.send_parent_run_id,
      stepKey: 'approval_downgraded',
      detail: { reason: JUDGE_UNAVAILABLE_REASON },
    });
  }
  return locked.send_parent_run_id;
}

/**
 * Release ONE Outreach row: the batch lock, the `rendered` → `queued` CAS, the
 * `sending_started_at` stamp and the `job_outbox` row, in ONE transaction
 * (invariant #2). Returns whether the row moved.
 *
 * THE LOCKED RE-READ IS LOAD-BEARING (round-1 finding 8). P4 selects candidates
 * before the tick takes any lock, so a candidate that then waits on the batch
 * lock — behind the `send_window_elapsed` sweep, or behind a long release — can
 * become halted, closed or overdue in the meantime. Re-asserting all four arms
 * under the lock is what stops a release after the terminal deadline; the
 * window arm is spelled in SQL so the DATABASE clock decides it.
 *
 * A `false` from the CAS means another writer moved the row first — skip it and
 * enqueue nothing.
 */
async function releaseOutreachRow(
  sql: Sql,
  batch: ReleaseCandidateBatch,
  outreachId: string,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [locked] = await tx<{ id: string }[]>`
      SELECT b.id
        FROM solicitation_batches b
       WHERE b.id = ${batch.id}::uuid
         AND b.account_id = ${batch.account_id}::uuid
         AND b.business_id = ${batch.business_id}::uuid
         AND b.approved_at IS NOT NULL
         AND b.halted_at IS NULL
         AND b.send_closed_at IS NULL
         AND b.approved_at > NOW() - make_interval(hours => ${BATCH_SEND_WINDOW_HOURS})
       FOR UPDATE OF b
    `;
    if (locked === undefined) return false;

    const [moved] = await tx<{ id: string }[]>`
      UPDATE solicitation_outreach
         SET delivery_status = 'queued',
             queued_at = NOW(),
             updated_at = NOW()
       WHERE id = ${outreachId}::uuid
         AND account_id = ${batch.account_id}::uuid
         AND business_id = ${batch.business_id}::uuid
         AND delivery_status = 'rendered'
      RETURNING id
    `;
    if (moved === undefined) return false;

    // Decision 6: stamped in the FIRST release transaction, CAS on NULL. It is
    // the boundary between "a Judge outage may return this batch to the owner"
    // and "a Judge outage may only hold it", so a second stamp would move a
    // batch back across a line it has already crossed.
    await tx`
      UPDATE solicitation_batches
         SET sending_started_at = NOW()
       WHERE id = ${batch.id}::uuid
         AND account_id = ${batch.account_id}::uuid
         AND business_id = ${batch.business_id}::uuid
         AND sending_started_at IS NULL
    `;

    const outboxId = await enqueueSolicitationSend(tx, {
      outreachId,
      batchId: batch.id,
      businessId: batch.business_id,
    });
    // ASSERT, do not branch. A row whose `rendered` → `queued` CAS just
    // succeeded cannot already own an in-flight send job, so `null` here is a
    // bug in one of the two guards. Handling it defensively would hide the bug
    // and leave a `queued` row with no job — the one state P4 can never select
    // again.
    if (outboxId === null) {
      throw new Error(
        `runReleaseCycle: outreach ${outreachId} moved rendered -> queued but already owns an in-flight solicitation_send job`,
      );
    }
    return true;
  });
}
