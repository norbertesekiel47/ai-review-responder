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
//                                 batch the tick saw. One implementation, two
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
import { recordStep } from '@/lib/agents/run-spine';
import { getWorkerConfig } from '@/lib/config/worker';
import { judgeEnabled } from '@/lib/responses/judge-flags';
import { isJudgeHealthy } from '@/lib/responses/judge-health';
import { enqueueSolicitationSend } from '@/lib/shared/job-outbox-helpers';
import { createWorkerLogger } from '@/lib/shared/logger';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';
import { latchSystemHalt } from './approval';
import { solicitationSendEnabled } from './flags';
import { BATCH_SEND_WINDOW_HOURS } from './outreach';
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

// ── phases 1, 3 and 5: stubs, in order ──────────────────────────────────────
//
// Each returns 0 and writes nothing, so the tick is a no-op for its phase while
// the ORDER above is already fixed. A later task replaces the body only.

/** Task 6 (#900): the `unknown` sweep (D12d) — predicate P1, both belts. */
async function sweepUnknownOutreach(_sql: Sql, _scanLimit: number): Promise<number> {
  return 0;
}

/** Task 5 (#900): the `batch_expired` sweep (B7) — predicate P3 + `latchSystemHalt`. */
async function sweepBatchExpired(_sql: Sql, _scanLimit: number): Promise<number> {
  return 0;
}

/** Task 7 (#900): the backstop join (D11) — `closeBatchIfSettled`, no second implementation. */
async function runBackstopJoin(_sql: Sql, _scanLimit: number): Promise<number> {
  return 0;
}

// ── phase 2: the `send_window_elapsed` sweep ────────────────────────────────

/** P2's projection: the tenant triple and nothing else. Everything a **Halt
 *  latch** needs beyond it — the **Batch state** it stamps as `state_at_halt`,
 *  the **Send batch parent** it appends `batch_halted` to — the latch derives
 *  itself from the row it locks, so a second projection here would be a second
 *  reader of facts that must be read once, under that lock. */
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
