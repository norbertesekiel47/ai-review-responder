import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { cleanupSubscriptionInvoices } from '../../../src/lib/account-offboarding/stripe-invoices';
import type { AccountOffboardingMode, AccountOffboardingStepOutcome } from '../../../src/lib/account-offboarding/types';

interface StripeTeardownRow {
  id: string;
  account_id: string;
  mode: AccountOffboardingMode;
  access_ends_at: Date | string | null;
  stripe_subscription_id: string | null;
  stripe_step: AccountOffboardingStepOutcome | null;
}

let stripeInstance: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    // Explicit bounds on the destructive teardown path: cap the 80s SDK default
    // timeout and keep network retries bounded (repworth.md reliability rule).
    stripeInstance = new Stripe(key, { timeout: 20_000, maxNetworkRetries: 2 });
  }
  return stripeInstance;
}

function accountOffboardingTeardownStripeIdempotencyKey(
  offboardingId: string,
  accountId: string,
): string {
  return `account-offboarding-teardown:${offboardingId}:${accountId}:stripe`;
}

export async function verifyCancelOnlyNaturalCancellation(
  row: StripeTeardownRow,
): Promise<void> {
  const subscriptionId = row.stripe_subscription_id?.trim();
  if (!subscriptionId) return;
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  if (subscription.status !== 'canceled') {
    throw new Error('account_offboarding_natural_cancellation_not_observed');
  }
}

export async function runStripeTeardown(row: StripeTeardownRow): Promise<void> {
  const subscriptionId = row.stripe_subscription_id?.trim();
  const requiresStripeTeardown = Boolean(subscriptionId);

  if (row.stripe_step === 'success') {
    return;
  }
  if (!requiresStripeTeardown && row.stripe_step === 'not_applicable') {
    return;
  }
  if (!requiresStripeTeardown) {
    await sql`
      UPDATE account_offboardings
      SET stripe_step = 'not_applicable',
          updated_at = NOW()
      WHERE id = ${row.id}::uuid
        AND account_id = ${row.account_id}::uuid
    `;
    return;
  }
  const activeSubscriptionId = subscriptionId!;

  const stripe = getStripe();
  if (row.mode === 'delete_data') {
    await cancelDeleteDataSubscription(stripe, activeSubscriptionId, row);
  }
  await cleanupSubscriptionInvoices({
    stripe,
    subscriptionId: activeSubscriptionId,
    operationScope: row.id,
  });

  await sql`
    UPDATE account_offboardings
    SET stripe_step = 'success',
        updated_at = NOW()
    WHERE id = ${row.id}::uuid
      AND account_id = ${row.account_id}::uuid
  `;
}

// Cancel the delete_data subscription, tolerating a subscription that is already
// canceled or deleted. The subscription can reach that state out-of-band (Stripe
// dunning, a customer.subscription.deleted race, a manual cancel) or on a teardown
// retry past the ~24h idempotency-key window. Re-cancelling then raises a permanent
// StripeInvalidRequestError; without this guard the destructive delete_data row
// strands as `failed` even though the desired end-state (canceled) already holds.
// Retryable errors still propagate to BullMQ; an unrecognized error is never masked.
async function cancelDeleteDataSubscription(
  stripe: Stripe,
  subscriptionId: string,
  row: StripeTeardownRow,
): Promise<void> {
  try {
    await stripe.subscriptions.cancel(
      subscriptionId,
      { invoice_now: false, prorate: false },
      {
        idempotencyKey: accountOffboardingTeardownStripeIdempotencyKey(
          row.id,
          row.account_id,
        ),
      },
    );
    return;
  } catch (err) {
    if (isRetryableStripeError(err)) throw err;
    if (!isStripeInvalidRequestError(err)) throw err;
    if (isStripeResourceMissing(err)) return; // subscription already deleted
    // Permanent invalid-request that isn't resource_missing: confirm the
    // subscription really is already canceled before treating it as done.
    let status: string;
    try {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      status = typeof subscription.status === 'string' ? subscription.status : 'unknown';
    } catch (retrieveErr) {
      if (isStripeResourceMissing(retrieveErr)) return; // deleted between cancel and retrieve
      throw err; // surface the original cancel error, which is more meaningful
    }
    if (status !== 'canceled') throw err;
  }
}

function isRetryableStripeError(err: unknown): boolean {
  const error = err as { type?: unknown; statusCode?: unknown };
  const type = typeof error.type === 'string' ? error.type : '';
  if (
    type === 'StripeAPIConnectionError'
    || type === 'StripeConnectionError'
    || type === 'StripeAPIError'
    || type === 'StripeRateLimitError'
  ) {
    return true;
  }
  const statusCode = typeof error.statusCode === 'number' ? error.statusCode : null;
  if (statusCode !== null) return statusCode === 429 || statusCode >= 500;
  return false;
}

function isStripeInvalidRequestError(err: unknown): boolean {
  const error = err as { type?: unknown; statusCode?: unknown };
  if (error.type === 'StripeInvalidRequestError') return true;
  const statusCode = typeof error.statusCode === 'number' ? error.statusCode : null;
  return statusCode !== null && statusCode >= 400 && statusCode < 500;
}

function isStripeResourceMissing(err: unknown): boolean {
  const error = err as { code?: unknown; statusCode?: unknown };
  return error.code === 'resource_missing' || error.statusCode === 404;
}
