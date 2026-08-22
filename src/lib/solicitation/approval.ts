/**
 * The writers of send-mode's approval lane (#629 approve/halt, executor design
 * 2026-07-28 D9/D10/D22/D23; #860 ask regeneration; #865 the admin arm of the
 * Halt latch; #872 ask withdrawal; #900 the system arm of the Halt latch).
 *
 * What lives here and nothing else: `approveBatch`, `haltBatch`,
 * `adminHaltBatch`, `requestAskRegeneration`, `withdrawAsk` and
 * `latchSystemHalt`. The first five are transactional writers with an actor;
 * all five return a discriminated result so their routes stay thin (invariant
 * #12) and none throws for an outcome its actor can cause. A RepWorth operator
 * is a human actor too, which is why the admin arm belongs beside the owner
 * ones rather than in a module of its own.
 *
 * `latchSystemHalt` (#900) is the ONE writer here with no actor at all — a
 * clock, not a person, and 091's halt-consistency CHECK says so by requiring
 * `halted_by IS NULL` for exactly its two reasons. It lives here for the same
 * reason the admin arm does: it is the SAME latch, and a second copy of that
 * body is how a batch acquires a second receipt.
 *
 * The three halt verbs share ONE private latch, `latchHalt`, and its five steps
 * are ordered on purpose (see its own comment). Two hand-maintained copies of
 * that body is precisely how a batch acquires a second receipt, or a spine step
 * for a halt that never landed.
 *
 * `withdrawAsk` (#872, ADR 0021) is that latch at ask granularity: same lock
 * order, same row predicate, one row. It does NOT share `latchHalt` — the latch
 * writes `halted_at` on the batch and withdrawal writes nothing there, so the
 * two are the same discipline rather than the same body.
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
 * in any signature. All five verbs here do, and they are the only writers a
 * human triggers.
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
 *  written by `latchSystemHalt` below (#900) and are `SystemHaltReason`. */
export type OwnerHaltReason = 'owner_veto' | 'owner_halt';

/**
 * The two Halt latch reasons NO actor can cause — the send window running out
 * and the approval window running out. Both are derived from a clock, and
 * migration 091's `solicitation_batches_halt_consistency` CHECK makes that
 * structural rather than conventional:
 *
 *   (halted_by IS NOT NULL)
 *     = ((halt_reason IN ('owner_veto', 'owner_halt', 'admin_halt')) IS TRUE)
 *
 * so these two REQUIRE `halted_by IS NULL`. Exported because `latchSystemHalt`
 * is the public seam #900's release cycle latches through, and its caller has
 * to name the reason; nothing else may widen it.
 */
export type SystemHaltReason = 'send_window_elapsed' | 'batch_expired';

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
 * statement under the advisory lock. This is the shared opening of all FIVE
 * human-triggered verbs — four owner ones plus `adminHaltBatch`, whose actor is
 * a RepWorth operator rather than the tenant — and it stops exactly where they
 * diverge.
 *
 * Returns null when the batch does not exist for this tenant. Deliberately null
 * rather than a refusal value: every caller maps it onto the uniform 404 — so a
 * foreign batch id and an unknown one stay indistinguishable — but they do NOT
 * express it the same way. `approveBatch`, `haltBatch`, `adminHaltBatch` and
 * `withdrawAsk` return `{ status: 'not_found' }`; `requestAskRegeneration` must
 * THROW
 * `RegenRequestAbort`, because by the time it calls this it has already written
 * its `job_outbox` row and postgres.js COMMITS on a normal return. Folding the
 * four failures into one here would silently start the regeneration this
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
  return readBatchForAction(tx, batchId, tenant);
}

/**
 * The row read + state derivation, WITHOUT the advisory lock — the half
 * `latchSystemHalt` needs and the half `lockBatchForAction` wraps.
 *
 * Extracted rather than copied because a second hand-maintained spelling of
 * this SELECT is a second owner of the send-parent correlation, and that
 * correlation is the `subject_id` text compare `canonicalBatchId` exists to
 * keep honest. `FOR UPDATE OF b` stays here and is deliberate for BOTH callers:
 * the system arm's docstring makes the batch row lock the caller's obligation,
 * and re-taking a lock this transaction already holds is a no-op — so this
 * read is defensive for a caller that forgot, never a second lock in the order.
 *
 * The system arm skips only the ADVISORY lock, which its callers (the release
 * cycle's sweeps) do not take at all — so no cycle exists against the
 * advisory-then-row order the file header describes.
 */
async function readBatchForAction(
  tx: TransactionSql,
  batchId: string,
  tenant: { accountId: string; businessId: string },
): Promise<{ batch: BatchActionRow; state: BatchState } | null> {
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

/** The writable Halt latch reasons — all five, one mechanism. NOT exported:
 *  `OwnerHaltReason` stays the 2-member public write union, the admin arm's
 *  reason is a constant, and `SystemHaltReason` is the system arm's own. */
type LatchHaltReason = OwnerHaltReason | 'admin_halt' | SystemHaltReason;

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
  /** NULL for exactly the two `SystemHaltReason` members: 091's
   *  halt-consistency CHECK ties actor presence to the reason, so the signature
   *  expresses a rule the database already enforces. */
  actorUserId: string | null;
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
 * The Halt latch itself — ONE body, THREE arms (owner, admin, system). Private:
 * the only way to reach it is through a verb that has already locked the batch
 * and derived its state. The two human arms additionally apply their own guard
 * list; the system arm has no actor to refuse, so it applies none.
 *
 * The five steps below are ORDERED, and the order is the contract rather than
 * an implementation detail:
 *
 *  1. CAS on `halted_at IS NULL` — monotone. No row back means someone else
 *     latched first, and NOTHING below runs; that is what makes a second halt
 *     add no audit row and no `batch_halted` step.
 *
 *     **This arm is the system arm's ONLY defense, and deleting it is silent.**
 *     Issue #895(b) recorded that both human arms refuse at `state === 'halted'`
 *     first, against a row they already read `FOR UPDATE` — so through them the
 *     CAS is unreachable and every test that credits it is really testing the
 *     guard. `latchSystemHalt` skips that guard, which is what finally makes
 *     this line load-bearing; the monotonicity property in
 *     `approval-system-halt.integration.test.ts` goes RED when it is removed.
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
  /** A closed batch is terminal, and an unbuilt one is refused for the same
   *  091:176 reason the admin arm refuses it. */
  | { status: 'not_haltable'; state: BatchState }
  | { status: 'not_found' };

/**
 * One monotone latch (D10). A veto inside the window and a mid-drip halt are
 * the same write; only the reason differs, and it is derived, never supplied.
 *
 * A batch that was never approved is haltable on purpose: that is the owner
 * discarding a built batch, and routing it through the latch means one code
 * path closes every batch that ends early. A batch that is not built YET is
 * NOT: 091:176 reads `(halted_at IS NULL OR built_at IS NULL OR halted_at >=
 * built_at)`, so latching a `pending` batch passes the CHECK at halt time
 * through the `built_at IS NULL` arm and then makes `batch-builder`'s later
 * `built_at = NOW()` stamp — guarded only on `built_at IS NULL` — violate it,
 * throwing far from here.
 *
 * That guard was originally admin-arm-only, on the argument that the owner hole
 * was unreachable without a stop control on a building batch. Branch review
 * round 1 (F2) falsified the premise: `readLatestBatch` returns the pending
 * batch id to the authenticated owner and the halt route accepts any valid id
 * from its body, so the hole was API-reachable with an identifier the backend
 * itself hands out. Server-side lifecycle invariants cannot rest on a React
 * button being absent — see deviations D9.
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
    // Same two refusals as the admin arm, and for the same reasons: closed is
    // terminal, pending would strand the builder against 091:176.
    if (state === 'closed' || state === 'pending') return { status: 'not_haltable', state };

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
 * Its guard list is now IDENTICAL to the owner arm's: `halted` →
 * `already_halted`, `closed` and `pending` → `not_haltable`. The `pending`
 * refusal is D11 — latching a batch with `built_at IS NULL` PASSES 091's
 * halt-consistency CHECK at halt time through the `built_at IS NULL` arm, and
 * then the builder's later `built_at = NOW()` stamp (guarded only on
 * `built_at IS NULL`) produces `halted_at < built_at` and a CHECK violation that
 * throws inside the builder, far from here. It shipped admin-only and reached
 * `haltBatch` in the same branch once review round 1 (F2) showed the owner hole
 * was API-reachable; the two result unions still differ (this one carries no
 * `reason`), only the guard list is shared.
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

export interface LatchSystemHaltInput {
  batchId: string;
  accountId: string;
  businessId: string;
  /** Named by the caller because only the caller knows WHICH window ran out;
   *  it can never be a human reason — the type is two members for that reason. */
  reason: SystemHaltReason;
}

/**
 * No `state` and no `already_halted`: a clock cannot be told it was too late,
 * so there is nothing for a refusal vocabulary to describe. `not_latched` is
 * the whole non-latching half — the batch was already halted, or it is not this
 * tenant's, or it no longer exists — and every one of those is the same
 * instruction to the caller: this batch is not yours to terminalize this tick.
 */
export type LatchSystemHaltResult =
  | { status: 'not_latched' }
  | { status: 'latched'; cancelledCount: number; close: CloseBatchIfSettledResult };

/**
 * The SYSTEM arm of the same monotone latch (#900) — the writer the two
 * clock-derived **Halt latch** reasons never had (#630). The send window
 * elapsing and the approval window elapsing are the same write as an owner
 * veto, with no one to attribute it to.
 *
 * **The caller MUST already hold the batch row lock**, and this is the one
 * contract this function cannot check for itself. It is not a weakening: the
 * release cycle's sweeps select candidates OUTSIDE any lock, then take the
 * batch row lock and terminalize under it, so the lock is already theirs by the
 * time they call in. Re-reading the row here under `FOR UPDATE OF b` makes a
 * forgetful caller safe rather than merely wrong.
 *
 * It does NOT call `lockBatchForAction`, and the missing half is the ADVISORY
 * lock, not the row lock. That lock exists to serialise the HUMAN verbs against
 * the batch builder; there is no owner request here to authorize and no request
 * ordering to preserve, and a caller that takes the advisory lock is free to.
 *
 * **It applies NO guard list, deliberately.** `haltBatch` and `adminHaltBatch`
 * refuse `halted`, `closed` and `pending` because an actor is owed an answer;
 * a sweep is owed nothing, so `latchHalt`'s `halted_at IS NULL` CAS is the only
 * thing standing between two ticks and a second receipt — see step 1 of
 * `latchHalt`'s own comment, which is where that argument lives.
 *
 * The `pending` refusal the human arms carry is not needed here and could not
 * be reached anyway: both sweeps that call this require `built_at IS NOT NULL`
 * (`batch_expired`) or `approved_at IS NOT NULL` (`send_window_elapsed`), and
 * 091's approval-implies-built CHECK makes the second imply the first. Adding
 * the guard back would re-open the `state === 'halted'` hole above it.
 *
 * LOCK ORDER is unchanged: `solicitation_batches` row -> `agent_runs`. The
 * spine calls are `latchHalt`'s last two steps, exactly as for the human arms.
 */
export async function latchSystemHalt(
  tx: TransactionSql,
  input: LatchSystemHaltInput,
): Promise<LatchSystemHaltResult> {
  const batchId = canonicalBatchId(input.batchId);
  const locked = await readBatchForAction(tx, batchId, input);
  // No row for this tenant. Not an error to a sweep — the batch was purged or
  // the candidate list is stale — and the CAS below would have said the same.
  if (locked === null) return { status: 'not_latched' };
  const { batch, state } = locked;

  // `state` is read here for the SAME reason the human arms read it: it is the
  // `state_at_halt` the `batch_halted` receipt carries, derived once under the
  // lock off the same row the CAS targets. It is NOT a guard — nothing below
  // branches on it, which is the point.
  const outcome = await latchHalt(tx, {
    batchId,
    accountId: input.accountId,
    businessId: input.businessId,
    // NULL, and 091's halt-consistency CHECK rejects anything else for these
    // two reasons. `audit: null` for a stricter reason than the owner arm's:
    // `account_audit_log` records a RepWorth OPERATOR acting on someone else's
    // account, and filing a clock there would make the log lie about who acted.
    actorUserId: null,
    reason: input.reason,
    state,
    sendParentRunId: batch.send_parent_run_id,
    audit: null,
  });
  if (!outcome.latched) return { status: 'not_latched' };

  return {
    status: 'latched',
    cancelledCount: outcome.cancelledCount,
    close: outcome.close,
  };
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

/**
 * The three Batch states in which the **Halt latch** would cancel a
 * `rendered`/`queued` row: an approved batch that is neither halted nor closed.
 * Consumed by `classifyWithdrawal` below; exported for the property test
 * (`approval.test.ts` "withdrawable states are exactly the halt-cancellable
 * states of an approved batch"), which pins the member list to the lifecycle
 * timestamps rather than to a restated list. The panel does NOT import it —
 * it is a client component and this file runtime-imports server modules — and
 * derives the same three **Batch states** by hand through `panelMode →
 * haltable`; no test ties that mirror to this list, and a drift there only
 * mis-shows a control, because the authoritative check is the locked re-check
 * inside `withdrawAsk`.
 */
export function isWithdrawableState(state: BatchState): boolean {
  return state === 'veto_window' || state === 'approved' || state === 'sending';
}

export interface WithdrawAskInput {
  batchId: string;
  askId: string;
  accountId: string;
  businessId: string;
  /** The acting owner, recorded on the run step. */
  withdrawnByUserId: string;
}

export type WithdrawAskResult =
  | {
      status: 'withdrawn';
      /** Rows still `rendered`/`queued`/`sending` in this batch AFTER the
       *  withdrawal — the count the panel announces as "left to send". */
      remainingLive: number;
      close: CloseBatchIfSettledResult;
    }
  /** The ask's current attempt is already `cancelled`/`owner_withdrawn`: a
   *  double tap or a stale tab. Nothing is written — idempotent means no
   *  observable second effect, so no step either. */
  | { status: 'already_withdrawn' }
  /** `pending`, `built`, `expired`, `halted` or `closed`. `built` is Ask
   *  exclusion's job; the panel never offers Withdraw there. */
  | { status: 'not_withdrawable'; state: BatchState }
  /** The ask is in this batch but its current attempt is not `rendered`/
   *  `queued` — `sending` (past the point of no return), `sent`, `withheld`,
   *  `failed`, `unknown`, or cancelled for another reason — or it has no
   *  attempt at all (`null`). Nothing is written. */
  | { status: 'not_live'; deliveryStatus: string | null }
  /** Unknown batch, ask not in this batch, or foreign tenant — indistinguishable. */
  | { status: 'not_found' };

/** The ask's CURRENT attempt as the verb reads it under the lock; the caller
 *  passes null when the ask has no attempt at all. */
export interface CurrentAttempt {
  deliveryStatus: string;
  dispositionReason: string | null;
}

/**
 * The decision, PURE. `withdrawAsk` reads the Batch state and the current
 * attempt under the lock, applies this, and writes only on `withdraw`.
 * Extracted so the whole state × attempt-status matrix is one property test
 * (`approval.test.ts` invariants) rather than fifteen DB cases; the DB suite
 * then proves the READS (lock, LATERAL ordering, tenant keys) and the WRITES.
 */
export type WithdrawalDecision =
  | { kind: 'withdraw' }
  | { kind: 'already_withdrawn' }
  | { kind: 'not_withdrawable'; state: BatchState }
  | { kind: 'not_live'; deliveryStatus: string | null };

export function classifyWithdrawal(
  state: BatchState,
  attempt: CurrentAttempt | null,
): WithdrawalDecision {
  // Idempotence FIRST, before the state gate. Withdrawing the last live row
  // CLOSES the batch, so a retry on that very row arrives in `closed`; it is
  // still "already withdrawn" — a fact about the row — and must answer the
  // 200 no-op, not a 409. Only a row THIS verb cancelled reads this way; a row
  // cancelled for any other reason (superseded, a halt) is simply not live.
  if (attempt?.deliveryStatus === 'cancelled' && attempt.dispositionReason === 'owner_withdrawn') {
    return { kind: 'already_withdrawn' };
  }
  if (!isWithdrawableState(state)) return { kind: 'not_withdrawable', state };
  if (attempt === null) return { kind: 'not_live', deliveryStatus: null };
  // `rendered`/`queued` — the Halt latch's own row predicate. `sending` is past
  // the point of no return and lands below.
  if (attempt.deliveryStatus === 'rendered' || attempt.deliveryStatus === 'queued') {
    return { kind: 'withdraw' };
  }
  return { kind: 'not_live', deliveryStatus: attempt.deliveryStatus };
}

interface CurrentAttemptRow {
  outreach_id: string | null;
  delivery_status: string | null;
  disposition_reason: string | null;
}

/**
 * **Ask withdrawal** (#872, ADR 0021): cancel ONE approved Ask's live Outreach
 * row. It is the Halt latch at ask granularity and Ask exclusion after
 * approval — it removes a message and never replaces one, so it needs no
 * re-lint, no re-moderation and no per-ask approval state.
 *
 * Legal in exactly the states where the latch would cancel that row
 * (`isWithdrawableState`); the row must be `rendered` or `queued`, never
 * `sending` — halt's "no further sends, not undo" contract, inherited whole.
 *
 * LOCK ORDER is `haltBatch`'s: advisory batch lock -> `solicitation_batches`
 * row (inside `lockBatchForAction`) -> the outreach UPDATE -> `recordStep` ->
 * `closeBatchIfSettled`. Nothing here locks an `agent_runs` row before the
 * spine call. The releaser (#630) takes the batch lock before dispatching, so a
 * row this cancels can never be mid-dispatch under it — the same guarantee
 * halt already relies on.
 *
 * Validate-before-write, like `approveBatch`'s exclusion block: every refusal
 * below returns BEFORE the UPDATE, so postgres.js committing on a normal return
 * commits nothing.
 *
 * Keyed on the ASK: the current attempt is resolved here, under the batch
 * lock, so a stale tab holding a pre-regeneration view still withdraws the
 * right message.
 */
export async function withdrawAsk(
  sql: Sql,
  input: WithdrawAskInput,
): Promise<WithdrawAskResult> {
  const batchId = canonicalBatchId(input.batchId);
  // Same normalisation as the batch id and for the same reason: the step
  // detail records it as text.
  const askId = input.askId.toLowerCase();
  return sql.begin(async (tx): Promise<WithdrawAskResult> => {
    const locked = await lockBatchForAction(tx, batchId, input);
    if (locked === null) return { status: 'not_found' };
    const { batch, state } = locked;

    // NO early state refusal here: the current attempt is read first so a
    // retry after a last-row close (batch now `closed`) can still answer
    // `already_withdrawn`. The batch is already proven the tenant's, so the
    // read on a refused state leaks nothing; `classifyWithdrawal` orders it.
    // The ask's CURRENT attempt, joined from the ASK so an ask with no attempt
    // at all (a withhold ask, or a send ask whose only attempts were all
    // superseded away) is told apart from an ask that is not in this batch.
    // Both tenant keys are proven on the ask AND inside the lateral block —
    // the query-block tenant-scope audit checks each block independently.
    const [current] = await tx<CurrentAttemptRow[]>`
      SELECT
        cur.id AS outreach_id,
        cur.delivery_status,
        cur.disposition_reason
      FROM solicitation_asks a
      LEFT JOIN LATERAL (
        SELECT att.id, att.delivery_status, att.disposition_reason
        FROM solicitation_outreach att
        WHERE att.ask_id = a.id
          AND att.batch_id = a.batch_id
          AND att.account_id = ${input.accountId}::uuid
          AND att.business_id = ${input.businessId}::uuid
        ORDER BY att.attempt_no DESC
        LIMIT 1
      ) cur ON TRUE
      WHERE a.id = ${askId}::uuid
        AND a.batch_id = ${batchId}::uuid
        AND a.account_id = ${input.accountId}::uuid
        AND a.business_id = ${input.businessId}::uuid
    `;
    if (current === undefined) return { status: 'not_found' };

    // The decision is pure and property-tested; every refusal below returns
    // BEFORE any write.
    const attempt: CurrentAttempt | null =
      current.outreach_id === null || current.delivery_status === null
        ? null
        : { deliveryStatus: current.delivery_status, dispositionReason: current.disposition_reason };
    const decision = classifyWithdrawal(state, attempt);
    switch (decision.kind) {
      case 'not_withdrawable':
        return { status: 'not_withdrawable', state: decision.state };
      case 'not_live':
        return { status: 'not_live', deliveryStatus: decision.deliveryStatus };
      case 'already_withdrawn':
        return { status: 'already_withdrawn' };
      case 'withdraw':
        break;
    }
    // `withdraw` implies a non-null attempt row; the compiler cannot see it.
    if (current.outreach_id === null || current.delivery_status === null) {
      throw new Error(`withdrawAsk: classify said withdraw over a missing attempt for ask ${askId}`);
    }

    // The status literals are PARAMETERS so the query-shape pin can assert
    // them by value; the IN list stays literal, as in `haltBatch`.
    const cancelled = await tx<{ id: string }[]>`
      UPDATE solicitation_outreach
      SET delivery_status = ${'cancelled'},
          disposition_reason = ${'owner_withdrawn'},
          updated_at = NOW()
      WHERE id = ${current.outreach_id}::uuid
        AND batch_id = ${batchId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND business_id = ${input.businessId}::uuid
        AND delivery_status IN ('rendered', 'queued')
      RETURNING id
    `;
    // Losing this write is IMPOSSIBLE under the batch lock — every writer that
    // moves an outreach row past `queued` (halt, the future releaser) takes it
    // first, and the row was read `rendered`/`queued` above under that lock.
    // Throwing rolls back and keeps the claim honest, exactly like the approval
    // CAS in `approveBatch`.
    if (cancelled.count === 0) {
      throw new Error(
        `withdrawAsk: outreach ${current.outreach_id} left ${current.delivery_status} under the batch lock`,
      );
    }

    const [live] = await tx<{ live: number }[]>`
      SELECT COUNT(*)::int AS live
      FROM solicitation_outreach
      WHERE batch_id = ${batchId}::uuid
        AND account_id = ${input.accountId}::uuid
        AND business_id = ${input.businessId}::uuid
        AND delivery_status IN ('rendered', 'queued', 'sending')
    `;
    const remainingLive = live?.live ?? 0;

    // An approved batch always has a send parent: `approveBatch` refuses
    // `no_send_parent` before it approves. Asserted, not branched around.
    if (batch.send_parent_run_id === null) {
      throw new Error(`withdrawAsk: approved batch ${batchId} has no send parent run`);
    }
    await recordStep(tx, {
      runId: batch.send_parent_run_id,
      stepKey: 'ask_withdrawn',
      detail: {
        ask_id: askId,
        outreach_id: current.outreach_id,
        withdrawn_by: input.withdrawnByUserId,
        delivery_status_before: current.delivery_status,
        remaining_live: remainingLive,
        state_at_withdrawal: state,
      },
    });

    // The last live row settles the batch — same transaction, same single
    // owner of parent terminalization as every other terminal writer.
    const close = await closeBatchIfSettled(tx, {
      batchId,
      accountId: input.accountId,
      businessId: input.businessId,
    });

    return { status: 'withdrawn', remainingLive, close };
  });
}
