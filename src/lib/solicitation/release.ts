// The Solicitation release lane (#900) — one deep module behind one function.
//
// PHASE ORDER, and the order is the contract rather than an implementation
// detail:
//
//   1. `unknown` sweep (D12d)   — first, so a wedged row can settle its batch
//                                 in this same tick.
//   2. `send_window_elapsed` /  — before release, so an overdue batch never
//      `platform_halt` (#917)     releases. ONE sweep on ONE clock; which of the
//                                 two reasons it writes depends on whether the
//                                 **Send breaker** is open this tick.
//   3. `batch_expired` (B7)
//   3.5. Veto anchor (#631 D9)  — CASes `veto_deadline_at` on `auto_policy`
//                                 batches (`anchorVetoDeadlines`,
//                                 auto-approval.ts), inserted here rather than
//                                 renumbered into the P1-P5 labels the rest of
//                                 this file uses (those stay as-is below): it
//                                 MUST precede phase 4 — its output is P4's
//                                 `veto_deadline_at IS NOT NULL` precondition,
//                                 fail-closed — no anchor, no release, ever.
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
import { lockAutonomyAccount } from '@/lib/auto-approval/account-lock';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import { getWorkerConfig } from '@/lib/config/worker';
import { judgeEnabled } from '@/lib/responses/judge-flags';
import { isJudgeHealthy } from '@/lib/responses/judge-health';
import { enqueueSolicitationSend } from '@/lib/shared/job-outbox-helpers';
import { createWorkerLogger, toError } from '@/lib/shared/logger';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';
import { latchSystemHalt } from './approval';
import type { SystemHaltReason } from './approval';
import {
  anchorVetoDeadlines,
  findAutoDowngradeReason,
  type AutoDowngradeReason,
} from './auto-approval';
import { solicitationSendEnabled } from './flags';
import {
  BATCH_APPROVAL_WINDOW_DAYS,
  BATCH_SEND_WINDOW_HOURS,
  closeBatchIfSettled,
  UNKNOWN_GRACE_MINUTES,
} from './outreach';
import {
  alertPhaseFailure,
  isolateItem,
  tallyPhase,
  type PhaseTally,
} from './release-phases';
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

/**
 * Every reason a downgrade can carry (#631 decision 7): the Judge arm's one
 * reason, plus the Auto-approval lane's four re-check reasons. The spine step and the
 * Sentry tag both carry the member that actually failed — `downgradeApproval`
 * no longer hard-codes `judge_unavailable` (R1 finding 5).
 */
type DowngradeReason = typeof JUDGE_UNAVAILABLE_REASON | AutoDowngradeReason;

/** Stable Sentry title — Sentry groups `captureMessage` by its text, so one
 *  title collapses a fleet-wide Judge outage into ONE issue that keeps
 *  receiving events rather than N issues. */
const DOWNGRADE_ALERT_MESSAGE = 'Solicitation batch approval downgraded: Judge unavailable';

/** Stable Sentry title for the Auto-approval lane's downgrades (#631 decision 6) — a
 *  SEPARATE title from the Judge one so a Governor trip or an entitlement
 *  lapse never files into the Judge-outage issue; the exact failed condition
 *  is the `reason` tag. */
const AUTO_DOWNGRADE_ALERT_MESSAGE =
  'Solicitation batch approval downgraded: auto-approval conditions failed';

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

/** Stable title for the ONE degraded path in phase 2's labelling read (#917):
 *  the **Send breaker** probe threw, so this tick cannot tell a platform halt
 *  from an ordinary expiry and falls back to the blander reason. A constant for
 *  the same grouping reason as the two titles above. NOT an alert: nothing is
 *  wrong with the sweep, only with the precision of one column. */
const WINDOW_REASON_UNKNOWN_MESSAGE =
  'Solicitation send-window halt reason degraded: breaker state unreadable';

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
  | 'per_tick_budget'
  // #631 rev 2.1 (decision 6): an `auto_policy` batch whose four auto
  // conditions failed INSIDE `releaseOutreachRow`'s transaction — after the
  // arm-level re-check passed. The row stays `rendered`; the NEXT tick's
  // arm-level check performs the durable downgrade.
  | 'auto_conditions';

export interface ReleaseCycleReport {
  released: number;
  /** Batches the Veto anchor CASed a `veto_deadline_at` onto this tick (#631
   *  Task 6, `anchorVetoDeadlines`) — decision 4's MIN(sent_at) anchor, run
   *  immediately before the release phase, every tick. */
  anchored: number;
  /** The FIRST gate that stopped the whole release phase, or null when it ran. */
  releasePhaseStoppedBy: ReleaseWithheldReason | null;
  /** Per-account and per-batch withholds, counted by reason. */
  withheldByReason: Partial<Record<ReleaseWithheldReason, number>>;
  downgraded: number;
  heldForJudge: number;
  /** Auto-lane downgrades by the exact condition that failed (#631 decision
   *  6), incremented only on a `'downgraded'` outcome. DISJOINT from
   *  `downgraded`, which stays the Judge arm's counter — one operator
   *  question ("did the Judge outage un-approve batches?") must never be
   *  answered by the other lane's number. */
  autoDowngradedByReason: Partial<Record<AutoDowngradeReason, number>>;
  /** Batches the P2 sweep terminalized with `send_window_elapsed` — the window
   *  ran out and sending was NOT halted platform-wide. */
  sendWindowElapsed: number;
  /** Batches the SAME P2 sweep terminalized with `platform_halt` (#917) — the
   *  window ran out while the **Send breaker** was open. One sweep, two
   *  counters: an operator reading the tick line must be able to tell "72 hours
   *  passed" from "we stopped everyone", because only the second is RepWorth's
   *  fault and only the second makes the trip's blast radius visible. */
  platformHalted: number;
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

export interface ReleaseCycleOptions {
  /** Outreach rows released platform-wide per tick. Default RELEASE_PER_TICK_BUDGET. */
  perTickBudget?: number;
  /** Candidate rows scanned per phase. Default RELEASE_SCAN_LIMIT. */
  scanLimit?: number;
}

/**
 * The drip's pacing lever, and the only one this lane owns.
 *
 * The deliverability spec §7.1 asks dispatch to YIELD to transactional mail on
 * the shared 10 req/s Resend TEAM limit. The releaser is the only producer of
 * `solicitation_send` jobs, so bounding its output per tick is the scheduling
 * act available to it. At a 60s cadence a full 10-row account daily cap drips
 * over five minutes. True priority-yielding against a shared limiter is NOT
 * built here.
 *
 * **THAT IS A REFUSAL, AND IT IS RECORDED RATHER THAN IMPLIED — ADR 0022
 * (#923).** This is a rate CAP, not a yield: it is open-loop and never reads
 * what the transactional lane is doing, so under a transactional spike it does
 * not defer, because it cannot see one. The ADR accepts that, and the
 * arithmetic is why: 10 req/s is ~864,000 sends/day, §3.3's ramp tops out at a
 * 5,000/day platform ceiling (~0.6% of the limit), and two per minute is
 * 0.033 req/s (~0.33%). Two per minute against ten per second is not
 * contention.
 *
 * **RAISING THIS NUMBER SPENDS THAT REFUSAL**, and it is one of four dials that
 * do — the others are the poll interval, send-worker concurrency, and any
 * second producer on the same Resend team.
 * `__tests__/dispatch-rate-bound.test.ts` pins all of them and fails with the
 * ADR named, so the change lands on a human rather than in a diff.
 */
export const RELEASE_PER_TICK_BUDGET = 2;

/** Rows scanned per phase per tick. Bounds the tick, and every phase logs what it dropped. */
export const RELEASE_SCAN_LIMIT = 50;

// The per-item isolation idiom (`isolateItem`/`recordItemFailure`), the
// phase-level alerting sink (`alertPhaseFailure`) and the tally vocabulary
// (`PhaseTally`/`tallyPhase`) live in `./release-phases` — the shared seam the
// **Veto anchor** (`auto-approval.ts`) consumes too, extracted so the
// isolate-don't-poison-the-tick idiom (#915) has exactly one owner.

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
    anchored: 0,
    releasePhaseStoppedBy: null,
    withheldByReason: {},
    downgraded: 0,
    heldForJudge: 0,
    autoDowngradedByReason: {},
    sendWindowElapsed: 0,
    platformHalted: 0,
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
  // ONE read of the **Send breaker** for the whole of phase 2, taken before the
  // scan (#917). Every batch this tick terminalizes is terminalized under one
  // platform state, so a per-batch re-read would spend N probes describing an
  // instant that cannot meaningfully differ inside a tick — and would move a
  // label-only decision inside the latch transaction, where a probe failure
  // would poison the halt rather than the label.
  //
  // The PHASE TAG stays `send_window_elapsed` in both arms on purpose: it names
  // the phase, not the reason the phase wrote, and splitting it would fork one
  // phase's alert history into two tags the day a breaker first trips.
  const windowHaltReason = await resolveWindowHaltReason(sql);
  const windowHalted = tallyPhase(
    report,
    await alertPhaseFailure('send_window_elapsed', () =>
      sweepSendWindowElapsed(sql, scanLimit, windowHaltReason),
    ),
  );
  if (windowHaltReason === 'platform_halt') report.platformHalted = windowHalted;
  else report.sendWindowElapsed = windowHalted;
  report.batchExpired = tallyPhase(
    report,
    await alertPhaseFailure('batch_expired', () => sweepBatchExpired(sql, scanLimit)),
  );
  // The Veto anchor (#631 Task 6, decision 4) — MUST run before the release
  // phase: P4's scan requires `veto_deadline_at IS NOT NULL`, so an
  // `auto_policy` batch can never release in the same tick it is anchored on
  // (this phase and P4 read a DIFFERENT snapshot of the row either way — the
  // anchor commits in its own transaction per candidate, before P4's scan
  // runs), and D9 is fail-closed: no anchor, no release, ever.
  report.anchored = tallyPhase(
    report,
    await alertPhaseFailure('veto_anchor', () => anchorVetoDeadlines(sql, scanLimit)),
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
    // NOT `batchDidClose` (outreach.ts), deliberately: that predicate answers
    // "is the batch closed?" for a RECEIPT, so it counts `already_closed` — a
    // race loser, not an event — and would double-count it into this tally.
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
 * PER-ROW, and structurally unlike the two sweeps that follow it. Those two are
 * ONE body, `sweepSystemHalt`, which latches a BATCH and hands its whole
 * transaction to `latchSystemHalt`; this one terminalizes ONE Outreach row,
 * terminalizes that row's **Lazy child**, and joins — three writes this module
 * owns, in one transaction per row. It does NOT join `sweepSystemHalt`, and the
 * reason is the transaction rather than the loop: the loop shape is the same,
 * the writes inside it are not, and a parameter cannot express that difference.
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
 * The shared body of the two system-halt sweeps, phases 2 and 3.
 *
 * The two differ in exactly three values — the candidate predicate, the
 * isolation label and the halt reason — and in nothing else. An earlier comment
 * here argued they should stay separate bodies "because they differ in
 * predicate, ordering column and halt reason"; every one of those three is a
 * parameter, so the argument named the parameters rather than a reason not to
 * take them, and two byte-identical bodies had to be kept in step by hand.
 *
 * ONE transaction per batch, and its whole body is the latch call. **The latch
 * owns the cancel, the spine step and the settlement join** — a sweep writes
 * nothing of its own, because a second writer of any of those three is a second
 * receipt for one halt. Neither sweep hand-rolls a `SELECT … FOR UPDATE`:
 * `latchSystemHalt` re-reads the row `FOR UPDATE OF b` itself, and skips only
 * the ADVISORY lock, which no sweep takes.
 *
 * Counts what was LATCHED, not what was scanned. `not_latched` is a batch
 * another writer terminalized between the scan and the lock — nothing happened,
 * so nothing is reported.
 */
async function sweepSystemHalt(
  sql: Sql,
  scanLimit: number,
  spec: {
    label: string;
    reason: SystemHaltReason;
    select: (sql: Sql, scanLimit: number) => Promise<SweepCandidateBatch[]>;
  },
): Promise<PhaseTally> {
  const batches = await spec.select(sql, scanLimit);

  const tally: PhaseTally = { handled: 0, failed: 0 };
  for (const batch of batches) {
    const result = await isolateItem(
      spec.label,
      { batch_id: batch.id, account_id: batch.account_id, business_id: batch.business_id },
      tally,
      () =>
        sql.begin(async (tx) =>
          latchSystemHalt(tx, {
            batchId: batch.id,
            accountId: batch.account_id,
            businessId: batch.business_id,
            reason: spec.reason,
          }),
        ),
    );
    if (result?.status === 'latched') tally.handled += 1;
  }
  return tally;
}

/**
 * The two reasons phase 2's latch can write. A compile-time `Extract` rather
 * than a hand-spelled union so it cannot drift from `SystemHaltReason`, and
 * narrower than it so `batch_expired` — phase 3's reason — is a type error here.
 */
type WindowHaltReason = Extract<SystemHaltReason, 'send_window_elapsed' | 'platform_halt'>;

/**
 * Which reason phase 2 writes this tick (#917).
 *
 * The send window and the **Send breaker** run on different clocks and nothing
 * reconciled them: `BATCH_SEND_WINDOW_HOURS` is anchored on `approved_at` and
 * keeps running while a trip is open, and a real trip stays open for days. So
 * one trip took every batch approved in the preceding 72 hours, across every
 * account, to `cancelled / send_window_elapsed` — telling each owner their send
 * window elapsed, for a platform-wide cause that had nothing to do with their
 * list. This function is the whole fix: same sweep, same clock, truer reason.
 *
 * **THE SWEEP IS NOT SUPPRESSED WHILE THE BREAKER IS OPEN, and that is amendment
 * B14's decision rather than an omission here.** Holding those batches past
 * their window blows through the "<=10 days by construction" bound that
 * `STALLED_THRESHOLD_SEND_BATCH_DAYS = 11` derives from, and
 * `solicitation_send_batch_stalled` then fires for every one of them, burying
 * the trip an operator is actually working under an alert storm. A cancelled
 * batch is an honest terminal state an owner can act on; a stalled run is not.
 *
 * ── THIS IS A LABELLING READ, AND ITS try/catch IS NOT THE INVARIANT VIOLATION
 *    `readSendBreaker` WARNS ABOUT ────────────────────────────────────────────
 *
 * That function's contract says a caller which wraps it in try/catch **and
 * proceeds to send** has broken the fail-closed invariant. The operative half is
 * "and proceeds to send". Nothing downstream of this call sends: phase 2 only
 * CANCELS, and the gate that decides whether anything may be dispatched is
 * `runReleasePhase`'s own `readSendBreaker` call, which still has no try/catch
 * and still aborts the tick on a throw. Fail-closed on sending is untouched.
 *
 * What a rethrow here would cost is the sweep itself, and that cost is the
 * permanent wedge issue #915 exists to close: an unswept batch keeps its
 * `rendered`/`queued` rows, so migration 091's
 * `solicitation_batches_one_active_send_per_business` index blocks that location
 * forever. The module header already refuses to flag-gate this phase for exactly
 * that reason; letting a probe failure stop it would reintroduce the wedge
 * through a different door.
 *
 * So the failure mode is bounded to a LABEL: during a database blip that also
 * hides an open trip, an expiring batch reads `send_window_elapsed` when
 * `platform_halt` was truer. That is the direction to fail in — the fallback
 * never CLAIMS a platform halt it could not establish, and an unproven
 * accusation against the platform is worse than a bland one.
 *
 * ── THE READ-TO-LATCH WINDOW IS NOT A HOLE, AND THE LEVEL READ IS NOT MERELY
 *    THE CHEAP CHOICE ───────────────────────────────────────────────────────
 *
 * This runs once, before the scan; the latches commit after it. Both drift
 * directions were checked and both land on the truer label:
 *
 *   - **Trips AFTER this read.** A batch latched `send_window_elapsed` was
 *     already past its window when the tick began, so the trip is YOUNGER than
 *     the expiry and did not cause it. `send_window_elapsed` is correct.
 *   - **Reset AFTER this read.** A batch latched `platform_halt` had its window
 *     run out while sending was halted. A reset seconds later does not undo
 *     that. `platform_halt` is correct.
 *
 * The one case that reads blander than the full history is a trip that opened
 * and CLOSED inside the batch's own window — the breaker is shut by sweep time,
 * so this returns `send_window_elapsed`. That is right too: after the reset the
 * release phase was free to drip the batch at the per-tick budget, so a batch
 * that still expired was not, in the end, bound by the halt. Reading the whole
 * overlap history instead would attribute to a platform halt a batch that had
 * clear runway and did not use it — over-claiming, which is the failure this
 * reason exists to end rather than to invert.
 */
async function resolveWindowHaltReason(sql: Sql): Promise<WindowHaltReason> {
  try {
    const breaker = await readSendBreaker(sql);
    return breaker.open ? 'platform_halt' : 'send_window_elapsed';
  } catch (error) {
    // Never silent: the label is degraded and an operator reading a
    // `send_window_elapsed` cancellation from this tick must be able to learn
    // that the reason was a fallback rather than a measurement.
    logger.warn(WINDOW_REASON_UNKNOWN_MESSAGE, {
      error: toError(error).message,
      fallback_reason: 'send_window_elapsed',
    });
    return 'send_window_elapsed';
  }
}

/**
 * The send-window sweep — an approved batch whose 72h send window ran out,
 * latched with no actor, under one of two reasons (see `resolveWindowHaltReason`).
 *
 * Runs BEFORE the release phase (see the module header): an overdue batch must
 * never release, and reclaiming its `rendered`/`queued` rows is what frees 091's
 * `solicitation_batches_one_active_send_per_business` index for that location.
 *
 * The reason is a PARAMETER, resolved once per tick by the caller, so this
 * function stays one sweep with one predicate. Two sweeps would be two
 * predicates to keep disjoint, over the same rows, for a difference that is a
 * single column value.
 */
async function sweepSendWindowElapsed(
  sql: Sql,
  scanLimit: number,
  reason: WindowHaltReason,
): Promise<PhaseTally> {
  return sweepSystemHalt(sql, scanLimit, {
    label: 'send_window_sweep',
    reason,
    select: selectSendWindowElapsedBatches,
  });
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
 * Its ONLY difference from phase 2 is the three values below; everything else is
 * `sweepSystemHalt`, which carries the transaction and latch-ownership contract.
 */
async function sweepBatchExpired(sql: Sql, scanLimit: number): Promise<PhaseTally> {
  return sweepSystemHalt(sql, scanLimit, {
    label: 'batch_expired_sweep',
    reason: 'batch_expired',
    select: selectExpiredBatches,
  });
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
  /** How the batch was approved (#631 decision 6): `'auto_policy'` routes the
   *  batch through the Auto-approval lane's release-time re-check and the in-tx
   *  release guard; the owner lane skips both. Nullable in the TYPE because
   *  the column is, though the scan's `approved_at IS NOT NULL` arm plus
   *  091's approval-consistency CHECK mean a selected row always carries one. */
  approval_method: string | null;
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
  approval_method: string | null;
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

/** What a downgrade split did to one batch — shared by the Judge arm and the
 *  Auto-approval lane's re-check (#631 decision 7). `skipped` is the RACE arm: the CAS
 *  matched nothing (or, on the auto arm, the serialized in-tx re-read found
 *  the conditions healthy again), so nothing was downgraded and nothing was
 *  held. The other writers that reach it — a concurrent **Halt latch**, and
 *  the approval window shutting between the scan and the lock — are one-tick
 *  states: the next tick re-scans and reports the honest outcome (`held`, or
 *  no candidate at all). */
type DowngradeSplitOutcome = 'downgraded' | 'held' | 'skipped';

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
 * The three capacity gates in amendment B6's fixed order, asked as ONE question.
 *
 * The release phase re-asks them at three nesting depths — before an account,
 * before a batch, before a row — because a release consumes all three counters
 * at once and any one of them can run out between two rows. Spelling the ladder
 * out at each depth is what made the two inner copies byte-identical clones.
 *
 * It returns the reason and decides nothing else. WHICH loop ends, and whether
 * the whole phase stops, is the caller's to decide, and the callers differ.
 */
function capacityStop(
  budgetRemaining: number,
  platformRemaining: number,
  accountRemaining: number,
): ReleaseWithheldReason | null {
  if (budgetRemaining <= 0) return 'per_tick_budget';
  if (platformRemaining <= 0) return 'platform_ceiling';
  if (accountRemaining <= 0) return 'account_cap';
  return null;
}

/**
 * The three counters ONE release spends at once, held in one mutable object.
 *
 * Mutable and shared BY REFERENCE on purpose: the account arm and the batch arm
 * below both spend them, and three separate `let`s cannot cross a function
 * boundary. `account` is re-seeded per account from that account's cap read;
 * `budget` and `platform` live for the whole tick.
 */
interface ReleaseCounters {
  budget: number;
  platform: number;
  account: number;
}

/**
 * What the two release arms need from their enclosing tick.
 *
 * It exists so the arms can be MODULE-SCOPE functions rather than bodies nested
 * five levels deep inside `runReleasePhase`. `sql` arrives here as a parameter
 * and is never imported (invariant #15).
 */
interface ReleaseArmContext {
  sql: Sql;
  scanLimit: number;
  report: ReleaseCycleReport;
  counters: ReleaseCounters;
  /** Only `failed` is folded — this phase's "handled" is `report.released`. */
  isolated: { failed: number };
  /** Read ONCE per tick and lazily; see its definition in `runReleasePhase`. */
  judgeAvailable: () => Promise<boolean>;
  /** All THREE counters. Sets the tick-wide stop for the two that are tick-wide. */
  capacityExhausted: () => boolean;
}

/**
 * The batch arm — release rows of ONE batch.
 *
 * `'stop'` means a counter ended the batch loop; the caller decides whether the
 * whole phase stops, which it learns from the tick-wide stop flag rather than
 * from this return value.
 */
async function runBatchArm(
  ctx: ReleaseArmContext,
  batch: ReleaseCandidateBatch,
): Promise<'next' | 'stop'> {
  if (ctx.capacityExhausted()) return 'stop';

  // 5.5. The Auto-approval lane's release-time re-check (#631 decision 6), BEFORE the
  //      Judge split and ONLY for `auto_policy` batches: the auto flag, the
  //      Autopilot tier, the policy row's presence and the account-wide
  //      Governor suspension. Subscription and the master send flag are NOT
  //      consulted here — B14/B15: the first is the recoverable `subscription`
  //      withhold `runAccountArm` already applied, the second stopped the
  //      whole phase before any arm ran. This quick read is UNLOCKED and
  //      advisory; `applyAutoDowngrade` re-reads under the batch + account
  //      locks before anything is written, and a re-read that passes is a
  //      quiet skip. It runs before the Judge split so an auto batch that
  //      lost its mandate is downgraded for the TRUE reason, never filed
  //      under a coincident Judge outage.
  if (batch.approval_method === APPROVAL_METHOD.AUTO_POLICY) {
    const armReason = await findAutoDowngradeReason(ctx.sql, batch.account_id);
    if (armReason !== null) {
      const { outcome, reason } = await applyAutoDowngrade(ctx.sql, batch, armReason);
      if (outcome === 'downgraded') {
        ctx.report.autoDowngradedByReason[reason] =
          (ctx.report.autoDowngradedByReason[reason] ?? 0) + 1;
      }
      // `held` and `skipped` write nothing and count nothing: a mid-drip
      // batch waits (the drip cannot go back to the owner), a raced-back
      // skip was never a failure. The Judge counters stay untouched either
      // way (`downgraded` is the Judge arm's number).
      return 'next';
    }
  }

  // 6. The Judge split, LAST and only for a batch that has passed every other
  //    gate and still has capacity. A downgrade is DESTRUCTIVE, so it must never
  //    fire for a batch the account cap alone would have stopped.
  if (!(await ctx.judgeAvailable())) {
    withhold(ctx.report, 'judge_unhealthy');
    const outcome = await applyJudgeSplit(ctx.sql, batch);
    if (outcome === 'downgraded') ctx.report.downgraded += 1;
    else if (outcome === 'held') ctx.report.heldForJudge += 1;
    return 'next';
  }

  await releaseBatchRows(ctx, batch);
  return 'next';
}

/**
 * Release the rendered rows of ONE batch, inside the caps. Split from
 * `runBatchArm` so the arm reads as its gate ladder (capacity → auto
 * re-check → Judge split → rows) and each piece stays under the cognitive
 * threshold.
 */
async function releaseBatchRows(
  ctx: ReleaseArmContext,
  batch: ReleaseCandidateBatch,
): Promise<void> {
  const candidates = await selectRenderedOutreach(ctx.sql, batch, ctx.scanLimit);
  for (const outreachId of candidates) {
    if (ctx.capacityExhausted()) return;

    const rowOutcome = await releaseOutreachRow(ctx.sql, batch, outreachId);
    if (rowOutcome === 'withheld_auto_conditions') {
      // Rev 2.1 (decision 6): an auto condition failed INSIDE the row's
      // release transaction, after `runBatchArm`'s arm-level check passed.
      // The condition is ACCOUNT-level, so every sibling row of this batch
      // would withhold identically — count the batch once and stop its loop;
      // the next tick's arm-level check performs the durable downgrade.
      withhold(ctx.report, 'auto_conditions');
      return;
    }
    if (rowOutcome !== 'released') continue;

    // All three, on EVERY release. See the module header.
    ctx.report.released += 1;
    ctx.counters.budget -= 1;
    ctx.counters.platform -= 1;
    ctx.counters.account -= 1;
  }
}

/**
 * The account arm — the two per-account gate reads, then every batch.
 *
 * THIS PHASE HAS TWO ISOLATION UNITS, and each one is the unit its work actually
 * belongs to. The ACCOUNT is the outer one, and it covers exactly the two gate
 * reads below: the cap read and the subscription read are per-account questions,
 * so a throw from either costs that account its tick and no one else's. The
 * BATCH is the inner one: `applyJudgeSplit`, `selectRenderedOutreach` and
 * `releaseOutreachRow` are per-batch and per-row, so one poisoned batch must cost
 * that batch and leave its SIBLINGS releasable. Without the inner unit a single
 * failing batch discarded the account's whole remaining tick — deterministically,
 * every tick, until those batches crossed the 72h send window, which is issue
 * #915's wedge narrowed rather than closed.
 *
 * Both units are `isolateItem` rather than a bare `try`. An earlier revision used
 * bare `try`s because "the bodies' `continue` and `break` target these loops and
 * may not cross a function boundary" — true of that shape, and no longer true of
 * this one: the batch arm RETURNS its control signal, so the boundary costs
 * nothing and the two arms stop being nested five deep.
 */
async function runAccountArm(
  ctx: ReleaseArmContext,
  accountId: string,
  batches: readonly ReleaseCandidateBatch[],
): Promise<void> {
  // 4. The account cap, BEFORE the subscription (B6's closing paragraph). The
  //    order matters and is silent when wrong: both gates refuse, only the
  //    reported reason lies, and the operator chases the wrong dial.
  const cap = resolveAccountDailySendCap({
    dailySendCap: await readAccountDailySendCap(ctx.sql, accountId),
  });
  ctx.counters.account = cap - (await countAccountDispatchAttemptsToday(ctx.sql, accountId));
  if (ctx.counters.account <= 0) {
    withhold(ctx.report, 'account_cap');
    return;
  }

  // 5. Entitlement, never a raw equality against 'active' (invariant #11). A
  //    lapsed subscription is RECOVERABLE inside the send window: the rows stay
  //    `rendered`, so paying resumes the drip with no intervention.
  const status = await readAccountSubscriptionStatus(ctx.sql, accountId);
  if (!subscriptionGrantsFullAccess(status)) {
    withhold(ctx.report, 'subscription');
    return;
  }

  for (const batch of batches) {
    // The batch id is what an operator needs to find the poisoned unit, and the
    // account-level isolation below cannot name it. A throw yields `undefined`,
    // which is not `'stop'`, so a poisoned batch costs itself and no sibling.
    const outcome = await isolateItem(
      'release',
      { account_id: accountId, batch_id: batch.id },
      ctx.isolated,
      () => runBatchArm(ctx, batch),
    );
    if (outcome === 'stop') break;
  }
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
  const platformRemaining = platformCap - (await countPlatformDispatchAttemptsToday(sql));
  if (platformRemaining <= 0) {
    report.releasePhaseStoppedBy = 'platform_ceiling';
    return;
  }

  if (bounds.perTickBudget <= 0) {
    withhold(report, 'per_tick_budget');
    return;
  }

  const counters: ReleaseCounters = {
    budget: bounds.perTickBudget,
    platform: platformRemaining,
    // No account is in scope yet. `runAccountArm` re-seeds this from that
    // account's own cap read before anything reads it.
    account: Number.POSITIVE_INFINITY,
  };

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
  /**
   * `capacityStop` applied: count the withhold, and decide how far to stop.
   *
   * `account_cap` deliberately does NOT set `stopPhase` — the cap is
   * per-account, so a SIBLING account may still release this tick. The other two
   * are tick-wide. That asymmetry is why the three counters cannot collapse into
   * one, and why this returns a boolean the caller acts on rather than breaking
   * anything itself: its callers end different loops.
   */
  const applyStop = (stop: ReleaseWithheldReason | null): boolean => {
    if (stop === null) return false;
    withhold(report, stop);
    if (stop === 'per_tick_budget') logBudgetExhausted();
    if (stop !== 'account_cap') stopPhase = true;
    return true;
  };
  /** The account-loop gate: TICK-WIDE counters only. `counters.account` still
   *  holds the PREVIOUS account's remainder here, and reading it would refuse
   *  the next account on a cap that is not its own. */
  const tickCapacityExhausted = (): boolean =>
    applyStop(capacityStop(counters.budget, counters.platform, Number.POSITIVE_INFINITY));
  /** The in-account gate: all three counters. */
  const capacityExhausted = (): boolean =>
    applyStop(capacityStop(counters.budget, counters.platform, counters.account));

  const ctx: ReleaseArmContext = {
    sql,
    scanLimit: bounds.scanLimit,
    report,
    counters,
    isolated,
    judgeAvailable,
    capacityExhausted,
  };

  for (const [accountId, accountBatches] of byAccount) {
    if (stopPhase) break;
    if (tickCapacityExhausted()) break;

    await isolateItem(
      'release',
      { account_id: accountId },
      isolated,
      () => runAccountArm(ctx, accountId, accountBatches),
    );
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
      SELECT b.id, b.account_id, b.business_id, b.approval_method, b.approved_at,
             b.sending_started_at,
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
           c.approval_method, c.sending_started_at, c.approval_window_open
      FROM withheld w
      LEFT JOIN candidates c ON TRUE
     ORDER BY c.approved_at ASC
  `;

  // The `LEFT JOIN` guarantees at least one row; a row with a NULL `id` is the
  // aggregate alone, not a batch. The four columns the guard below tests are
  // the ones that identify that row: the three ids, and `approval_window_open`,
  // which this statement computes.
  //
  // `sending_started_at` is DELIBERATELY NOT in that guard, and this note says
  // so because the previous version of it claimed the opposite. The column is
  // nullable by design — 091 declares a bare `TIMESTAMPTZ` — and is NULL for
  // every batch that has not begun dripping, which is every first-release
  // candidate. Tightening the guard to match the old claim would drop exactly
  // the batches this phase exists to release, and the phase would then report
  // `released: 0` with `releasePhaseStoppedBy: null` — an idle-looking tick,
  // which is the failure mode the `account_cap` counter was fixed to remove.
  const batches: ReleaseCandidateBatch[] = [];
  for (const row of rows) {
    if (row.id === null || row.account_id === null || row.business_id === null) continue;
    if (row.approval_window_open === null) continue;
    batches.push({
      id: row.id,
      account_id: row.account_id,
      business_id: row.business_id,
      approval_method: row.approval_method,
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
): Promise<DowngradeSplitOutcome> {
  const { outcome } = await applyDowngradeSplit(sql, batch, JUDGE_UNAVAILABLE_REASON);
  return outcome;
}

/**
 * The downgrade split's shared body (#631 decision 7), extracted VERBATIM from
 * the Judge arm above so the Auto-approval lane's re-check could not grow a second
 * implementation of the held/skipped arms or the alerting shape: same HOLD
 * condition (mid-drip, or the approval window shut — a downgrade's whole
 * promise is "the batch reappears as approvable", and both make it false),
 * same one-transaction downgrade, same Sentry-then-log pattern with the
 * reason in the spine detail, the Sentry tag and the log line.
 *
 * `confirmReason` is the auto arm's rev-2.1 serialization hook (R1 finding 3):
 * it runs INSIDE the downgrade transaction, after the batch row lock and
 * before the CAS — see `downgradeApproval`. The Judge arm passes none: Judge
 * availability is a per-tick fact the transaction cannot re-derive.
 *
 * Generic over the reason so the auto arm gets back the narrow
 * {@link AutoDowngradeReason} its per-reason report counter needs.
 */
async function applyDowngradeSplit<R extends DowngradeReason>(
  sql: Sql,
  batch: ReleaseCandidateBatch,
  reason: R,
  confirmReason?: (tx: TransactionSql) => Promise<R | null>,
): Promise<{ outcome: DowngradeSplitOutcome; reason: R }> {
  if (batch.sending_started_at !== null || !batch.approval_window_open) {
    return { outcome: 'held', reason };
  }

  const result = await sql.begin(async (tx) =>
    downgradeApproval(tx, batch, reason, confirmReason),
  );
  if (result === undefined) return { outcome: 'skipped', reason };

  // Best-effort, AFTER the durable write and in its own catch: an alerting
  // failure must never flip a completed downgrade into a failed tick. The
  // title splits by LANE (Sentry groups by text; a Governor trip must not
  // file into the Judge-outage issue), the exact reason rides the tag.
  const message =
    result.reason === JUDGE_UNAVAILABLE_REASON
      ? DOWNGRADE_ALERT_MESSAGE
      : AUTO_DOWNGRADE_ALERT_MESSAGE;
  try {
    Sentry.captureMessage(message, {
      level: 'warning',
      tags: { subsystem: 'solicitation-release', reason: result.reason },
      extra: {
        batch_id: batch.id,
        account_id: batch.account_id,
        business_id: batch.business_id,
        send_parent_run_id: result.sendParentRunId,
      },
    });
  } catch {
    // Same shape as `emitConsentEvent` and `llmCircuitBreaker.emitTransition`:
    // the log line below is the fallback sink for Sentry itself being
    // unreachable, so it lives OUTSIDE this guard.
  }
  logger.warn(message, {
    batch_id: batch.id,
    account_id: batch.account_id,
    business_id: batch.business_id,
    reason: result.reason,
  });
  return { outcome: 'downgraded', reason: result.reason };
}

/**
 * The Auto-approval lane's downgrade (#631 decision 6), reached only after the
 * arm-level quick read found a failing condition. The TOCTOU between that
 * unlocked read and the downgrade CAS is closed HERE: `confirmReason`
 * re-reads the SAME four conditions inside the downgrade transaction, under
 * the batch row lock `downgradeApproval` has just taken and the account-wide
 * autonomy lock (batch-then-account, the documented order) — the same
 * serialization settings and Governor writers take. Conditions healthy again
 * ⇒ `null` ⇒ the split reports `skipped` and writes nothing; still failing ⇒
 * the CONFIRMED reason (which may differ from the arm-level one — the row
 * under lock is the truth) is what the spine step, tag and report carry.
 */
async function applyAutoDowngrade(
  sql: Sql,
  batch: ReleaseCandidateBatch,
  armReason: AutoDowngradeReason,
): Promise<{ outcome: DowngradeSplitOutcome; reason: AutoDowngradeReason }> {
  return applyDowngradeSplit(sql, batch, armReason, async (tx) => {
    await lockAutonomyAccount(tx, batch.account_id);
    return findAutoDowngradeReason(tx, batch.account_id);
  });
}

/**
 * The downgrade, in its own transaction: lock the batch row, confirm the
 * reason (the auto arm's in-tx hook — see below), CAS the four approval
 * columns to NULL together, then record the spine step with the reason that
 * actually held under the lock.
 *
 * Returns the Send batch parent's run id (`null` when the batch never minted
 * one) plus the confirmed reason on a downgrade, or `undefined` when the CAS
 * matched nothing — or when `confirmReason` found the conditions healthy
 * again, which is the Auto-approval lane's raced-back-to-healthy skip (#631 decision
 * 6). `confirmReason` runs AFTER the batch row lock and BEFORE the CAS, so
 * the auto arm can take the account lock inside it (batch-then-account, the
 * documented order) and re-read under full serialization.
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
async function downgradeApproval<R extends DowngradeReason>(
  tx: TransactionSql,
  batch: ReleaseCandidateBatch,
  reason: R,
  confirmReason?: (tx: TransactionSql) => Promise<R | null>,
): Promise<{ sendParentRunId: string | null; reason: R } | undefined> {
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

  let confirmedReason: R = reason;
  if (confirmReason !== undefined) {
    const confirmed = await confirmReason(tx);
    if (confirmed === null) return undefined;
    confirmedReason = confirmed;
  }

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
  // CAS's own `built_at` arm above is what makes true. The reason is the one
  // confirmed under the lock, never a hard-coded constant (R1 finding 5).
  if (locked.send_parent_run_id !== null) {
    await recordStep(tx, {
      runId: locked.send_parent_run_id,
      stepKey: 'approval_downgraded',
      detail: { reason: confirmedReason },
    });
  }
  return { sendParentRunId: locked.send_parent_run_id, reason: confirmedReason };
}

/** What `releaseOutreachRow` did with one row. `skipped` is any lost race —
 *  the batch lock re-read refused, or another writer moved the row first.
 *  `withheld_auto_conditions` is the rev-2.1 guard (#631 decision 6): an
 *  `auto_policy` batch's conditions failed under the release transaction's
 *  own locks, so the row stays `rendered` and nothing is written. */
type ReleaseRowOutcome = 'released' | 'skipped' | 'withheld_auto_conditions';

/**
 * Release ONE Outreach row: the batch lock, the `rendered` → `queued` CAS, the
 * `sending_started_at` stamp and the `job_outbox` row, in ONE transaction
 * (invariant #2). Returns what happened to the row.
 *
 * THE LOCKED RE-READ IS LOAD-BEARING (round-1 finding 8). P4 selects candidates
 * before the tick takes any lock, so a candidate that then waits on the batch
 * lock — behind the `send_window_elapsed` sweep, or behind a long release — can
 * become halted, closed or overdue in the meantime. Re-asserting all four arms
 * under the lock is what stops a release after the terminal deadline; the
 * window arm is spelled in SQL so the DATABASE clock decides it.
 *
 * FOR AN `auto_policy` BATCH ONLY, the same transaction re-reads the four auto
 * conditions before the CAS (#631 rev 2.1, decision 6): batch lock first (the
 * statement above), then `lockAutonomyAccount` — the documented
 * batch-then-account order — then the conditions, so a settings opt-out, a
 * tier lapse or a Governor suspension committed after the arm-level check can
 * never race a row out the door. A failure withholds the row and writes
 * NOTHING; the durable downgrade belongs to the next tick's arm-level check.
 * Owner-lane batches skip the guard entirely. Affordable by construction:
 * RELEASE_PER_TICK_BUDGET = 2 per 60s tick (ADR 0022), so at most two extra
 * condition reads per minute.
 *
 * A `skipped` from the CAS means another writer moved the row first — skip it
 * and enqueue nothing.
 */
async function releaseOutreachRow(
  sql: Sql,
  batch: ReleaseCandidateBatch,
  outreachId: string,
): Promise<ReleaseRowOutcome> {
  return sql.begin(async (tx): Promise<ReleaseRowOutcome> => {
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
    if (locked === undefined) return 'skipped';

    if (batch.approval_method === APPROVAL_METHOD.AUTO_POLICY) {
      await lockAutonomyAccount(tx, batch.account_id);
      if ((await findAutoDowngradeReason(tx, batch.account_id)) !== null) {
        return 'withheld_auto_conditions';
      }
    }

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
    if (moved === undefined) return 'skipped';

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
    return 'released';
  });
}
