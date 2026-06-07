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
    stripeInstance = new Stripe(key);
  }
  return stripeInstance;
}

export function accountOffboardingTeardownStripeIdempotencyKey(
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
    await stripe.subscriptions.cancel(
      activeSubscriptionId,
      { invoice_now: false, prorate: false },
      {
        idempotencyKey: accountOffboardingTeardownStripeIdempotencyKey(
          row.id,
          row.account_id,
        ),
      },
    );
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
