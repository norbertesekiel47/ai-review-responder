import { UnrecoverableError, type Job } from 'bullmq';
import type { Sql } from 'postgres';
import type Stripe from 'stripe';
import { isTransientPostgresError } from '../../../src/lib/db/transient-error';
import { getStripe } from '../../../src/lib/payments/stripe-client';
import {
  extractOutboxHandle,
  markOutboxCompleted,
  markOutboxFailed,
  recordOutboxTransientError,
} from '../../../src/lib/shared/outbox';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import type { StripeCheckoutReconcilePayload } from '../../../src/lib/shared/worker-types';
import { processCheckoutSessionCompleted } from '../../ingress/stripe/checkout-completed';
import { classifyStripeOverageError } from './stripe-overage-error';

export async function handleStripeCheckoutReconcile(
  sql: Sql,
  job: Job<StripeCheckoutReconcilePayload>,
): Promise<void> {
  const logger = createWorkerLogger(
    '[StripeCheckoutReconcileWorker]',
    job.data.correlation_id,
  );
  const { account_id, checkout_session_id } = job.data;
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);

  try {
    const session = await getStripe().checkout.sessions.retrieve(checkout_session_id);
    if (session.client_reference_id !== account_id) {
      logger.warn(
        `Checkout Session ${checkout_session_id} client_reference_id mismatch for account=${account_id}`,
      );
      await markOutboxFailed(sql, outboxId, 'checkout_session_account_mismatch', attempt);
      return;
    }

    await processCheckoutSessionCompleted(session as Stripe.Checkout.Session);
    await markOutboxCompleted(sql, outboxId, attempt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Same retry policy as UpdateStripeOverageWorker (#1364). The try covers a
    // Stripe retrieve AND the Postgres writes inside processCheckoutSessionCompleted,
    // so both vocabularies apply: a Stripe outage / 429 / 5xx / 409 in-flight
    // conflict or a transient Postgres error is infra, not a deterministic
    // failure. Leave the row 'dispatched' so BullMQ retries and the 1h outbox
    // watchdog re-dispatches — markOutboxFailed here would strand the row
    // (markOutboxCompleted is guarded on status='dispatched', and the watchdog
    // only recovers 'dispatched'), so a later successful retry could never
    // record its success.
    if (isTransientPostgresError(err) || classifyStripeOverageError(err) === 'transient') {
      await recordOutboxTransientError(sql, outboxId, message, attempt);
      logger.error(
        `Transient Checkout Session reconciliation error for account=${account_id} (will retry): ${message}`,
      );
      throw err;
    }
    // Terminal: deterministic, never heals on retry. UnrecoverableError stops
    // BullMQ from re-running a failure the code just declared deterministic.
    logger.error(
      `Terminal Checkout Session reconciliation error for account=${account_id}: ${message}`,
    );
    await markOutboxFailed(sql, outboxId, message, attempt);
    throw new UnrecoverableError(message);
  }
}
