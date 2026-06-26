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
import { captureMessage } from '@sentry/node';
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
import { subscriptionGrantsFullAccess } from '../../../src/lib/shared/subscription-status';
import { classifyStripeOverageError } from './stripe-overage-error';
import { isTransientPostgresError } from '../../../src/lib/db/transient-error';
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

  // Skip if subscription is not entitled (cancelled, pending, etc.). Trialing is
  // allowed: a mid-trial add-location must sync the Stripe quantity now, and
  // Stripe does not invoice the proration until trial end (PLAN.md §6 —
  // verified trial-safe, $0 until trial_end).
  if (!subscriptionGrantsFullAccess(account.subscription_status)) {
    logger.log(`Account ${account_id} subscription status is ${account.subscription_status} — skipping overage update`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

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

  const overagePriceId = overagePriceIdForTier(tier);

  if (!overagePriceId) {
    logger.error(`No overage price ID for tier ${tier}`);
    await markOutboxFailed(outboxId, `Missing overage price ID for tier: ${tier}`, outboxAttempt);
    return;
  }

  let outcome: OverageSyncOutcome;
  try {
    // OVERAGE-F1: serialize concurrent overage syncs for THIS account. The
    // per-outbox idempotency key (overage-sync.ts) does NOT dedup two DISTINCT
    // recompute rows for the same account, so a second replica or redeploy
    // overlap could double-`create` an overage item. The account-scoped
    // advisory lock (held across the Stripe resolve→mutate) closes that window
    // and is the hard gate before any worker scale-out. concurrency:1 +
    // single-replica remain as defense-in-depth (boot-asserted in index.ts).
    // The lock is held across the Stripe call; bounded by getStripe()'s request
    // timeout (single consumer + infrequent events → ~zero contention).
    outcome = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${account_id + ':overage_sync'}))`;
      // OVERAGE-F1b: recompute the live location count INSIDE the lock so the
      // serialized section acts on fresh state. Computing it pre-lock let two
      // concurrent same-account syncs read different counts; the older snapshot
      // could then update Stripe last and stale-over/under-bill. [Codex review]
      const [lockedCountRow] = await tx<{ count: number }[]>`
        SELECT COUNT(*) AS count
        FROM businesses
        WHERE account_id = ${account_id}::uuid
          AND archived_at IS NULL
      `;
      const newQuantity = computeOverageQuantity(
        Number(lockedCountRow?.count ?? 0),
        account.locations_included,
      );
      return syncStripeOverageItem(getStripe(), {
        accountId: account_id,
        subscriptionId: account.stripe_subscription_id!,
        storedOveragePriceCents: account.locations_overage_price_cents,
        overagePriceId,
        newQuantity,
        operationScope,
      }, logger);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The lock tx + Stripe call share this try. A transient Postgres error from
    // opening the tx, taking pg_advisory_xact_lock, or the in-lock count read
    // (connection drop, failover, statement/lock-wait timeout — codes NOT in
    // RETRYABLE_NETWORK_ERROR_CODES) is infra, NOT a deterministic Stripe
    // failure — retry it (BullMQ + the 1h outbox watchdog) rather than
    // terminal-failing the overage sync. Stripe transients are still classified
    // by classifyStripeOverageError. [Codex review]
    if (isTransientPostgresError(err) || classifyStripeOverageError(err) === 'transient') {
      // Leave the outbox row 'dispatched' so BullMQ retries and the 1h outbox
      // watchdog re-dispatches. Do NOT markOutboxFailed — that forfeits the
      // watchdog. Best-effort: surface the real error on the row for ops
      // visibility during a sustained outage (status untouched).
      await recordOutboxTransientError(outboxId, message, outboxAttempt);
      logger.error(`Transient overage sync error for account ${account_id} (will retry): ${message}`);
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
    // No Stripe mutation happened. Terminal-fail the outbox row so ops sees it.
    // Also page Sentry directly (OVERAGE-F2): an ambiguous match silently stops
    // billing this account's location growth until someone notices — logger.error
    // alone is not an alert. The reconcile poller also surfaces the underlying
    // drift, but at warning level on an hourly cadence.
    logger.error(`${outcome.detail} (account ${account_id})`);
    captureMessage(
      `Overage sync ambiguous — billing halted for account ${account_id}: ${outcome.detail}`,
      {
        level: 'error',
        tags: {
          feature: 'stripe_overage',
          account_id,
          drift_type: 'ambiguous_overage_item',
        },
      },
    );
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
