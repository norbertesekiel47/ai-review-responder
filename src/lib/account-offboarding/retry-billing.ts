import { createHash } from 'node:crypto';
import { sql } from '@/lib/db/server';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { enqueueAccountOffboardingBillingSchedule } from '@/lib/shared/job-outbox-helpers';

/**
 * Self-service recovery for a cancel_only offboarding whose billing-schedule step
 * exhausted its BullMQ retries (e.g. a prolonged Stripe outage) and landed
 * `status='failed', failed_step='billing'` with the subscription never cancelled.
 *
 * Without this the owner is stuck: the failed row is non-terminal so the
 * `terminal_at IS NULL` unique index blocks starting a fresh offboarding, and
 * reactivation only accepts `status='scheduled'`. This resets the row to
 * `pending` and re-enqueues the billing-schedule job in one transaction so the
 * worker can re-attempt the cancellation. Stripe's deterministic idempotency key
 * keeps the re-attempt safe even if the original call had partially applied.
 */
export interface RetryCancelOnlyBillingInput {
  accountId: string;
  actorUserId: string;
  idempotencyKey: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export type RetryCancelOnlyBillingResult =
  | {
    ok: true;
    offboarding: { id: string; accountId: string; mode: 'cancel_only'; status: 'pending' };
  }
  | { ok: false; reason: 'not_retryable' };

interface RetryableOffboardingRow {
  id: string;
}

export async function retryCancelOnlyBillingSchedule(
  input: RetryCancelOnlyBillingInput,
): Promise<RetryCancelOnlyBillingResult> {
  const idempotencyKeyHash = hashIdempotencyKey(input.idempotencyKey);

  return sql.begin(async (tx) => {
    await tx`
      SELECT id
      FROM accounts
      WHERE id = ${input.accountId}::uuid
      FOR UPDATE
    `;

    const [row] = await tx<RetryableOffboardingRow[]>`
      SELECT id
      FROM account_offboardings
      WHERE account_id = ${input.accountId}::uuid
        AND mode = 'cancel_only'
        AND status = 'failed'
        AND failed_step = 'billing'
        AND teardown_started_at IS NULL
        AND terminal_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `;
    if (!row) return { ok: false, reason: 'not_retryable' };

    const reset = await tx<RetryableOffboardingRow[]>`
      UPDATE account_offboardings
      SET status = 'pending',
          failed_step = NULL,
          stripe_step = 'not_applicable',
          last_error = NULL,
          retry_count = retry_count + 1,
          updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND account_id = ${input.accountId}::uuid
        AND mode = 'cancel_only'
        AND status = 'failed'
        AND failed_step = 'billing'
        AND teardown_started_at IS NULL
        AND terminal_at IS NULL
      RETURNING id
    `;
    if (reset.length === 0) return { ok: false, reason: 'not_retryable' };

    await writeAccountAuditLog(
      {
        accountId: input.accountId,
        actorUserId: input.actorUserId,
        eventType: 'account_offboarding_billing_retry',
        entityType: 'account_offboarding',
        entityId: row.id,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
        payload: {
          mode: 'cancel_only',
          status: 'pending',
          idempotency_key_hash: idempotencyKeyHash,
        },
      },
      tx,
    );

    await enqueueAccountOffboardingBillingSchedule(tx, {
      accountOffboardingId: row.id,
      accountId: input.accountId,
      idempotencyKeyHash,
      correlationId: input.requestId ?? undefined,
    });

    return {
      ok: true,
      offboarding: {
        id: row.id,
        accountId: input.accountId,
        mode: 'cancel_only',
        status: 'pending',
      },
    };
  });
}

function hashIdempotencyKey(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex');
}
