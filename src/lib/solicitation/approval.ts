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
 * The locked batch row plus its Send batch parent, in ONE statement under the
 * advisory lock. Returns null when the batch does not exist for this tenant —
 * the caller maps that onto the uniform 404, so a foreign batch id and an
 * unknown one are indistinguishable.
 */
async function lockBatchForAction(
  tx: TransactionSql,
  input: { batchId: string; accountId: string; businessId: string },
): Promise<BatchActionRow | null> {
  await acquireSolicitationBatchLock(tx, input.businessId);

  // TWO statements, not one with a scalar subquery, and the split is not
  // stylistic: `ci:tenant-scope` reads predicates only at the top level of a
  // statement (`stripSelectSubqueries` blanks parenthesised SELECTs before
  // `splitTopLevelAnd` runs). Scope keys buried in a subquery are invisible to
  // it, so the audit cannot tell a correctly-scoped query from an unscoped one.
  // Hoisting the parent lookup to its own statement makes both tenant keys
  // top-level on BOTH tables — the same reason batch-view.ts repeats its keys
  // on the join rather than nesting them. Do not re-nest this.
  //
  // Lock order is unchanged and still batch -> run (amendment B11): the row
  // lock below is taken before the agent_runs read.
  const [batch] = await tx<BatchLifecycleRow[]>`
    SELECT
      b.built_at,
      b.approved_at,
      b.veto_deadline_at,
      b.sending_started_at,
      b.send_closed_at,
      b.halted_at
    FROM solicitation_batches b
    WHERE b.id = ${input.batchId}::uuid
      AND b.account_id = ${input.accountId}::uuid
      AND b.business_id = ${input.businessId}::uuid
    FOR UPDATE OF b
  `;
  if (batch === undefined) return null;

  // `subject_id` is TEXT and the batch row above already proved this id belongs
  // to this tenant, so matching the input directly is equivalent to the old
  // correlated `b.id::text`.
  const [parent] = await tx<{ id: string }[]>`
    SELECT r.id
    FROM agent_runs r
    WHERE r.kind = 'solicitation_send_batch'
      AND r.subject_type = 'solicitation_batch'
      AND r.subject_id = ${input.batchId}
      AND r.account_id = ${input.accountId}::uuid
      AND r.business_id = ${input.businessId}::uuid
    ORDER BY r.started_at DESC
    LIMIT 1
  `;

  return { ...batch, send_parent_run_id: parent?.id ?? null };
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
  | { status: 'not_approvable'; state: BatchState }
  | { status: 'unknown_exclusion' }
  | { status: 'not_found' };

export async function approveBatch(
  sql: Sql,
  input: ApproveBatchInput,
): Promise<ApproveBatchResult> {
  return sql.begin(async (tx): Promise<ApproveBatchResult> => {
    const batch = await lockBatchForAction(tx, input);
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
    // Spelled as an anti-join (LEFT JOIN + `o.id IS NULL`) rather than the more
    // obvious NOT EXISTS, for the tenant-scope reason documented on
    // `lockBatchForAction`: predicates inside a parenthesised subquery are
    // invisible to `ci:tenant-scope`, so the outreach scope keys have to sit in
    // the JOIN's ON clause to be seen. Semantically identical — every join
    // condition of the NOT EXISTS moved verbatim into ON, and `o.id IS NULL`
    // keeps exactly the asks that had no surviving attempt.
    const [gap] = await tx<{ missing: number }[]>`
      SELECT COUNT(DISTINCT a.id)::int AS missing
      FROM solicitation_asks a
      LEFT JOIN solicitation_outreach o
             ON o.ask_id = a.id
            AND o.batch_id = a.batch_id
            AND o.account_id = ${input.accountId}::uuid
            AND o.business_id = ${input.businessId}::uuid
            AND o.delivery_status <> 'cancelled'
      WHERE a.batch_id = ${input.batchId}::uuid
        AND a.account_id = ${input.accountId}::uuid
        AND a.business_id = ${input.businessId}::uuid
        AND a.status = 'send'
        AND o.id IS NULL
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
          AND batch_id = ${input.batchId}::uuid
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
          AND batch_id = ${input.batchId}::uuid
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
      WHERE id = ${input.batchId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND business_id = ${input.businessId}::uuid
        AND approved_at IS NULL
      RETURNING veto_deadline_at::text AS veto_deadline_at
    `;
    if (approved === undefined) return { status: 'already_approved' };

    const [live] = await tx<{ approved: number }[]>`
      SELECT COUNT(*)::int AS approved
      FROM solicitation_outreach
      WHERE batch_id = ${input.batchId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND business_id = ${input.businessId}::uuid
        AND delivery_status = 'rendered'
    `;
    const approvedCount = live?.approved ?? 0;

    // The parent must exist: readiness passed, so generation ran and minted
    // one. A missing parent here is a broken invariant, not a branch to
    // absorb — fail loudly rather than approving a batch nothing can close.
    if (batch.send_parent_run_id === null) {
      throw new Error(
        `approveBatch: batch ${input.batchId} passed readiness with no send parent run`,
      );
    }

    await recordStep(tx, {
      runId: batch.send_parent_run_id,
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
      batchId: input.batchId,
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
  return sql.begin(async (tx): Promise<HaltBatchResult> => {
    const batch = await lockBatchForAction(tx, input);
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
      WHERE id = ${input.batchId}::uuid
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
      WHERE batch_id = ${input.batchId}::uuid
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
      batchId: input.batchId,
      accountId: input.accountId,
      businessId: input.businessId,
    });

    return { status: 'halted', reason, cancelledCount: cancelled.count, close };
  });
}
