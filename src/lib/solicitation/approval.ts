/**
 * The human-triggered writers of send-mode's approval lane (#629 approve/halt,
 * executor design 2026-07-28 D9/D10/D22/D23; #860 ask regeneration; #865 the
 * admin arm of the Halt latch).
 *
 * What lives here and nothing else: `approveBatch`, `haltBatch`,
 * `adminHaltBatch` and `requestAskRegeneration`. All four are transactional
 * writers with an actor; all four return a discriminated result so their routes
 * stay thin (invariant #12) and none throws for an outcome its actor can cause.
 * A RepWorth operator is a human actor too, which is why the admin arm belongs
 * beside the owner ones rather than in a module of its own.
 *
 * The two halt verbs share ONE private latch, `latchHalt`, and its five steps
 * are ordered on purpose (see its own comment). Two hand-maintained copies of
 * that body is precisely how a batch acquires a second receipt, or a spine step
 * for a halt that never landed.
 *
 * `requestAskRegeneration` belongs here rather than beside `regenerateAsk` in
 * ask-generation.ts, and the reason is the gate rather than the verb: since
 * ADR 0020 a regenerate is legal in exactly one Batch state, `built`, so its
 * ENTIRE refusal vocabulary is approval-lane lifecycle. ask-generation.ts is
 * the machine side and carries no actor in any signature; this file is the
 * human side and carries one in every signature.
 *
 * Deliberately NOT in outreach.ts: that module's interface is the machine
 * lifecycle (render persistence, the join, the derived state) and has no actor
 * in any signature. These three do, and they are the only writers a human
 * triggers.
 *
 * LOCK ORDER (amendment B11, and the reason the two #629 verbs share one
 * shape): advisory batch lock -> `solicitation_batches` row -> `agent_runs`.
 * Every run-spine call (recordStep, closeBatchIfSettled) therefore happens
 * LAST. Taking the run lock first is an ABBA deadlock against the offboarding
 * purge. `requestAskRegeneration` prefixes ONE lock ahead of that chain — the
 * `job_outbox` row it enqueues — because the worker it enqueues for takes that
 * row first; its own docstring carries the whole argument.
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
import { writeAccountAuditLog } from '@/lib/audit/log';
import { enqueueGenerateSolicitationAsks } from '@/lib/shared/job-outbox-helpers';
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

/** The two Halt latch reasons an OWNER can cause, and the only two the owner
 *  arm may spell. `admin_halt` is the same latch written by `adminHaltBatch`
 *  below (#865) and lives in the PRIVATE `LatchHaltReason`, so this union stays
 *  two members; `send_window_elapsed` and `batch_expired` are the same latch
 *  with writers this module still does not have (#630). */
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
 * The locked batch row, its Send batch parent and its derived state, in ONE
 * statement under the advisory lock. This is the shared opening of all three
 * owner verbs, and it stops exactly where they diverge.
 *
 * Returns null when the batch does not exist for this tenant. Deliberately null
 * rather than a refusal value: every caller maps it onto the uniform 404 — so a
 * foreign batch id and an unknown one stay indistinguishable — but they do NOT
 * express it the same way. `approveBatch` and `haltBatch` return
 * `{ status: 'not_found' }`; `requestAskRegeneration` must THROW
 * `RegenRequestAbort`, because by the time it calls this it has already written
 * its `job_outbox` row and postgres.js COMMITS on a normal return. Folding the
 * three failures into one here would silently start the regeneration this
 * helper just refused.
 *
 * The state is derived HERE — once, under the lock, from the same row every
 * write downstream targets — so no caller can re-derive it from a second read.
 *
 * `batchId` is passed apart from the tenant keys because it must be the
 * canonical one (`canonicalBatchId`), never the caller's raw input: every
 * downstream use, including `closeBatchIfSettled`, then observes the same
 * defensive normalization. This statement also correlates the TEXT parent
 * subject to `b.id::text`, which lets Postgres render the UUID canonically at
 * the comparison boundary.
 */
async function lockBatchForAction(
  tx: TransactionSql,
  batchId: string,
  tenant: { accountId: string; businessId: string },
): Promise<{ batch: BatchActionRow; state: BatchState } | null> {
  await acquireSolicitationBatchLock(tx, tenant.businessId);

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
          AND r.account_id = ${tenant.accountId}::uuid
          AND r.business_id = ${tenant.businessId}::uuid
        ORDER BY r.started_at DESC
        LIMIT 1
      ) AS send_parent_run_id
    FROM solicitation_batches b
    WHERE b.id = ${batchId}::uuid
      AND b.account_id = ${tenant.accountId}::uuid
      AND b.business_id = ${tenant.businessId}::uuid
    FOR UPDATE OF b
  `;
  if (batch === undefined) return null;
  return { batch, state: deriveBatchState(batch, new Date()) };
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
    const locked = await lockBatchForAction(tx, batchId, input);
    if (locked === null) return { status: 'not_found' };
    const { batch, state } = locked;

    // The state was read ONCE, under the lock, from the same row every write
    // below targets. `expired` lands here: past built_at + 7 days neither lane
    // may approve (D2).
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

/** The writable Halt latch reasons. NOT exported: `OwnerHaltReason` stays the
 *  2-member public write union, and the admin arm's reason is a constant. */
type LatchHaltReason = OwnerHaltReason | 'admin_halt';

/** The admin arm's reason, fixed by the caller's identity (D1 / ticket
 *  constraint 2). No request field can name it, in either arm. */
const ADMIN_HALT_REASON: LatchHaltReason = 'admin_halt';

/** `<domain>_<verb-past>` (D6), explicitly admin-scoped so a future owner-arm
 *  audit row cannot collide with it. */
const ADMIN_HALT_EVENT_TYPE = 'solicitation_batch_admin_halted';

interface LatchHaltInput {
  /** ALREADY canonical — `canonicalBatchId` runs at the public entry point. */
  batchId: string;
  accountId: string;
  businessId: string;
  actorUserId: string;
  reason: LatchHaltReason;
  /** Read under the lock by the caller, off the same row every write targets. */
  state: BatchState;
  sendParentRunId: string | null;
  /** Non-null only for the admin arm (D7): the owner arm writes no audit row. */
  audit: { eventType: string; payload: Record<string, unknown> } | null;
}

type LatchHaltOutcome =
  | { latched: false }
  | { latched: true; cancelledCount: number; close: CloseBatchIfSettledResult };

/**
 * The Halt latch itself — ONE body, two arms (owner and admin). Private: the
 * only way to reach it is through a verb that has already locked the batch,
 * derived its state and applied its own guard list.
 *
 * The five steps below are ORDERED, and the order is the contract rather than
 * an implementation detail:
 *
 *  1. CAS on `halted_at IS NULL` — monotone. No row back means someone else
 *     latched first, and NOTHING below runs; that is what makes a second halt
 *     add no audit row and no `batch_halted` step.
 *  2. Cancel `rendered`/`queued` and NEVER `sending`: that row is past the
 *     point of no return and resolves itself. Halt means "no further sends",
 *     not "undo".
 *  3. The audit row, when the caller asked for one. Here because
 *     `cancelled_count` is only known after step 2, and BEFORE step 4 so the
 *     run-spine calls stay last. It runs on `tx`, so a throw here rolls back
 *     steps 1-2 with it — the receipt and the latch go together or not at all.
 *  4. The spine step, skipped when the batch never minted a Send batch parent
 *     (generation can die before one exists, and an all-withheld build never
 *     enqueues generation at all).
 *  5. The settlement join. The latch NEVER terminalizes the Send batch parent
 *     itself — `closeBatchIfSettled` owns that — and it runs even when step 4
 *     was skipped, because a parentless batch still has to close.
 *
 * Steps 4 and 5 are the only `agent_runs` touches, and they are last, which is
 * the lock order this file's header describes: advisory batch lock ->
 * `solicitation_batches` row -> `agent_runs`.
 */
async function latchHalt(tx: TransactionSql, input: LatchHaltInput): Promise<LatchHaltOutcome> {
  // CAS on NULL keeps the latch monotone: a second halt returns at its caller's
  // guard, and a concurrent one writes nothing here.
  const [latched] = await tx<{ id: string }[]>`
    UPDATE solicitation_batches
    SET halted_at = NOW(),
        halt_reason = ${input.reason},
        halted_by = ${input.actorUserId}::uuid
    WHERE id = ${input.batchId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND business_id = ${input.businessId}::uuid
      AND halted_at IS NULL
    RETURNING id
  `;
  if (latched === undefined) return { latched: false };

  // 'sending' is excluded on purpose: that row is past the point of no
  // return and resolves itself. Halt means "no further sends", not "undo".
  const cancelled = await tx<{ id: string }[]>`
    UPDATE solicitation_outreach
    SET delivery_status = 'cancelled',
        disposition_reason = ${input.reason},
        updated_at = NOW()
    WHERE batch_id = ${input.batchId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND business_id = ${input.businessId}::uuid
      AND delivery_status IN ('rendered', 'queued')
    RETURNING id
  `;

  // Same transaction as the latch (CLAUDE.md "Audit writes"), never a raw
  // INSERT, and never conditional on a parent existing: for a parentless batch
  // this row is the ONLY durable record that a RepWorth operator acted.
  if (input.audit !== null) {
    await writeAccountAuditLog(tx, {
      accountId: input.accountId,
      locationId: input.businessId,
      actorUserId: input.actorUserId,
      eventType: input.audit.eventType,
      entityType: 'solicitation_batch',
      entityId: input.batchId,
      payload: {
        ...input.audit.payload,
        halt_reason: input.reason,
        state_at_halt: input.state,
        cancelled_count: cancelled.count,
      },
    });
  }

  // The parent may legitimately be absent — a built batch whose generation
  // never minted one. Skip the step, still join.
  if (input.sendParentRunId !== null) {
    await recordStep(tx, {
      runId: input.sendParentRunId,
      stepKey: 'batch_halted',
      detail: {
        halt_reason: input.reason,
        halted_by: input.actorUserId,
        cancelled_count: cancelled.count,
        state_at_halt: input.state,
      },
    });
  }

  const close = await closeBatchIfSettled(tx, {
    batchId: input.batchId,
    accountId: input.accountId,
    businessId: input.businessId,
  });

  return { latched: true, cancelledCount: cancelled.count, close };
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
    const locked = await lockBatchForAction(tx, batchId, input);
    if (locked === null) return { status: 'not_found' };
    const { batch, state } = locked;

    if (state === 'halted') return { status: 'already_halted' };
    if (state === 'closed') return { status: 'not_haltable', state };

    const reason = ownerHaltReason(state);

    // `audit: null` — D7 is admin-only. The owner arm's receipt is the batch
    // row itself plus the `batch_halted` step; `account_audit_log` is the
    // control-plane record of an operator acting on someone else's account.
    const outcome = await latchHalt(tx, {
      batchId,
      accountId: input.accountId,
      businessId: input.businessId,
      actorUserId: input.haltedByUserId,
      reason,
      state,
      sendParentRunId: batch.send_parent_run_id,
      audit: null,
    });
    if (!outcome.latched) return { status: 'already_halted' };

    return {
      status: 'halted',
      reason,
      cancelledCount: outcome.cancelledCount,
      close: outcome.close,
    };
  });
}

export interface AdminHaltBatchInput {
  batchId: string;
  accountId: string;
  businessId: string;
  /** The acting admin's `users.id` (D1) — the GLOBAL users table, not a tenant
   *  member. `halt_reason='admin_halt'` is the discriminator for actor class;
   *  it is never inferred from this id. */
  actorUserId: string;
  /** Required free-text note (D10). It rides the audit payload and nowhere
   *  else — `halt_reason` is fixed by the caller's identity. */
  note: string;
}

/**
 * No `reason` field, deliberately: it is always `admin_halt`, and carrying it
 * would invite a caller to believe it varies. That is the shape difference from
 * `HaltBatchResult`, which must report a DERIVED reason.
 */
export type AdminHaltBatchResult =
  | { status: 'halted'; cancelledCount: number; close: CloseBatchIfSettledResult }
  | { status: 'already_halted' }
  /** A closed batch is terminal, and an unbuilt one is refused per D11 below. */
  | { status: 'not_haltable'; state: BatchState }
  | { status: 'not_found' };

/**
 * The admin arm of the same monotone latch (#865): a RepWorth operator halting
 * a customer's send batch, with a required note and a durable
 * `account_audit_log` receipt naming them.
 *
 * Its guard list is the owner arm's plus ONE (D11): a `pending` batch —
 * `built_at IS NULL` — is refused. Latching it PASSES 091's halt-consistency
 * CHECK at halt time through the `built_at IS NULL` arm, and then the builder's
 * later `built_at = NOW()` stamp (guarded only on `built_at IS NULL`) produces
 * `halted_at < built_at` and a CHECK violation that throws inside the builder,
 * far from here. `haltBatch` carries the identical hole ON PURPOSE — fixing the
 * owner arm is an owner-visible behaviour change tracked as its own ticket.
 *
 * There is no un-halt: `halted_at` is monotone, the releaser predicate requires
 * `halted_at IS NULL`, and the rows this cancels are terminal.
 */
export async function adminHaltBatch(
  sql: Sql,
  input: AdminHaltBatchInput,
): Promise<AdminHaltBatchResult> {
  const batchId = canonicalBatchId(input.batchId);
  return sql.begin(async (tx): Promise<AdminHaltBatchResult> => {
    const locked = await lockBatchForAction(tx, batchId, input);
    // A foreign batch id and an unknown one are indistinguishable, which is
    // what the route's uniform 404 depends on.
    if (locked === null) return { status: 'not_found' };
    const { batch, state } = locked;

    if (state === 'halted') return { status: 'already_halted' };
    if (state === 'closed' || state === 'pending') return { status: 'not_haltable', state };

    const outcome = await latchHalt(tx, {
      batchId,
      accountId: input.accountId,
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      reason: ADMIN_HALT_REASON,
      state,
      sendParentRunId: batch.send_parent_run_id,
      audit: {
        eventType: ADMIN_HALT_EVENT_TYPE,
        payload: { note: input.note },
      },
    });
    if (!outcome.latched) return { status: 'already_halted' };

    return {
      status: 'halted',
      cancelledCount: outcome.cancelledCount,
      close: outcome.close,
    };
  });
}

export interface RequestAskRegenerationInput {
  batchId: string;
  askId: string;
  accountId: string;
  businessId: string;
  /** Regenerations left for this ask today, or `null` when the advisory peek
   *  could not answer. The ROUTE reads it (Redis belongs to the composition
   *  root, not a domain module) but this function DECIDES on it, so the
   *  decision lands after tenant validation. */
  budgetRemaining: number | null;
  /** The acting owner, recorded on the run step. Regeneration spends money on
   *  the owner's behalf, so the act is attributable even when the worker later
   *  refuses it. */
  requestedByUserId: string;
}

export type RequestAskRegenerationResult =
  /** Enqueued. The work is ACCEPTED, not done — the worker may still refuse it
   *  (budget race, subscription lapse, a swap that loses its re-check). */
  | { status: 'accepted' }
  /** A generation is already in flight for this batch. The dedup is keyed
   *  `(topic, aggregate_id = batchId)`, so this is per BATCH, not per ask —
   *  which is also why "regenerate all" cannot exist as a fan-out. Reported
   *  only AFTER the batch is proven to be this tenant's; the dedup index
   *  carries no tenant key, so an unproven caller must not be able to tell
   *  this arm from `not_found`. */
  | { status: 'already_in_flight' }
  /** ADR 0020: `built` is the only regenerable state. `approved`,
   *  `veto_window` and `sending` land here, and so do `halted` / `expired` /
   *  `closed`. */
  | { status: 'not_regenerable'; state: BatchState }
  /** The ask's current attempt is not `rendered` — a `withheld` row is terminal
   *  (§8.2 r6) and a released one is never superseded. */
  | { status: 'ask_not_regenerable'; deliveryStatus: string }
  /** The ask has spent its 3/day budget. Decided HERE rather than in the route
   *  so it lands AFTER tenant validation: the counter is keyed on the bare ask
   *  id, so answering 429 before proving ownership would let an authenticated
   *  owner tell a foreign ask from an unknown one (codex round 1, finding 4). */
  | { status: 'budget_exhausted' }
  | { status: 'not_found' };

/** Control-flow sentinel: aborts the request tx, rolling back the outbox row
 *  the enqueue-first lock order forces us to write before validating. Mirrors
 *  `RegenSwapAbort` in ask-generation.ts, which exists for the same reason. */
class RegenRequestAbort extends Error {
  constructor(public readonly result: RequestAskRegenerationResult) {
    super('ask regeneration request aborted');
    this.name = 'RegenRequestAbort';
  }
}

/**
 * The owner asking for one new draft — **Ask regeneration**'s request half.
 *
 * Everything expensive happens in the worker (`regenerateAsk`): this writes no
 * domain state at all, only the `job_outbox` row and the step recording who
 * asked, both in ONE transaction (invariant #2). The gates below are therefore
 * ADVISORY — the worker re-checks every one of them under its own locks, which
 * is the only reason a refusal here can be cheap.
 *
 * LOCK ORDER: `job_outbox` row -> advisory batch lock -> `solicitation_batches`
 * row -> `solicitation_outreach` row -> `agent_runs` (taken by `recordStep`).
 *
 * The FIRST element is the one amendment B11 does not mention and the one that
 * matters here. `regenerateAsk`'s swap opens with `markOutboxCompletedIfOwned`
 * — a row lock on `job_outbox` — and only THEN calls
 * `acquireSolicitationBatchLock`. So B11's stated "advisory first, then row
 * locks" is INCOMPLETE for any writer that owns an outbox attempt, and a
 * request path that took the advisory lock first would deadlock against the
 * worker it is enqueueing for: the worker would hold the outbox row and wait
 * for the advisory lock, while this transaction held the advisory lock and
 * waited for that outbox row (the `ON CONFLICT` uniqueness probe blocks on the
 * worker's uncommitted status change, which removes the row from the partial
 * index). Postgres would break it with a 40P01 on one side at random.
 *
 * Hence enqueue-first. Do not "tidy" this back into validate-first.
 *
 * VALIDATE AFTER MUTATE, and therefore ABORT BY THROWING. postgres.js COMMITS
 * when the `sql.begin` callback resolves, so a refusal reached by a normal
 * `return` after the enqueue would COMMIT the outbox row and start a
 * regeneration this function just refused. Every refusal below therefore throws
 * `RegenRequestAbort`, which rolls the row back; the catch maps it to the
 * result. This is the same shape, for the same reason, as `RegenSwapAbort`.
 *
 * ORDER OF REFUSALS is a security property, not a style choice. Every arm a
 * caller can distinguish is answered only once the statement above it has
 * proven the caller owns the thing being described: `not_found` first (the
 * batch), then `already_in_flight` (a fact about that proven batch), then
 * `not_regenerable`, then the ask-level arms, then `budget_exhausted` — the
 * only one keyed on a bare ask id, and therefore last.
 */
export async function requestAskRegeneration(
  sql: Sql,
  input: RequestAskRegenerationInput,
): Promise<RequestAskRegenerationResult> {
  const batchId = canonicalBatchId(input.batchId);
  try {
    return await sql.begin(async (tx): Promise<RequestAskRegenerationResult> => {
      // FIRST, before any other lock: the outbox row. See LOCK ORDER above.
      // `null` is the dedup arm; it is READ here and ANSWERED below, after
      // ownership. Nothing was written either way — DO NOTHING wrote no row
      // and took no row lock — so this probe leaves the transaction free to
      // go for the advisory lock next exactly as the accepting path does.
      const outboxId = await enqueueGenerateSolicitationAsks(tx, {
        batchId,
        businessId: input.businessId,
        askId: input.askId,
      });

      // Not `return`: the outbox row above is already written, and postgres.js
      // COMMITS on a normal return. This is why the shared helper answers with
      // null instead of a refusal of its own — see its docstring.
      const locked = await lockBatchForAction(tx, batchId, input);
      if (locked === null) throw new RegenRequestAbort({ status: 'not_found' });
      // `state` is BOUND here and ANSWERED below the dedup arm. Binding it is a
      // pure JS derivation over the row just read — no statement, no lock — so
      // the refusal ORDER this function's docstring pins is unchanged.
      const { batch, state } = locked;

      // NOW the dedup arm, and this ordering is the whole point (round-1 R5 /
      // adversarial A5). `enqueueGenerateSolicitationAsks` dedups on
      // `(topic, aggregate_id)` with NO tenant discriminator, so answering it
      // straight off the probe told an UNPROVEN caller whether a batch id they
      // do not own is currently regenerating: 409 for a foreign in-flight
      // batch where an unknown one answers 404 — an existence-and-activity
      // oracle, and the exact opposite of the uniform 404 this function
      // promises two checks down. `withScopedBatch` cannot cover it: it
      // UUID-validates the caller-supplied batch id and resolves the tenant
      // keys from the session, but it never proves the two belong together.
      //
      // Deferring the answer by ONE statement closes it and changes NO lock
      // order: the outbox probe is still the transaction's first statement and
      // the advisory lock is still taken second, so the ABBA against
      // `regenerateAsk`'s swap (outbox row -> advisory lock) remains
      // impossible. Do not "tidy" this back above `lockBatchForAction`.
      //
      // Past this line the batch is proven theirs, and "a generation is in
      // flight for this batch" is a fact about their own batch — which is also
      // why the answer may precede the ask-level lookup below without leaking:
      // the dedup is keyed on the BATCH, so the ask id contributes nothing to
      // it.
      if (outboxId === null) {
        throw new RegenRequestAbort({ status: 'already_in_flight' });
      }

      if (state !== 'built') {
        throw new RegenRequestAbort({ status: 'not_regenerable', state });
      }

      // The ask's live attempt, locked for the duration. Ordered by attempt_no
      // DESC and excluding `cancelled` for the same reason `loadCurrentOutreach`
      // does: superseded attempts stay in the table, and the newest surviving
      // row is the one a regenerate would replace.
      const [current] = await tx<{ delivery_status: string }[]>`
        SELECT o.delivery_status
        FROM solicitation_outreach o
        WHERE o.ask_id = ${input.askId}::uuid
          AND o.batch_id = ${batchId}::uuid
          AND o.account_id = ${input.accountId}::uuid
          AND o.business_id = ${input.businessId}::uuid
          AND o.delivery_status <> 'cancelled'
        ORDER BY o.attempt_no DESC
        LIMIT 1
        FOR UPDATE
      `;
      // An ask id from another batch or another tenant produces no row and is
      // indistinguishable from an unknown one — the uniform 404.
      if (current === undefined) throw new RegenRequestAbort({ status: 'not_found' });
      if (current.delivery_status !== 'rendered') {
        throw new RegenRequestAbort({
          status: 'ask_not_regenerable',
          deliveryStatus: current.delivery_status,
        });
      }

      // Budget LAST among the refusals, because it is the only one keyed on a
      // bare ask id: every check above has already proven this ask is ours, so
      // reaching this line leaks nothing. `null` means the advisory peek could
      // not answer (Redis down) and the request proceeds — the worker's Lua
      // INCR is the authoritative gate and is itself retryable.
      if (input.budgetRemaining !== null && input.budgetRemaining <= 0) {
        throw new RegenRequestAbort({ status: 'budget_exhausted' });
      }

      // ASSERT, do not branch: a live rendered row exists only because
      // generation ran under a send parent. `approveBatch` treats a null parent
      // as a refusal because its readiness gate passes VACUOUSLY over zero send
      // asks; here we have just read one of that parent's renders, so a null
      // parent is a broken invariant and must say so loudly.
      if (batch.send_parent_run_id === null) {
        throw new Error(
          `requestAskRegeneration: batch ${batchId} has a rendered ask but no send parent run`,
        );
      }

      await recordStep(tx, {
        runId: batch.send_parent_run_id,
        stepKey: 'ask_regeneration_requested',
        detail: {
          ask_id: input.askId,
          requested_by_user_id: input.requestedByUserId,
          outbox_id: outboxId,
        },
      });

      return { status: 'accepted' };
    });
  } catch (err) {
    // The sentinel is the ONE owner of why the request was refused. Every other
    // error — including the missing-send-parent assertion above — propagates,
    // because those are broken invariants, not owner-causable outcomes.
    if (err instanceof RegenRequestAbort) return err.result;
    throw err;
  }
}
