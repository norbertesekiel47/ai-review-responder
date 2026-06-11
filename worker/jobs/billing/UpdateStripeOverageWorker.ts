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

import { UnrecoverableError, type Job } from 'bullmq';
import { getStripe } from '../../../src/lib/payments/stripe-client';
import { sql } from '../../../src/lib/db/server';
import {
  markOutboxCompleted,
  markOutboxFailed,
  recordOutboxTransientError,
  extractOutboxHandle,
} from '../../../src/lib/shared/outbox';
import { TIER_CONFIG, type SubscriptionTierValue } from '../../../src/lib/accounts/tier-config';
import { basePriceIdSet, overagePriceIdForTier, overagePriceIdSet } from '../../../src/lib/payments/price-tier-map';
import {
  findOverageItemMatch,
  MUTATION_SAFE_OVERAGE_MATCHES,
  OVERAGE_BILLING_ROLE,
} from '../../../src/lib/payments/overage-item';
import { computeOverageQuantity } from '../../../src/lib/accounts/quota';
import { createWorkerLogger, type WorkerLogger } from '../../../src/lib/shared/logger';
import { classifyStripeOverageError } from './stripe-overage-error';

export interface UpdateStripeOveragePayload {
  account_id: string;
  correlation_id?: string;
  outbox_id?: string;
  outbox_attempt?: number;
}

// Idempotency keys stay operation-scoped (per-outbox via overageOperationScope)
// on purpose. This worker is single-consumer (concurrency:1 + one Railway
// instance), so BullMQ's bounded retry window (~3 attempts over ~15s) never
// overlaps the 1h outbox watchdog — a per-job key safely dedups the retry burst.
// A stable per-subscription create key was rejected: a delete→re-add within
// Stripe's ~24h key TTL would 400 `idempotency_error` deterministically (same
// key, different params), permanently failing a legitimate re-add. The
// per-outbox scope gives every distinct recompute a fresh key.
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
    locations_overage_price_cents: number;
  }[]>`
    SELECT id, subscription_tier, subscription_status,
           stripe_customer_id, stripe_subscription_id, locations_included,
           locations_overage_price_cents
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

  // Set inside the try when the only match is descriptor-confidence: that is
  // enough to FLAG an item (read-only poller tolerance) but never enough to
  // DELETE or re-quantity one — a nickname like "Priority Support Add-on"
  // keyword-matches. Terminal-fail for ops attention instead of mutating.
  let ambiguousMatchError: string | undefined;

  try {
    // Retrieve the subscription to find the overage item
    const subscription = await stripe.subscriptions.retrieve(
      account.stripe_subscription_id,
    );

    // Single owner of the "which item is the overage item?" predicate. Matching
    // a legacy/rotated price by stored unit-amount (not just the env price ID)
    // is what prevents adding a SECOND overage item — and double-billing — when
    // the env overage price has been rotated away from the one on the sub.
    const overageMatch = findOverageItemMatch(subscription.items.data, {
      overagePriceIds: overagePriceIdSet(),
      basePriceIds: basePriceIdSet(),
      storedOveragePriceCents: account.locations_overage_price_cents,
    });

    if (overageMatch && !MUTATION_SAFE_OVERAGE_MATCHES.has(overageMatch.matchedBy)) {
      ambiguousMatchError =
        `ambiguous_overage_item: item ${overageMatch.item.id} matched only by ` +
        `${overageMatch.matchedBy} — refusing to mutate; resolve manually ` +
        `(stamp metadata.billing_role='${OVERAGE_BILLING_ROLE}' on the real overage item)`;
    }

    const existingOverageItem =
      overageMatch && MUTATION_SAFE_OVERAGE_MATCHES.has(overageMatch.matchedBy)
        ? overageMatch.item
        : undefined;

    if (ambiguousMatchError) {
      // Fall through to the post-try handling below without touching Stripe.
    } else if (existingOverageItem && newQuantity === 0) {
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
      // VAL-BILLING-071: Create overage subscription item when none exists.
      // The billing_role stamp makes every app-created item exactly matchable
      // forever, independent of price rotations and descriptors.
      await stripe.subscriptionItems.create(
        {
          subscription: account.stripe_subscription_id,
          price: overagePriceId,
          quantity: newQuantity,
          proration_behavior: 'create_prorations',
          metadata: { billing_role: OVERAGE_BILLING_ROLE },
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (classifyStripeOverageError(err) === 'transient') {
      // Leave the outbox row 'dispatched' so BullMQ retries and the 1h outbox
      // watchdog re-dispatches. Do NOT markOutboxFailed — that forfeits the
      // watchdog. Best-effort: surface the real error on the row for ops
      // visibility during a sustained outage (status untouched).
      await recordOutboxTransientError(outboxId, message);
      logger.error(`Transient Stripe overage error for account ${account_id} (will retry): ${message}`);
      throw err;
    }
    // Terminal: a deterministic failure that will never heal on retry.
    // UnrecoverableError stops BullMQ from re-running a failure the code just
    // declared deterministic (a plain throw would re-execute the Stripe calls).
    logger.error(`Terminal Stripe overage error for account ${account_id}: ${message}`);
    await markOutboxFailed(outboxId, message, outboxAttempt);
    throw new UnrecoverableError(message);
  }

  if (ambiguousMatchError) {
    // No Stripe mutation happened. Terminal-fail the outbox row so ops sees it;
    // the reconcile poller independently alerts on the underlying drift.
    logger.error(`${ambiguousMatchError} (account ${account_id})`);
    await markOutboxFailed(outboxId, ambiguousMatchError, outboxAttempt);
    return;
  }

  // Outside the Stripe try/catch on purpose: a transient Postgres blip here
  // must NOT reach the Stripe classifier (it would mislabel a succeeded
  // operation as terminal and flip the row to 'failed'). Letting it throw
  // fails the job → BullMQ retries → the idempotency keys dedup the Stripe
  // re-run → completion is re-attempted. Convergent either way.
  await markOutboxCompleted(outboxId, outboxAttempt);
}
