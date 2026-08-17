/**
 * The two owner verbs of send-mode's approval lane (#629; executor design
 * 2026-07-28 D9/D10/D22/D23).
 *
 * What lives here and nothing else: `approveBatch` and `haltBatch`. Both are
 * transactional writers with an actor; both return a discriminated result so
 * their routes stay thin (invariant #12) and neither throws for an outcome the
 * owner can cause.
 *
 * Deliberately NOT in outreach.ts: that module's interface is the machine
 * lifecycle (render persistence, the join, the derived state) and has no actor
 * in any signature. These two do, and they are the only writers a human
 * triggers.
 *
 * LOCK ORDER (amendment B11, and the reason both verbs share one shape):
 * advisory batch lock -> `solicitation_batches` row -> `agent_runs`. Every
 * run-spine call (recordStep, closeBatchIfSettled) therefore happens LAST.
 * Taking the run lock first is an ABBA deadlock against the offboarding purge.
 *
 * Where this file DIFFERS from outreach.ts, whose lock analysis it otherwise
 * mirrors: nothing here locks an `agent_runs` row before calling the spine, so
 * `recordStep`'s own `SELECT … FOR UPDATE` on the send parent is this
 * transaction's FIRST lock on that row (the step INSERT's implicit FK
 * `FOR KEY SHARE` then lands on a row `recordStep` just took, not on one this
 * file was already holding). The batch -> run order above is unaffected — the
 * spine call still happens after both batch locks — but do not restate
 * outreach.ts's "the transaction already holds it" premise here: it is false in
 * this file, and a lock analysis resting on an untrue statement is worthless.
 *
 * Domain module: the caller supplies `sql` (invariant #15) and both tenant ids
 * (invariant #8) — a batch id is a bare UUID carrying no tenant proof.
 */

import type { Sql, TransactionSql } from 'postgres';
import { recordStep } from '@/lib/agents/run-spine';
import { acquireSolicitationBatchLock } from './batch-builder';
import {
  closeBatchIfSettled,
  deriveBatchState,
  type BatchLifecycleRow,
  type BatchState,
  type CloseBatchIfSettledResult,
} from './outreach';

/** The owner veto window (D9): an undo, not a review window — the owner has
 *  already read every rendered message. The auto lane's 60-minute window is
 *  anchored differently and belongs to #631. */
const VETO_WINDOW_MINUTES_OWNER = 15;

/** The two Halt-latch reasons an OWNER can cause. `admin_halt`,
 *  `send_window_elapsed` and `batch_expired` are the same latch with other
 *  writers (#630 and the admin surface); this module cannot spell them. */
export type OwnerHaltReason = 'owner_veto' | 'owner_halt';

/**
 * A veto is "halt at zero sends" (D10) — the same write, a different reason.
 * The reason is derived from the Batch state server-side and NEVER read from
 * the request: a client that could name its own reason could file a mid-drip
 * halt as a veto and make the audit trail lie about whether email had left.
 */
export function ownerHaltReason(state: BatchState): OwnerHaltReason {
  return state === 'sending' ? 'owner_halt' : 'owner_veto';
}

interface BatchActionRow extends BatchLifecycleRow {
  send_parent_run_id: string | null;
}

/**
 * The batch id in the ONE form Postgres renders a uuid in — lower case.
 *
 * `agent_runs.subject_id` is TEXT (migration 071), so every compare against it
 * is case-SENSITIVE, while every `::uuid` cast normalises. `isValidUuid` — the
 * validator the routes use — accepts upper case, so a mixed-case request id
 * matched the batch row (`b.id = $1::uuid`) and MISSED that batch's send
 * parent: `approveBatch` threw a 500 and `haltBatch` silently dropped its
 * `batch_halted` step. Canonicalise ONCE at the entry point and use the result
 * for every id below — including the `closeBatchIfSettled` argument, whose own
 * parent lookup is the same text compare on the same column.
 *
 * Cheaper and narrower than a SQL-side `$1::uuid::text`, which would fix only
 * the statement it is spelled on and leave the next text compare to rediscover
 * this. A malformed id still fails at the first `::uuid` cast exactly as before.
 */
function canonicalBatchId(batchId: string): string {
  return batchId.toLowerCase();
}

/**
 * The locked batch row plus its Send batch parent, in ONE statement under the
 * advisory lock. Returns null when the batch does not exist for this tenant —
 * the caller maps that onto the uniform 404, so a foreign batch id and an
 * unknown one are indistinguishable.
 *
 * `batchId` is already canonical (`canonicalBatchId`) so every downstream use,
 * including `closeBatchIfSettled`, observes the same defensive normalization.
 * This statement also correlates the TEXT parent subject to `b.id::text`, which
 * lets Postgres render the UUID canonically at the comparison boundary.
 */
async function lockBatchForAction(
  tx: TransactionSql,
  input: { batchId: string; accountId: string; businessId: string },
): Promise<BatchActionRow | null> {
  await acquireSolicitationBatchLock(tx, input.businessId);

  // Keep the parent lookup correlated to the locked batch row. The query-block
  // tenant-scope audit proves both tenant predicates inside this scalar
  // subquery independently, so the old scanner-only two-statement workaround
  // is no longer needed. `FOR UPDATE OF b` locks only the batch row; the parent
  // lookup is an ordinary read, and the first run-row lock remains recordStep's
  // later SELECT FOR UPDATE. The batch -> run lock order is therefore unchanged.
  const [batch] = await tx<BatchActionRow[]>`
    SELECT
      b.built_at,
      b.approved_at,
      b.veto_deadline_at,
      b.sending_started_at,
      b.send_closed_at,
      b.halted_at,
      (
        SELECT r.id
        FROM agent_runs r
        WHERE r.kind = 'solicitation_send_batch'
          AND r.subject_type = 'solicitation_batch'
          AND r.subject_id = b.id::text
          AND r.account_id = ${input.accountId}::uuid
          AND r.business_id = ${input.businessId}::uuid
        ORDER BY r.started_at DESC
        LIMIT 1
      ) AS send_parent_run_id
    FROM solicitation_batches b
    WHERE b.id = ${input.batchId}::uuid
      AND b.account_id = ${input.accountId}::uuid
      AND b.business_id = ${input.businessId}::uuid
    FOR UPDATE OF b
  `;
  return batch ?? null;
}

export interface ApproveBatchInput {
  batchId: string;
  accountId: string;
  businessId: string;
  /** The acting owner. Required: 091's approval-consistency CHECK demands a
   *  non-NULL approver whenever approval_method='owner'. */
  approvedByUserId: string;
  /** Outreach row ids the owner deselected. Every id must be a live `rendered`
   *  row of THIS batch or the whole approval is refused (fail-closed). */
  excludedOutreachIds: string[];
}

export type ApproveBatchResult =
  | {
      status: 'approved';
      approvedCount: number;
      excludedCount: number;
      vetoDeadlineAt: string;
      /** Present only when the approval settled the batch outright — the
       *  exclude-everything case. */
      close: CloseBatchIfSettledResult | null;
    }
  | { status: 'already_approved' }
  /** Generation has not finished: approving now would let a row render AFTER
   *  approval and become releasable unseen, breaking the byte-for-byte
   *  contract. */
  | { status: 'not_ready'; missingRenders: number }
  /**
   * The batch cannot be approved. `state` is the derived lifecycle state that
   * refused it; `reason` is present only for the ONE refusal that is structural
   * rather than lifecycle-driven — a `built` batch with no send work at all, so
   * nothing would ever send and nothing could ever close it. Both are the same
   * owner-visible outcome (one 409, one sentence), so they are one discriminant
   * with a cause, not two statuses the UI would copy identically.
   */
  | { status: 'not_approvable'; state: BatchState; reason?: 'no_send_parent' }
  | { status: 'unknown_exclusion' }
  | { status: 'not_found' };

export async function approveBatch(
  sql: Sql,
  input: ApproveBatchInput,
): Promise<ApproveBatchResult> {
  const batchId = canonicalBatchId(input.batchId);
  return sql.begin(async (tx): Promise<ApproveBatchResult> => {
    const batch = await lockBatchForAction(tx, {
      batchId,
      accountId: input.accountId,
      businessId: input.businessId,
    });
    if (batch === null) return { status: 'not_found' };

    // Read the state ONCE, under the lock, from the same row every write below
    // targets. `expired` lands here: past built_at + 7 days neither lane may
    // approve (D2).
    const state = deriveBatchState(batch, new Date());
    if (state !== 'built') {
      return batch.approved_at !== null
        ? { status: 'already_approved' }
        : { status: 'not_approvable', state };
    }

    // No send parent means no send work, and it is a REFUSAL, not a broken
    // invariant: `buildSolicitationBatch` skips the generation enqueue outright
    // when `sendCount === 0` (batch-builder, EXEC D21), so an all-withheld
    // batch is built with no parent, no send Ask and no Outreach row. Readiness
    // below cannot catch that — its anti-join counts `status = 'send'` asks and
    // passes VACUOUSLY over zero of them — so this gate has to be its own, and
    // it has to come first.
    //
    // Approving such a batch would be actively harmful, which is why this is a
    // refusal rather than a silent skip of the run step the way `haltBatch`
    // does: nothing would ever send, `closeBatchIfSettled` has no parent to
    // terminalize so the batch could never close, and the approval would hold
    // the location's ONE active-send slot (091's partial unique index
    // solicitation_batches_one_active_send_per_business, keyed on approved and
    // neither closed nor halted) against its next real batch until someone
    // halted it. The panel shows no approve control for an all-withheld batch,
    // so this answers a direct POST or a stale tab — never a 500.
    const sendParentRunId = batch.send_parent_run_id;
    if (sendParentRunId === null) {
      return { status: 'not_approvable', state, reason: 'no_send_parent' };
    }

    // Readiness: every send Ask must already have a non-cancelled Outreach row.
    // Asserted in SQL rather than trusted from the client, and inside the same
    // transaction as the approval, so a render committing between the check and
    // the CAS cannot slip through.
    //
    // "Non-cancelled", NOT "rendered", and the difference is the point: a
    // `withheld` row (lint_failed, moderation_high) is a FINISHED attempt with
    // nothing left to render, so it satisfies readiness and is simply not
    // approvable copy. Only a `cancelled` row — a superseded attempt — leaves a
    // hole its replacement must fill. Requiring `rendered` here would wedge
    // every batch that had one lint failure.
    // Keep this as the natural anti-existence predicate: each send Ask is a
    // readiness gap only when no non-cancelled Outreach attempt exists. The
    // query-block tenant-scope audit proves the nested Outreach occurrence on
    // both tenant keys, so no scanner-shaped LEFT JOIN is necessary.
    const [gap] = await tx<{ missing: number }[]>`
      SELECT COUNT(*)::int AS missing
      FROM solicitation_asks a
      WHERE a.batch_id = ${batchId}::uuid
        AND a.account_id = ${input.accountId}::uuid
        AND a.business_id = ${input.businessId}::uuid
        AND a.status = 'send'
        AND NOT EXISTS (
          SELECT 1
          FROM solicitation_outreach o
          WHERE o.ask_id = a.id
            AND o.batch_id = a.batch_id
            AND o.account_id = ${input.accountId}::uuid
            AND o.business_id = ${input.businessId}::uuid
            AND o.delivery_status <> 'cancelled'
        )
    `;
    const missingRenders = gap?.missing ?? 0;
    if (missingRenders > 0) return { status: 'not_ready', missingRenders };

    // Exclusions are VALIDATED BEFORE THEY ARE WRITTEN, and the ordering is
    // load-bearing: postgres.js COMMITS when the `sql.begin` callback resolves,
    // so an early `return` after a partial UPDATE would commit that partial
    // cancellation while telling the caller the approval was refused. Validate
    // first, mutate second — a refusal then leaves the batch untouched because
    // nothing was written yet.
    let excludedCount = 0;
    if (input.excludedOutreachIds.length > 0) {
      const [live] = await tx<{ matched: number }[]>`
        SELECT COUNT(*)::int AS matched
        FROM solicitation_outreach
        WHERE id = ANY(${input.excludedOutreachIds}::uuid[])
          AND batch_id = ${batchId}::uuid
          AND account_id = ${input.accountId}::uuid
          AND business_id = ${input.businessId}::uuid
          AND delivery_status = 'rendered'
      `;
      // Distinct ids, because ANY() de-duplicates and a repeated id would
      // otherwise read as a missing one.
      const distinctIds = new Set(input.excludedOutreachIds).size;
      if ((live?.matched ?? 0) !== distinctIds) return { status: 'unknown_exclusion' };

      const excluded = await tx<{ id: string }[]>`
        UPDATE solicitation_outreach
        SET delivery_status = 'cancelled',
            disposition_reason = 'owner_excluded',
            updated_at = NOW()
        WHERE id = ANY(${input.excludedOutreachIds}::uuid[])
          AND batch_id = ${batchId}::uuid
          AND account_id = ${input.accountId}::uuid
          AND business_id = ${input.businessId}::uuid
          AND delivery_status = 'rendered'
        RETURNING id
      `;
      excludedCount = excluded.count;
    }

    // The CAS. `approved_at IS NULL` makes a double-submit a no-op rather than
    // a second approval with a fresh veto deadline (D23).
    const [approved] = await tx<{ veto_deadline_at: string }[]>`
      UPDATE solicitation_batches
      SET approved_at = NOW(),
          approval_method = 'owner',
          approved_by_user_id = ${input.approvedByUserId}::uuid,
          veto_deadline_at = NOW() + make_interval(mins => ${VETO_WINDOW_MINUTES_OWNER})
      WHERE id = ${batchId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND business_id = ${input.businessId}::uuid
        AND approved_at IS NULL
      RETURNING veto_deadline_at::text AS veto_deadline_at
    `;
    // Losing this CAS is IMPOSSIBLE, and the throw is how that claim stays
    // honest. `approved_at` was read NULL above under `FOR UPDATE` on this very
    // row, and that lock is held until commit, so no concurrent writer can have
    // stamped it in between. Returning `already_approved` here — the shape this
    // branch used to have — would be a silent partial write: the exclusion
    // UPDATE above has already run, and postgres.js COMMITS on a normal return,
    // so the owner's deselections would be cancelled for good while the response
    // said nothing had been approved. That contradicts this function's own
    // validate-first-mutate-second contract, so it fails loudly and rolls back.
    if (approved === undefined) {
      throw new Error(
        `approveBatch: batch ${batchId} lost the approval CAS while holding its row lock`,
      );
    }

    const [live] = await tx<{ approved: number }[]>`
      SELECT COUNT(*)::int AS approved
      FROM solicitation_outreach
      WHERE batch_id = ${batchId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND business_id = ${input.businessId}::uuid
        AND delivery_status = 'rendered'
    `;
    const approvedCount = live?.approved ?? 0;

    await recordStep(tx, {
      runId: sendParentRunId,
      stepKey: 'batch_approved',
      detail: {
        approval_method: 'owner',
        approved_by_user_id: input.approvedByUserId,
        approved_count: approvedCount,
        excluded_count: excludedCount,
        veto_window_minutes: VETO_WINDOW_MINUTES_OWNER,
      },
    });

    // Exclude-everything settles the batch the instant it is approved. Calling
    // the join here — in the SAME transaction, like every other terminal
    // writer (D11) — is what keeps parent terminalization to one owner. It
    // no-ops (`not_settled`) whenever anything is still live.
    const close = await closeBatchIfSettled(tx, {
      batchId,
      accountId: input.accountId,
      businessId: input.businessId,
    });

    return {
      status: 'approved',
      approvedCount,
      excludedCount,
      vetoDeadlineAt: approved.veto_deadline_at,
      close: close.status === 'not_settled' ? null : close,
    };
  });
}

export interface HaltBatchInput {
  batchId: string;
  accountId: string;
  businessId: string;
  haltedByUserId: string;
}

export type HaltBatchResult =
  | {
      status: 'halted';
      reason: OwnerHaltReason;
      cancelledCount: number;
      close: CloseBatchIfSettledResult;
    }
  | { status: 'already_halted' }
  /** A closed batch is terminal — there is nothing left to stop. */
  | { status: 'not_haltable'; state: BatchState }
  | { status: 'not_found' };

/**
 * One monotone latch (D10). A veto inside the window and a mid-drip halt are
 * the same write; only the reason differs, and it is derived, never supplied.
 *
 * A batch that was never approved is haltable on purpose: that is the owner
 * discarding a built batch, and routing it through the latch means one code
 * path closes every batch that ends early.
 *
 * There is no resume, and it is structural: `halted_at` is monotone, the
 * releaser predicate (#630) requires `halted_at IS NULL`, and the rows this
 * cancels are terminal.
 */
export async function haltBatch(
  sql: Sql,
  input: HaltBatchInput,
): Promise<HaltBatchResult> {
  const batchId = canonicalBatchId(input.batchId);
  return sql.begin(async (tx): Promise<HaltBatchResult> => {
    const batch = await lockBatchForAction(tx, {
      batchId,
      accountId: input.accountId,
      businessId: input.businessId,
    });
    if (batch === null) return { status: 'not_found' };

    const state = deriveBatchState(batch, new Date());
    if (state === 'halted') return { status: 'already_halted' };
    if (state === 'closed') return { status: 'not_haltable', state };

    const reason = ownerHaltReason(state);

    // CAS on NULL keeps the latch monotone: a second halt returns above, and a
    // concurrent one writes nothing here.
    const [latched] = await tx<{ id: string }[]>`
      UPDATE solicitation_batches
      SET halted_at = NOW(),
          halt_reason = ${reason},
          halted_by = ${input.haltedByUserId}::uuid
      WHERE id = ${batchId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND business_id = ${input.businessId}::uuid
        AND halted_at IS NULL
      RETURNING id
    `;
    if (latched === undefined) return { status: 'already_halted' };

    // 'sending' is excluded on purpose: that row is past the point of no
    // return and resolves itself. Halt means "no further sends", not "undo".
    const cancelled = await tx<{ id: string }[]>`
      UPDATE solicitation_outreach
      SET delivery_status = 'cancelled',
          disposition_reason = ${reason},
          updated_at = NOW()
      WHERE batch_id = ${batchId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND business_id = ${input.businessId}::uuid
        AND delivery_status IN ('rendered', 'queued')
      RETURNING id
    `;

    // The parent may legitimately be absent — an owner can discard a built
    // batch whose generation never minted one. Skip the step, still join.
    if (batch.send_parent_run_id !== null) {
      await recordStep(tx, {
        runId: batch.send_parent_run_id,
        stepKey: 'batch_halted',
        detail: {
          halt_reason: reason,
          halted_by: input.haltedByUserId,
          cancelled_count: cancelled.count,
          state_at_halt: state,
        },
      });
    }

    const close = await closeBatchIfSettled(tx, {
      batchId,
      accountId: input.accountId,
      businessId: input.businessId,
    });

    return { status: 'halted', reason, cancelledCount: cancelled.count, close };
  });
}
