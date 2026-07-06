import type { Job } from 'bullmq';
import type postgres from 'postgres';
import {
  extractOutboxHandle,
  markOutboxCompleted,
  markOutboxFailed,
} from '../../../src/lib/shared/outbox';
import type { AccountOffboardingReactivationPayload } from '../../../src/lib/shared/worker-types';
import { reactivateCancelOnlyOffboarding } from '../../../src/lib/account-offboarding/reactivate';
import { createWorkerLogger } from '../../../src/lib/shared/logger';

export async function handleAccountOffboardingReactivation(
  sql: postgres.Sql,
  job: Job<AccountOffboardingReactivationPayload>,
): Promise<void> {
  const logger = createWorkerLogger(
    '[AccountOffboardingReactivationWorker]',
    job.data.correlation_id,
  );
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const result = await reactivateCancelOnlyOffboarding(sql, {
    accountId: job.data.account_id,
    accountOffboardingId: job.data.account_offboarding_id,
    actorUserId: job.data.actor_user_id,
    idempotencyKeyHash: job.data.idempotency_key_hash,
    requestId: job.data.request_id ?? null,
    ip: job.data.ip ?? null,
    userAgent: job.data.user_agent ?? null,
  });

  if (result.ok) {
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  if (result.reason === 'stripe_reversal_unavailable') {
    logger.warn(`Stripe reversal unavailable for offboarding ${job.data.account_offboarding_id}`);
    await markOutboxFailed(sql, outboxId, 'account_offboarding_stripe_reversal_unavailable', outboxAttempt);
    return;
  }

  await markOutboxFailed(sql, outboxId, `account_offboarding_reactivation_${result.reason}`, outboxAttempt);
}
