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
import type { Sql } from 'postgres';
import { captureMessage } from '@sentry/node';
import { getStripe } from '../../../src/lib/payments/stripe-client';
import {
  markOutboxCompleted,
  markOutboxFailed,
  recordOutboxTransientError,
  extractOutboxHandle,
} from '../../../src/lib/shared/outbox';
import {
  isPriceVariant,
  isSubscriptionTier,
} from '../../../src/lib/accounts/tier-config';
import { acquireBillingLock } from '../../../src/lib/accounts/billing-locks';
import { overagePriceIdForStoredCents } from '../../../src/lib/payments/price-tier-map';
import { computeOverageQuantity } from '../../../src/lib/accounts/quota';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { subscriptionGrantsFullAccess } from '../../../src/lib/shared/subscription-status';
import { classifyStripeOverageError } from './stripe-overage-error';
import { isTransientPostgresError } from '../../../src/lib/db/transient-error';
import {
  getOffboardingState,
  isBillingManagementBlocked,
  isBillingMutationBlocked,
} from '../../../src/lib/account-offboarding/gate';
import { syncStripeOverageItem, type OverageSyncOutcome } from './overage-sync';

export interface UpdateStripeOveragePayload {
  account_id: string;
  correlation_id?: string;
  outbox_id?: string;
  outbox_attempt?: number;
}

type LockedOverageExecution =
  | { kind: 'account_missing' }
  | { kind: 'skip'; detail: string }
  | { kind: 'invalid'; detail: string }
  | { kind: 'sync'; outcome: OverageSyncOutcome };

/**
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports ../../../src/lib/db/server).
 */
export async function handleUpdateStripeOverage(
  sql: Sql,
  job: Job<UpdateStripeOveragePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[UpdateStripeOverageWorker]', job.data.correlation_id);
  const { account_id } = job.data;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);
  const operationScope = `outbox:${outboxId}:corr:${job.data.correlation_id ?? 'none'}`;

  let execution: LockedOverageExecution;
  try {
    execution = await sql.begin(async (tx): Promise<LockedOverageExecution> => {
      // Fixed overage-only order: billing advisory lock, then account row. No
      // account state is read and no row is held while the lock is awaited.
      await acquireBillingLock(tx, account_id);
      const [account] = await tx<{
        id: string;
        subscription_tier: string;
        subscription_status: string;
        price_variant: string;
        stripe_subscription_id: string | null;
        locations_included: number;
        locations_overage_price_cents: number;
      }[]>`
        SELECT
          id,
          subscription_tier,
          subscription_status,
          price_variant,
          stripe_subscription_id,
          locations_included,
          locations_overage_price_cents
        FROM accounts
        WHERE id = ${account_id}::uuid
        FOR UPDATE
      `;
      if (!account) return { kind: 'account_missing' };

      // Read current offboarding state only after the canonical billing-lock →
      // account-row lock order. Delayed/dispatched outbox jobs must observe an
      // offboarding flow that started after enqueue. Full-block states permit
      // no provider mutation, so complete this stale recompute as a no-op.
      const offboardingState = await getOffboardingState(account_id, tx);
      if (isBillingManagementBlocked(offboardingState)) {
        return {
          kind: 'skip',
          detail: 'is in a full-block offboarding state',
        };
      }
      if (!account.stripe_subscription_id) {
        return { kind: 'skip', detail: 'no Stripe subscription' };
      }
      // Trialing is full access. Pending/cancelled remain no-op outbox success.
      if (!subscriptionGrantsFullAccess(account.subscription_status)) {
        return {
          kind: 'skip',
          detail: `subscription status is ${account.subscription_status}`,
        };
      }
      if (!isSubscriptionTier(account.subscription_tier)) {
        return {
          kind: 'invalid',
          detail: `Unknown tier: ${account.subscription_tier}`,
        };
      }
      if (!isPriceVariant(account.price_variant)) {
        return {
          kind: 'invalid',
          detail: `Unknown price variant: ${account.price_variant}`,
        };
      }
      const overagePriceId = overagePriceIdForStoredCents(
        account.subscription_tier,
        account.locations_overage_price_cents,
      );

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
      const outcome = await syncStripeOverageItem(
        getStripe(),
        {
          accountId: account_id,
          subscriptionId: account.stripe_subscription_id,
          tier: account.subscription_tier,
          storedOveragePriceCents: account.locations_overage_price_cents,
          overagePriceId,
          newQuantity,
          mutationPolicy: isBillingMutationBlocked(offboardingState)
            ? 'contractions_only'
            : 'allow_all',
          operationScope,
        },
        logger,
      );
      return { kind: 'sync', outcome };
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
      await recordOutboxTransientError(sql, outboxId, message, outboxAttempt);
      logger.error(`Transient overage sync error for account ${account_id} (will retry): ${message}`);
      throw err;
    }
    // Terminal: a deterministic failure that will never heal on retry.
    // UnrecoverableError stops BullMQ from re-running a failure the code just
    // declared deterministic (a plain throw would re-execute the Stripe calls).
    logger.error(`Terminal Stripe overage error for account ${account_id}: ${message}`);
    await markOutboxFailed(sql, outboxId, message, outboxAttempt);
    throw new UnrecoverableError(message);
  }

  if (execution.kind === 'account_missing') {
    logger.error(`Account not found: ${account_id}`);
    await markOutboxFailed(
      sql,
      outboxId,
      `Account not found: ${account_id}`,
      outboxAttempt,
    );
    return;
  }
  if (execution.kind === 'skip') {
    logger.log(`Account ${account_id} ${execution.detail} — skipping overage update`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }
  if (execution.kind === 'invalid') {
    logger.error(`${execution.detail} for account ${account_id}`);
    await markOutboxFailed(sql, outboxId, execution.detail, outboxAttempt);
    return;
  }

  const outcome = execution.outcome;

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
    await markOutboxFailed(sql, outboxId, outcome.detail, outboxAttempt);
    return;
  }

  if (outcome.kind === 'policy_blocked') {
    logger.log(`${outcome.detail} (account ${account_id}) — completing stale recompute`);
  }

  // Outside the Stripe try/catch on purpose: a transient Postgres blip here
  // must NOT reach the Stripe classifier (it would mislabel a succeeded
  // operation as terminal and flip the row to 'failed'). Letting it throw
  // fails the job → BullMQ retries → the idempotency keys dedup the Stripe
  // re-run → completion is re-attempted. Convergent either way.
  await markOutboxCompleted(sql, outboxId, outboxAttempt);
}
