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
// Caps are enforced HERE ONLY (amendment B3) — a single loop on the
// single-replica worker, serialized by construction, which is what replaces
// atomic-reservation machinery. If this loop is ever parallelized, that
// resolution must be revisited (P2 entry in
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
import { createWorkerLogger } from '@/lib/shared/logger';
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
  };

  // The scaffold is the phase order. Later tasks FILL these slots; none of them
  // reorders the list, because the order is the contract above.
  report.unknownTerminalized = await sweepUnknownOutreach(sql, scanLimit);
  report.sendWindowElapsed = await sweepSendWindowElapsed(sql, scanLimit);
  report.batchExpired = await sweepBatchExpired(sql, scanLimit);
  await runReleasePhase(sql, { perTickBudget, scanLimit }, report);
  report.backstopClosed = await runBackstopJoin(sql, scanLimit);

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
async function runBackstopJoin(sql: Sql, scanLimit: number): Promise<number> {
  const batches = await selectOpenSendBatches(sql, scanLimit);

  let closed = 0;
  for (const batch of batches) {
    const result = await sql.begin(async (tx) =>
      closeBatchIfSettled(tx, {
        batchId: batch.id,
        accountId: batch.account_id,
        businessId: batch.business_id,
      }),
    );
    if (result.status === 'closed') closed += 1;
  }
  return closed;
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
async function sweepUnknownOutreach(sql: Sql, scanLimit: number): Promise<number> {
  const rows = await selectWedgedSendingOutreach(sql, scanLimit);

  let terminalized = 0;
  for (const row of rows) {
    const moved = await sql.begin(async (tx) => terminalizeWedgedOutreach(tx, row));
    if (!moved) continue;
    terminalized += 1;
    alertUnknownTerminalization(row);
  }
  return terminalized;
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
 * `null` is a legitimate answer, deliberately NOT an assertion. A `sending` row
 * normally does have a running child (#899's tx1 mints it before the CAS), but
 * this is the one loop on the platform whose whole purpose is to unwedge
 * locations that nothing else can unwedge — a throw here would abort the tick
 * before phases 2 and 3 ever ran, letting one anomalous row hold every other
 * account's wedged batch shut. The Outreach terminalization is the act that
 * matters; the child transition is the spine's half of it.
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
async function sweepSendWindowElapsed(sql: Sql, scanLimit: number): Promise<number> {
  const batches = await selectSendWindowElapsedBatches(sql, scanLimit);

  let latched = 0;
  for (const batch of batches) {
    const result = await sql.begin(async (tx) =>
      latchSystemHalt(tx, {
        batchId: batch.id,
        accountId: batch.account_id,
        businessId: batch.business_id,
        reason: 'send_window_elapsed',
      }),
    );
    if (result.status === 'latched') latched += 1;
  }
  return latched;
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
async function sweepBatchExpired(sql: Sql, scanLimit: number): Promise<number> {
  const batches = await selectExpiredBatches(sql, scanLimit);

  let latched = 0;
  for (const batch of batches) {
    const result = await sql.begin(async (tx) =>
      latchSystemHalt(tx, {
        batchId: batch.id,
        accountId: batch.account_id,
        businessId: batch.business_id,
        reason: 'batch_expired',
      }),
    );
    if (result.status === 'latched') latched += 1;
  }
  return latched;
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

/** P4's projection. `sending_started_at` is here because the Judge split reads
 *  it to choose downgrade vs hold, and a HOLD must take no lock at all. */
interface ReleaseCandidateBatch {
  id: string;
  account_id: string;
  business_id: string;
  sending_started_at: Date | null;
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

/** What the Judge split did to one batch. `skipped` is the concurrent-halt arm:
 *  the CAS matched nothing, so nothing was downgraded and nothing was held. */
type JudgeSplitOutcome = 'downgraded' | 'held' | 'skipped';

function withhold(report: ReleaseCycleReport, reason: ReleaseWithheldReason): void {
  report.withheldByReason[reason] = (report.withheldByReason[reason] ?? 0) + 1;
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

  const batches = await selectReleaseCandidates(sql, bounds.scanLimit);
  const byAccount = groupByAccount(batches);

  let stopPhase = false;
  let budgetWarned = false;
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
    }
  }
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
 */
async function selectReleaseCandidates(
  sql: Sql,
  scanLimit: number,
): Promise<ReleaseCandidateBatch[]> {
  return sql<ReleaseCandidateBatch[]>`
    SELECT b.id, b.account_id, b.business_id, b.sending_started_at
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
     ORDER BY b.approved_at ASC
     LIMIT ${scanLimit}
  `;
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
 * `sending_started_at IS NULL` — the drip has not begun, so the batch can still
 * go back to the owner: downgrade. `IS NOT NULL` — mid-drip, so it can only
 * HOLD, with **no writes at all**, and 091's `solicitation_batches_send_ordering`
 * CHECK makes a mid-drip downgrade impossible at the database anyway. Releases
 * resume on recovery, or the 72h window expires and the batch terminalizes
 * cancelled.
 */
async function applyJudgeSplit(
  sql: Sql,
  batch: ReleaseCandidateBatch,
): Promise<JudgeSplitOutcome> {
  if (batch.sending_started_at !== null) return 'held';

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
    RETURNING id
  `;
  if (downgraded === undefined) return undefined;

  // The DURABLE record; the Sentry warning is ephemeral. No owner notification
  // (locked decision 4) — the batch simply reappears as approvable.
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
