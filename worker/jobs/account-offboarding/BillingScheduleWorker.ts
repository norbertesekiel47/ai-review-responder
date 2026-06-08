import type { Job } from 'bullmq';
import Stripe from 'stripe';
import * as Sentry from '@sentry/node';
import { sql } from '../../../src/lib/db/server';
import {
  extractOutboxHandle,
  markOutboxCompleted,
  markOutboxFailed,
} from '../../../src/lib/shared/outbox';
import type { AccountOffboardingBillingSchedulePayload } from '../../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { enqueueAccountOffboardingEmail } from '../../../src/lib/shared/job-outbox-helpers';
import { scrubOffboardingErrorForStorage } from '../../../src/lib/account-offboarding/scrub-error';

interface AccountOffboardingBillingRow {
  id: string;
  account_id: string;
  mode: string;
  status: string;
  terminal_at: Date | string | null;
  access_ends_at: Date | string | null;
  stripe_subscription_id: string | null;
}

let stripeInstance: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    // Explicit timeout + bounded network retries (repworth.md reliability rule);
    // caps the 80s SDK default on the offboarding billing path.
    stripeInstance = new Stripe(key, { timeout: 20_000, maxNetworkRetries: 2 });
  }
  return stripeInstance;
}

export function accountOffboardingBillingIdempotencyKey(
  payload: AccountOffboardingBillingSchedulePayload,
): string {
  return [
    'account-offboarding-billing-schedule',
    payload.account_offboarding_id,
    payload.account_id,
    payload.idempotency_key_hash,
  ].join(':');
}

export async function handleAccountOffboardingBillingSchedule(
  job: Job<AccountOffboardingBillingSchedulePayload>,
): Promise<void> {
  const logger = createWorkerLogger(
    '[AccountOffboardingBillingScheduleWorker]',
    job.data.correlation_id,
  );
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const [offboarding] = await sql<AccountOffboardingBillingRow[]>`
    SELECT id, account_id, mode, status, terminal_at, access_ends_at, stripe_subscription_id
    FROM account_offboardings
    WHERE id = ${job.data.account_offboarding_id}::uuid
      AND account_id = ${job.data.account_id}::uuid
  `;

  if (!offboarding) {
    await markOutboxFailed(outboxId, 'account_offboarding_not_found', outboxAttempt);
    return;
  }

  if (offboarding.status === 'scheduled' && offboarding.access_ends_at) {
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const validationError = validateSchedulableOffboarding(offboarding);
  if (validationError) {
    const safeMessage = scrubOffboardingErrorForStorage(validationError);
    alertBillingScheduleFailure(job.data, safeMessage, isTerminalAttempt(job));
    if (!isTerminalAttempt(job)) {
      throw new Error(safeMessage);
    }
    await markBillingStepFailed(job.data, safeMessage);
    await markOutboxFailed(outboxId, safeMessage, outboxAttempt);
    return;
  }

  try {
    const subscription = await getStripe().subscriptions.update(
      offboarding.stripe_subscription_id!,
      { cancel_at_period_end: true },
      { idempotencyKey: accountOffboardingBillingIdempotencyKey(job.data) },
    );
    const accessEndsAt = parseStripeCurrentPeriodEnd(
      readCurrentPeriodEnd(subscription),
    );

    await sql.begin(async (tx) => {
      const updated = await tx<{ id: string }[]>`
        UPDATE account_offboardings
        SET status = 'scheduled',
            access_ends_at = ${accessEndsAt},
            billing_cancel_confirmed_at = NOW(),
            stripe_step = 'success',
            failed_step = NULL,
            last_error = NULL,
            updated_at = NOW()
        WHERE id = ${job.data.account_offboarding_id}::uuid
          AND account_id = ${job.data.account_id}::uuid
          AND mode = 'cancel_only'
          AND status = 'pending'
          AND terminal_at IS NULL
        RETURNING id
      `;

      if (updated.length === 0) {
        const [current] = await tx<{ status: string; access_ends_at: Date | string | null }[]>`
          SELECT status, access_ends_at
          FROM account_offboardings
          WHERE id = ${job.data.account_offboarding_id}::uuid
            AND account_id = ${job.data.account_id}::uuid
        `;
        if (!(current?.status === 'scheduled' && current.access_ends_at)) {
          throw new Error('account_offboarding_state_changed_before_billing_update');
        }
      }

      await enqueueAccountOffboardingEmail(tx, {
        accountOffboardingId: job.data.account_offboarding_id,
        accountId: job.data.account_id,
        idempotencyKeyHash: job.data.idempotency_key_hash,
        correlationId: job.data.correlation_id,
      });
      await markOutboxCompleted(outboxId, outboxAttempt, tx);
    });
  } catch (err) {
    const safeMessage = scrubOffboardingErrorForStorage(errorMessage(err));
    logger.error(`Billing cancellation schedule failed for offboarding ${offboarding.id}: ${safeMessage}`);
    alertBillingScheduleFailure(job.data, safeMessage, isTerminalAttempt(job));
    if (!isTerminalAttempt(job)) {
      throw err;
    }

    await markBillingStepFailed(job.data, safeMessage);
    await markOutboxFailed(outboxId, safeMessage, outboxAttempt);
  }
}

async function markBillingStepFailed(
  payload: AccountOffboardingBillingSchedulePayload,
  safeMessage: string,
): Promise<void> {
  await sql`
    UPDATE account_offboardings
    SET status = 'failed',
        failed_step = 'billing',
        stripe_step = 'failed',
        last_error = ${safeMessage},
        retry_count = retry_count + 1,
        updated_at = NOW()
    WHERE id = ${payload.account_offboarding_id}::uuid
      AND account_id = ${payload.account_id}::uuid
      AND terminal_at IS NULL
      AND status IN ('pending', 'scheduled')
  `;
}

function alertBillingScheduleFailure(
  payload: AccountOffboardingBillingSchedulePayload,
  safeMessage: string,
  terminal: boolean,
): void {
  Sentry.captureMessage('account_offboarding_billing_schedule_failed', {
    level: terminal ? 'error' : 'warning',
    tags: {
      subsystem: 'account_offboarding',
      step: 'billing',
      terminal: String(terminal),
    },
    extra: {
      account_offboarding_id: payload.account_offboarding_id,
      account_id: payload.account_id,
      error: safeMessage,
    },
  });
}

function validateSchedulableOffboarding(row: AccountOffboardingBillingRow): string | null {
  if (row.mode !== 'cancel_only') return 'account_offboarding_mode_not_cancel_only';
  if (row.terminal_at !== null) return 'account_offboarding_already_terminal';
  if (row.status !== 'pending') return `account_offboarding_status_not_pending:${row.status}`;
  if (!row.stripe_subscription_id?.trim()) return 'account_offboarding_missing_stripe_subscription_id';
  return null;
}

function parseStripeCurrentPeriodEnd(value: unknown): Date {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('Stripe subscription update did not return a valid current_period_end');
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Stripe subscription update did not return a valid current_period_end');
  }
  return date;
}

function readCurrentPeriodEnd(subscription: Stripe.Response<Stripe.Subscription>): unknown {
  return (subscription as unknown as { current_period_end?: unknown }).current_period_end;
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

