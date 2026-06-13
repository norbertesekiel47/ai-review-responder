// worker/jobs/billing/UpdateStripeOverageWorker.ts
//
// Updates the Stripe subscription's overage item quantity when the
// number of active locations changes (add, archive, tier change).
//
// Reads outbox rows with topic 'update_stripe_overage_quantity'. The handler
// orchestrates only: load context → call syncStripeOverageItem (which owns the
// Stripe interaction and returns a discriminated outcome) → map the outcome
// onto exactly one outbox effect. Error classification (transient/terminal)
// lives in stripe-overage-error.ts; the Stripe mutation logic in overage-sync.ts.
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
import { overagePriceIdForTier } from '../../../src/lib/payments/price-tier-map';
import { computeOverageQuantity } from '../../../src/lib/accounts/quota';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { classifyStripeOverageError } from './stripe-overage-error';
import { syncStripeOverageItem, type OverageSyncOutcome } from './overage-sync';

export interface UpdateStripeOveragePayload {
  account_id: string;
  correlation_id?: string;
  outbox_id?: string;
  outbox_attempt?: number;
}

export async function handleUpdateStripeOverage(
  job: Job<UpdateStripeOveragePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[UpdateStripeOverageWorker]', job.data.correlation_id);
  const { account_id } = job.data;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);
  const operationScope = `outbox:${outboxId}:corr:${job.data.correlation_id ?? 'none'}`;

  // Read account row. Stripe idempotency keys (overage-sync.ts) handle
  // concurrent jobs; a SELECT FOR UPDATE here would not survive PgBouncer
  // transaction pooling unless the entire Stripe call happened inside a DB
  // transaction.
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
  if (account.subscription_status !== SubscriptionStatus.ACTIVE) {
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

  let outcome: OverageSyncOutcome;
  try {
    outcome = await syncStripeOverageItem(getStripe(), {
      accountId: account_id,
      subscriptionId: account.stripe_subscription_id,
      storedOveragePriceCents: account.locations_overage_price_cents,
      overagePriceId,
      newQuantity,
      operationScope,
    }, logger);
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

  if (outcome.kind === 'ambiguous') {
    // No Stripe mutation happened. Terminal-fail the outbox row so ops sees it;
    // the reconcile poller independently alerts on the underlying drift.
    logger.error(`${outcome.detail} (account ${account_id})`);
    await markOutboxFailed(outboxId, outcome.detail, outboxAttempt);
    return;
  }

  // Outside the Stripe try/catch on purpose: a transient Postgres blip here
  // must NOT reach the Stripe classifier (it would mislabel a succeeded
  // operation as terminal and flip the row to 'failed'). Letting it throw
  // fails the job → BullMQ retries → the idempotency keys dedup the Stripe
  // re-run → completion is re-attempted. Convergent either way.
  await markOutboxCompleted(outboxId, outboxAttempt);
}
