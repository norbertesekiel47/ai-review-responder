// worker/jobs/billing/UpdateStripeOverageWorker.ts
//
// Updates the Stripe subscription's overage item quantity when the
// number of active locations changes (add, archive, tier change).
//
// Reads outbox rows with topic 'update_stripe_overage_quantity', then:
//   1. Looks up the account's Stripe subscription
//   2. Finds or creates the overage subscription item
//   3. Updates, creates, or deletes the overage subscription item
//      and uses proration_behavior = 'create_prorations' for billed changes
//
// Validation contract: VAL-BILLING-071, VAL-LOC-010, VAL-LOC-011, VAL-LOC-012.

import type { Job } from 'bullmq';
import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../../src/lib/shared/outbox';
import { TIER_CONFIG, type SubscriptionTierValue } from '../../../src/lib/accounts/tier-config';
import { overagePriceIdForTier, overagePriceIdSet } from '../../../src/lib/payments/price-tier-map';
import { computeOverageQuantity } from '../../../src/lib/accounts/quota';
import { createWorkerLogger, type WorkerLogger } from '../../../src/lib/shared/logger';

export interface UpdateStripeOveragePayload {
  account_id: string;
  correlation_id?: string;
  outbox_id?: string;
  outbox_attempt?: number;
}

// Lazy singleton — avoids crashing on import when STRIPE_SECRET_KEY is absent
let stripeInstance: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    stripeInstance = new Stripe(key);
  }
  return stripeInstance;
}

function overageUpdateIdempotencyKey(
  accountId: string,
  subscriptionItemId: string,
  quantity: number,
  operationScope: string,
): string {
  return `stripe-overage-update:${accountId}:${subscriptionItemId}:${quantity}:${operationScope}`;
}

function overageCreateIdempotencyKey(
  accountId: string,
  subscriptionId: string,
  priceId: string,
  quantity: number,
  operationScope: string,
): string {
  return `stripe-overage-create:${accountId}:${subscriptionId}:${priceId}:${quantity}:${operationScope}`;
}

function overageDeleteIdempotencyKey(
  accountId: string,
  subscriptionItemId: string,
  operationScope: string,
): string {
  return `stripe-overage-delete:${accountId}:${subscriptionItemId}:0:${operationScope}`;
}

function overageOperationScope(outboxId: string, correlationId: string | undefined): string {
  return `outbox:${outboxId}:corr:${correlationId ?? 'none'}`;
}

export async function handleUpdateStripeOverage(
  job: Job<UpdateStripeOveragePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[UpdateStripeOverageWorker]', job.data.correlation_id);
  const { account_id } = job.data;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);
  const operationScope = overageOperationScope(outboxId, job.data.correlation_id);

  // Read account row. Stripe idempotency keys below handle concurrent jobs;
  // a SELECT FOR UPDATE here would not survive PgBouncer transaction pooling
  // unless the entire Stripe call happened inside a DB transaction.
  const [account] = await sql<{
    id: string;
    subscription_tier: string;
    subscription_status: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    locations_included: number;
  }[]>`
    SELECT id, subscription_tier, subscription_status,
           stripe_customer_id, stripe_subscription_id, locations_included
    FROM accounts
    WHERE id = ${account_id}::uuid
  `;

  if (!account) {
    logger.error(`Account not found: ${account_id}`);
    await markOutboxFailed(outboxId, `Account not found: ${account_id}`, outboxAttempt);
    return;
  }

  // Skip if no Stripe subscription exists
  if (!account.stripe_subscription_id) {
    logger.log(`No Stripe subscription for account ${account_id} — skipping overage update`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // Skip if subscription is not active (cancelled, pending, etc.)
  if (account.subscription_status !== 'active') {
    logger.log(`Account ${account_id} subscription status is ${account.subscription_status} — skipping overage update`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // Count active locations
  const [locationRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*) AS count
    FROM businesses
    WHERE account_id = ${account_id}::uuid
      AND archived_at IS NULL
  `;
  const activeLocations = Number(locationRow?.count ?? 0);

  // Compute new overage quantity
  const tier = account.subscription_tier as SubscriptionTierValue;
  const config = TIER_CONFIG[tier];
  if (!config) {
    logger.error(`Unknown tier ${account.subscription_tier} for account ${account_id}`);
    await markOutboxFailed(outboxId, `Unknown tier: ${account.subscription_tier}`, outboxAttempt);
    return;
  }

  // Basic tier has no overage
  if (!config.multiLocAllowed) {
    logger.log(`Account ${account_id} is on basic tier — no overage to update`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const newQuantity = computeOverageQuantity(activeLocations, account.locations_included);
  const overagePriceId = overagePriceIdForTier(tier);

  if (!overagePriceId) {
    logger.error(`No overage price ID for tier ${tier}`);
    await markOutboxFailed(outboxId, `Missing overage price ID for tier: ${tier}`, outboxAttempt);
    return;
  }

  const stripe = getStripe();

  try {
    // Retrieve the subscription to find the overage item
    const subscription = await stripe.subscriptions.retrieve(
      account.stripe_subscription_id,
    );

    const overagePriceIds = overagePriceIdSet();

    const existingOverageItem = subscription.items.data.find(
      (item) => item.price?.id && overagePriceIds.has(item.price.id),
    );

    if (existingOverageItem && newQuantity === 0) {
      await stripe.subscriptionItems.del(
        existingOverageItem.id,
        {},
        {
          idempotencyKey: overageDeleteIdempotencyKey(
            account_id,
            existingOverageItem.id,
            operationScope,
          ),
        },
      );
      logger.log(`Deleted overage item ${existingOverageItem.id} for account ${account_id} because computed quantity=0`);
    } else if (existingOverageItem) {
      // VAL-LOC-010: Update existing overage item quantity
      await stripe.subscriptionItems.update(
        existingOverageItem.id,
        {
          quantity: newQuantity,
          proration_behavior: 'create_prorations',
        },
        {
          idempotencyKey: overageUpdateIdempotencyKey(
            account_id,
            existingOverageItem.id,
            newQuantity,
            operationScope,
          ),
        },
      );
      logger.log(`Updated overage item ${existingOverageItem.id} to quantity=${newQuantity} for account ${account_id}`);
    } else if (newQuantity > 0) {
      // VAL-BILLING-071: Create overage subscription item when none exists
      await stripe.subscriptionItems.create(
        {
          subscription: account.stripe_subscription_id,
          price: overagePriceId,
          quantity: newQuantity,
          proration_behavior: 'create_prorations',
        },
        {
          idempotencyKey: overageCreateIdempotencyKey(
            account_id,
            account.stripe_subscription_id,
            overagePriceId,
            newQuantity,
            operationScope,
          ),
        },
      );
      logger.log(`Created overage item with price=${overagePriceId} quantity=${newQuantity} for account ${account_id}`);
    } else {
      logger.log(`No overage item exists and computed quantity=0 for account ${account_id} — nothing to create`);
    }

    await markOutboxCompleted(outboxId, outboxAttempt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Stripe overage update failed for account ${account_id}: ${message}`);
    await markOutboxFailed(outboxId, message, outboxAttempt);
    throw err; // Re-throw so BullMQ retries
  }
}
