import type { Job } from 'bullmq';
import type postgres from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/node';
import {
  errorMessage,
  extractOutboxHandle,
  isTerminalAttempt,
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
  runStripeCustomerRedactionPurgeStage,
  validatePurgeableOffboarding,
} from './purge-stages';
import { scrubOffboardingErrorForStorage } from '../../../src/lib/account-offboarding/scrub-error';
import { getStripe } from '../../../src/lib/payments/stripe-client';

const PURGE_ALERT_MESSAGE = 'account_offboarding_purge_failed';

/**
 * The two Sentry issue groups a purge failure can land in.
 *
 * Without them the constant message and absent fingerprint put a retry
 * `warning` and the terminal `error` in ONE issue, so a first-seen rule fired
 * on an early retry and stayed silent for the terminal event that actually
 * means an unmet deletion obligation (#1016, red-team RT-08). Exported because
 * `docs/runbooks/beta-launch-alerting.md` rule 16 configures a Sentry filter
 * against these exact members, and a test pins the two spellings together.
 */
export const PURGE_TERMINAL_FINGERPRINT = [PURGE_ALERT_MESSAGE, 'terminal'] as const;
export const PURGE_RETRY_FINGERPRINT = [PURGE_ALERT_MESSAGE, 'retry'] as const;

export async function handleAccountOffboardingPurge(
  sql: postgres.Sql,
  supabaseServer: SupabaseClient,
  job: Job<AccountOffboardingPurgePayload>,
): Promise<void> {
  const logger = createWorkerLogger(
    '[AccountOffboardingPurgeWorker]',
    job.data.correlation_id,
  );
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const offboarding = await loadPurgeOffboarding(
    sql,
    job.data.account_offboarding_id,
    job.data.account_id,
  );

  if (!offboarding) {
    await markOutboxFailed(sql, outboxId, 'account_offboarding_not_found', outboxAttempt);
    return;
  }

  if (offboarding.status === 'purged' || offboarding.terminal_at !== null) {
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  const validationError = validatePurgeableOffboarding(offboarding);
  if (validationError) {
    const safeMessage = scrubOffboardingErrorForStorage(validationError);
    alertPurgeFailure(job.data, safeMessage, isTerminalAttempt(job));
    if (!isTerminalAttempt(job)) {
      await markPurgeRetryableFailure(sql, offboarding, safeMessage);
      throw new Error(safeMessage);
    }
    await markPurgeTerminalFailure(sql, offboarding, safeMessage);
    await markOutboxFailed(sql, outboxId, safeMessage, outboxAttempt);
    return;
  }

  try {
    // Purge stages are strictly ordered (auth → refs → payload → content → … → tombstone →
    // finalize); each is its own transaction taking FOR UPDATE locks on the shared accounts row,
    // so running them in parallel would deadlock and violate the dependency ordering.
    // react-doctor-disable-next-line react-doctor/async-parallel
    //
    // THE STRIPE CALL RUNS FIRST — this INVERTS the original D5 and the reason
    // is worth stating, because D5's own rationale was false.
    //
    // D5 placed redaction immediately before the tombstone, arguing that by
    // then "every local destruction has committed, so the point of no return
    // has passed". The async and database review axes both showed that is
    // untrue: runParentTombstonePurgeStage — the stage that actually replaces
    // names, emails, phones and addresses with sentinels — runs AFTER. So a
    // Stripe outage that exhausted retries left auth deleted and content
    // destroyed while users/businesses/accounts still held live PII, with the
    // offboarding terminal, no receipt, and no automatic re-run.
    //
    // Running first restores fail-fast: a Stripe failure aborts with NOTHING
    // destroyed, and BullMQ retries the whole job cleanly.
    //
    // The hazard D5 feared — a LIVE account left with a wiped billing contact —
    // is not reachable here. An offboarding at this point has `purge_started_at`
    // set, and cancellation is gated on `purge_started_at IS NULL`
    // (`keep-my-data.ts`), so the account cannot return to service. The
    // shared-customer guard, not the ordering, is what protects a co-tenant.
    //
    // The worker resolves the client at its own boundary and passes it down —
    // the domain module never imports the singleton (invariant #15).
    await runStripeCustomerRedactionPurgeStage(sql, getStripe, offboarding);
    await runAuthBindingPurgeStage(sql, supabaseServer, offboarding);
    await runDependentReferencePurgeStage(sql, offboarding);
    await runRawPayloadPurgeStage(sql, offboarding, outboxId);
    await runContentPurgeStage(sql, offboarding);
    await runAnalyticsPurgeStage(sql, offboarding);
    await runProviderIdentifierPurgeStage(sql, offboarding);
    await runAuditAndCostPayloadPurgeStage(sql, offboarding);
    await runParentTombstonePurgeStage(sql, offboarding);

    // finalizePurgeInTransaction enqueues the purge-receipt email durably inside
    // its transaction (see M2), so there is no best-effort post-commit send to
    // lose on a crash.
    await finalizePurgeInTransaction(sql, offboarding, outboxId, outboxAttempt);
  } catch (err) {
    if (isStaleOutboxAttemptError(err)) {
      logger.log(`Skipping stale purge outbox attempt for offboarding ${offboarding.id}`);
      return;
    }

    const safeMessage = scrubOffboardingErrorForStorage(errorMessage(err));
    logger.error(`Purge failed for offboarding ${offboarding.id}: ${safeMessage}`);
    alertPurgeFailure(job.data, safeMessage, isTerminalAttempt(job));
    if (!isTerminalAttempt(job)) {
      await markPurgeRetryableFailure(sql, offboarding, safeMessage);
      throw new Error(safeMessage);
    }

    await markPurgeTerminalFailure(sql, offboarding, safeMessage);
    await markOutboxFailed(sql, outboxId, safeMessage, outboxAttempt);
  }
}

function alertPurgeFailure(
  payload: AccountOffboardingPurgePayload,
  safeMessage: string,
  terminal: boolean,
): void {
  Sentry.captureMessage(PURGE_ALERT_MESSAGE, {
    level: terminal ? 'error' : 'warning',
    fingerprint: [...(terminal ? PURGE_TERMINAL_FINGERPRINT : PURGE_RETRY_FINGERPRINT)],
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
