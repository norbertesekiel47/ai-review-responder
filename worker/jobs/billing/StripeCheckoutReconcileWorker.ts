import type { Job } from 'bullmq';
import type Stripe from 'stripe';
import { getStripe } from '../../../src/lib/payments/create-checkout-session';
import {
  extractOutboxHandle,
  markOutboxCompleted,
  markOutboxFailed,
} from '../../../src/lib/shared/outbox';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import type { StripeCheckoutReconcilePayload } from '../../../src/lib/shared/worker-types';
import { processCheckoutSessionCompleted } from '../../ingress/stripe/checkout-completed';

export async function handleStripeCheckoutReconcile(
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
      await markOutboxFailed(outboxId, 'checkout_session_account_mismatch', attempt);
      return;
    }

    await processCheckoutSessionCompleted(session as Stripe.Checkout.Session);
    await markOutboxCompleted(outboxId, attempt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `Checkout Session reconciliation failed for account=${account_id}: ${message}`,
    );
    await markOutboxFailed(outboxId, message, attempt);
    throw err;
  }
}
