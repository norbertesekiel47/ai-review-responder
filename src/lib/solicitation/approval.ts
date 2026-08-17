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
export const VETO_WINDOW_MINUTES_OWNER = 15;

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
    const [gap] = await tx<{ missing: number }[]>`
      SELECT COUNT(*)::int AS missing
      FROM solicitation_asks a
      WHERE a.batch_id = ${input.batchId}::uuid
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
