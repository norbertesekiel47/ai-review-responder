import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { enqueueAccountOffboardingPurge } from '@/lib/account-offboarding/outbox';

/**
 * Admin re-drive for a `delete_data` offboarding purge that failed TERMINALLY
 * (`status='failed'`, `failed_step='purge'`) — #1411. Before this route
 * existed nothing could re-run it: `validatePurgeableOffboarding` rejects a
 * `failed` row, `AccountOffboardingPurgePoller` claims only
 * `status='purge_scheduled' AND purge_started_at IS NULL`, and the teardown
 * retry poller is scoped to `failed_step='teardown'`. A terminal purge failure
 * is a live PII retention risk (`docs/runbooks/beta-launch-alerting.md` rule
 * 16), so this was previously "escalate by hand".
 *
 * WHAT THE RESET DOES, AND WHY `purge_started_at` IS LEFT ALONE. Only three
 * fields change: `status` back to `purge_scheduled`, `failed_step` and
 * `last_error` cleared. `purge_started_at` is NOT reset — it already carries
 * the ORIGINAL claim timestamp from whichever `purge_scheduled` transition
 * happened first (the normal teardown-completion path, or an admin
 * `provider-disposition` force-transition), and `validatePurgeableOffboarding`
 * requires it to be non-null (`account_offboarding_purge_not_started`).
 * Leaving it set also means `AccountOffboardingPurgePoller`'s own claim query
 * (`purge_started_at IS NULL`) will never re-claim this row — the poller and
 * this admin action can never race for the same attempt, because this
 * function enqueues the purge job directly through the outbox rather than
 * waiting for the poller to notice a state change.
 *
 * REPLAY SAFETY. `PurgeWorker.handleAccountOffboardingPurge` has no per-stage
 * checkpoint: every retry — automatic (BullMQ) or this admin one — re-runs
 * EVERY stage in `purge-stages.ts` from `runStripeCustomerRedactionPurgeStage`
 * (first) through `finalizePurgeInTransaction`, because none of the
 * intermediate stages persist "stage N done" anywhere. Every stage is proven
 * idempotent against a half-purged row by
 * `worker/jobs/account-offboarding/__tests__/purge-redrive-idempotency.integration.test.ts`
 * — DELETEs and UPDATEs are no-ops on already-purged rows, the Stripe
 * redaction stage checks `isAlreadyRedacted`/`customer_absent` before ever
 * calling `customers.update` again, and the auth-binding stage checks
 * `already_detached` before calling `deleteUser` again. This function does
 * not itself touch any purged data — it only flips the lifecycle row and
 * re-enqueues.
 *
 * CONCURRENCY. The reset is ONE conditional `UPDATE … WHERE status='failed'
 * AND failed_step='purge' … RETURNING`, so two concurrent admin retries race
 * on Postgres's own row lock: only the winner's `RETURNING` is non-empty, and
 * the loser throws `account_offboarding_purge_not_retryable` having enqueued
 * nothing — "double-clicks enqueue once" without a separate advisory lock.
 * `retry_count` still increments once per successful transition, so the
 * DETERMINISTIC outbox id derived from it is stable for one logical retry and
 * distinct across retries, giving each attempt a traceable outbox row even
 * though the row lock is what actually makes the enqueue exactly-once.
 */

const PURGE_RETRY_OUTBOX_NAMESPACE = 'repworth:account-offboarding-purge-retry-outbox:v1';

export class PurgeRetryError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = 'PurgeRetryError';
  }
}

export interface RetryAccountOffboardingPurgeInput {
  offboardingId: string;
  adminUserId: string;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface RetryAccountOffboardingPurgeResult {
  offboardingId: string;
  accountId: string;
  status: 'purge_scheduled';
  retryCount: number;
  outboxId: string;
}

interface ResetOffboardingRow {
  id: string;
  account_id: string;
  retry_count: number;
}

export async function retryAccountOffboardingPurge(
  sql: postgres.Sql,
  input: RetryAccountOffboardingPurgeInput,
): Promise<RetryAccountOffboardingPurgeResult> {
  return sql.begin(async (tx) => {
    const [existing] = await tx<{ id: string }[]>`
      SELECT id
      FROM account_offboardings
      WHERE id = ${input.offboardingId}::uuid
      FOR UPDATE
    `;
    if (!existing) {
      throw new PurgeRetryError(404, 'offboarding_not_found');
    }

    // The row lock above already serializes concurrent retries on this id;
    // this UPDATE's WHERE clause is the actual eligibility gate. A failed
    // clause here (wrong mode/status/failed_step, or a row some other
    // transaction already reset) returns zero rows, never an exception —
    // "not retryable" is a normal, expected outcome, not a fault.
    const [reset] = await tx<ResetOffboardingRow[]>`
      UPDATE account_offboardings
      SET status = 'purge_scheduled',
          failed_step = NULL,
          last_error = NULL,
          retry_count = retry_count + 1,
          updated_at = NOW()
      WHERE id = ${input.offboardingId}::uuid
        AND mode = 'delete_data'
        AND status = 'failed'
        AND failed_step = 'purge'
        AND terminal_at IS NULL
      RETURNING id, account_id, retry_count
    `;
    if (!reset) {
      throw new PurgeRetryError(409, 'account_offboarding_purge_not_retryable');
    }

    const outboxId = deterministicPurgeRetryOutboxId(reset.id, reset.retry_count);

    await writeAccountAuditLog(tx, {
      accountId: reset.account_id,
      actorUserId: input.adminUserId,
      eventType: 'account_offboarding_purge_retry',
      entityType: 'account_offboarding',
      entityId: reset.id,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      payload: {
        status: 'purge_scheduled',
        retry_count: reset.retry_count,
        outbox_id: outboxId,
      },
    });

    await enqueueAccountOffboardingPurge(tx, {
      outboxId,
      accountOffboardingId: reset.id,
      accountId: reset.account_id,
      correlationId: input.requestId ?? undefined,
    });

    return {
      offboardingId: reset.id,
      accountId: reset.account_id,
      status: 'purge_scheduled',
      retryCount: reset.retry_count,
      outboxId,
    };
  });
}

/**
 * Deterministic, collision-resistant outbox id (UUIDv5-shaped: SHA-256 of
 * `namespace:offboardingId:retryCount`, version 0x5 / RFC-4122 variant), so
 * repeating this call with the same inputs always yields the same id. Mirrors
 * `deterministicOutboxId` in `outbox.ts` and `accountOffboardingDeliveryId` in
 * `email-dedup.ts` byte-for-byte — a third, narrower copy rather than a shared
 * export, because `outbox.ts` is deliberately "born injected" with zero
 * `@/lib/db/server` surface and this module's own id space (retry attempts,
 * not email/reactivation sends) has nothing to gain from sharing a generic
 * helper across three call sites for ten lines of code.
 */
function deterministicPurgeRetryOutboxId(offboardingId: string, retryCount: number): string {
  const digest = createHash('sha256')
    .update(`${PURGE_RETRY_OUTBOX_NAMESPACE}:${offboardingId}:${retryCount}`)
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
