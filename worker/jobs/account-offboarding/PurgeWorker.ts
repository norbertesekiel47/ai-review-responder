import type { Job } from 'bullmq';
import * as Sentry from '@sentry/node';
import {
  extractOutboxHandle,
  markOutboxCompleted,
  markOutboxFailed,
} from '../../../src/lib/shared/outbox';
import type { AccountOffboardingPurgePayload } from '../../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import {
  finalizePurgeInTransaction,
  isStaleOutboxAttemptError,
  loadPurgeOffboarding,
  markPurgeRetryableFailure,
  markPurgeTerminalFailure,
  runAnalyticsPurgeStage,
  runAuditAndCostPayloadPurgeStage,
  runAuthBindingPurgeStage,
  runContentPurgeStage,
  runDependentReferencePurgeStage,
  runParentTombstonePurgeStage,
  runProviderIdentifierPurgeStage,
  runRawPayloadPurgeStage,
  runSmsOptOutPurgeStage,
  scrubPurgeErrorForStorage,
  validatePurgeableOffboarding,
} from './purge-stages';

export async function handleAccountOffboardingPurge(
  job: Job<AccountOffboardingPurgePayload>,
): Promise<void> {
  const logger = createWorkerLogger(
    '[AccountOffboardingPurgeWorker]',
    job.data.correlation_id,
  );
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const offboarding = await loadPurgeOffboarding(
    job.data.account_offboarding_id,
    job.data.account_id,
  );

  if (!offboarding) {
    await markOutboxFailed(outboxId, 'account_offboarding_not_found', outboxAttempt);
    return;
  }

  if (offboarding.status === 'purged' || offboarding.terminal_at !== null) {
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const validationError = validatePurgeableOffboarding(offboarding);
  if (validationError) {
    const safeMessage = scrubPurgeErrorForStorage(validationError);
    alertPurgeFailure(job.data, safeMessage, isTerminalAttempt(job));
    if (!isTerminalAttempt(job)) {
      await markPurgeRetryableFailure(offboarding, safeMessage);
      throw new Error(safeMessage);
    }
    await markPurgeTerminalFailure(offboarding, safeMessage);
    await markOutboxFailed(outboxId, safeMessage, outboxAttempt);
    return;
  }

  try {
    await runAuthBindingPurgeStage(offboarding);
    await runDependentReferencePurgeStage(offboarding);
    await runRawPayloadPurgeStage(offboarding, outboxId);
    await runContentPurgeStage(offboarding);
    await runAnalyticsPurgeStage(offboarding);
    await runSmsOptOutPurgeStage(offboarding);
    await runProviderIdentifierPurgeStage(offboarding);
    await runAuditAndCostPayloadPurgeStage(offboarding);
    await runParentTombstonePurgeStage(offboarding);

    await finalizePurgeInTransaction(offboarding, outboxId, outboxAttempt);
  } catch (err) {
    if (isStaleOutboxAttemptError(err)) {
      logger.log(`Skipping stale purge outbox attempt for offboarding ${offboarding.id}`);
      return;
    }

    const safeMessage = scrubPurgeErrorForStorage(errorMessage(err));
    logger.error(`Purge failed for offboarding ${offboarding.id}: ${safeMessage}`);
    alertPurgeFailure(job.data, safeMessage, isTerminalAttempt(job));
    if (!isTerminalAttempt(job)) {
      await markPurgeRetryableFailure(offboarding, safeMessage);
      throw new Error(safeMessage);
    }

    await markPurgeTerminalFailure(offboarding, safeMessage);
    await markOutboxFailed(outboxId, safeMessage, outboxAttempt);
  }
}

function alertPurgeFailure(
  payload: AccountOffboardingPurgePayload,
  safeMessage: string,
  terminal: boolean,
): void {
  Sentry.captureMessage('account_offboarding_purge_failed', {
    level: terminal ? 'error' : 'warning',
    tags: {
      subsystem: 'account_offboarding',
      step: 'purge',
      terminal: String(terminal),
    },
    extra: {
      account_offboarding_id: payload.account_offboarding_id,
      account_id: payload.account_id,
      error: safeMessage,
    },
  });
}

function isTerminalAttempt(job: Job<unknown>): boolean {
  const maxAttempts = typeof job.opts.attempts === 'number' && job.opts.attempts > 0
    ? job.opts.attempts
    : 1;
  return job.attemptsMade >= maxAttempts || job.attemptsMade + 1 >= maxAttempts;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
