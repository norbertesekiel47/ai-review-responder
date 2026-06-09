// worker/background/pollers/StripeLocationsReconcilePoller.ts
//
// Hourly drift detection: compares actual non-archived location count
// against Stripe subscription_items[overage].quantity. Drift > 0
// emits Sentry alert (or console.warn when SENTRY_DSN unset).
//
// Does NOT auto-correct — manual investigation only.
//
// Scope conditions:
//   - Checks paid accounts whether stripe_subscription_id is present or missing
//   - Only checks accounts with subscription_status = 'active' or 'past_due'
//   - Skips accounts with no overage item in Stripe (basic tier, legacy)
//   - Uses the stored billing snapshot to determine expected overage/invoice totals
//
// Default cadence: every 60 minutes (3_600_000 ms).
// Override via STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS.
// Set STRIPE_LOCATIONS_RECONCILE_DISABLED=true to skip entirely
// (mock mode does too).
//
// Per-account reconciliation lives in billing-reconciliation/reconcile-account.ts;
// this file owns orchestration (query, single-flight, alert emission, tally) and
// the poller lifecycle.

import { getStripe } from '../../../src/lib/payments/stripe-client';
import { sql } from '../../../src/lib/db/server';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { overagePriceIdSet } from '../../../src/lib/payments/price-tier-map';
import { emitDriftAlert } from './billing-reconciliation/drift-alert';
import { reconcileAccount } from './billing-reconciliation/reconcile-account';
import { LOG_PREFIX } from './billing-reconciliation/constants';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import type { AccountWithLocations } from './billing-reconciliation/types';

const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour
const logger = createWorkerLogger(LOG_PREFIX);

let timer: ReturnType<typeof setInterval> | null = null;
// Single-flight guard. Same pattern as EmailChannelReconcilePoller —
// prevents two scheduled ticks from running concurrently.
let inProgress = false;

interface ReconcileResult {
  accountsChecked: number;
  driftsFound: number;
  errors: number;
}

/**
 * Runs one reconciliation cycle. For each active account with a Stripe
 * subscription, compares the expected overage quantity (from DB) with
 * the actual overage quantity (from Stripe). Emits alert on drift.
 */
export async function runOnce(): Promise<ReconcileResult> {
  if (inProgress) {
    logger.log('Previous run still in progress — skipping this tick');
    return { accountsChecked: 0, driftsFound: 0, errors: 0 };
  }
  inProgress = true;

  try {
    // Fetch all active paid accounts and their
    // active location counts in a single query.
    const accounts = await sql<AccountWithLocations[]>`
      SELECT
        a.id,
        a.subscription_tier,
        a.subscription_status,
        a.stripe_customer_id,
        a.stripe_subscription_id,
        a.locations_included,
        a.locations_overage_price_cents,
        a.base_price_cents,
        a.past_due_at,
        a.flags,
        COUNT(b.id) AS active_location_count
      FROM accounts a
      LEFT JOIN businesses b ON b.account_id = a.id AND b.archived_at IS NULL
      WHERE a.subscription_status IN (${SubscriptionStatus.ACTIVE}, ${SubscriptionStatus.PAST_DUE})
      GROUP BY
        a.id,
        a.subscription_tier,
        a.subscription_status,
        a.stripe_customer_id,
        a.stripe_subscription_id,
        a.locations_included,
        a.locations_overage_price_cents,
        a.base_price_cents,
        a.past_due_at,
        a.flags
    `;

    if (accounts.length === 0) {
      logger.log('No paid accounts to reconcile');
      return { accountsChecked: 0, driftsFound: 0, errors: 0 };
    }

    const overagePriceIds = overagePriceIdSet();
    const stripe = getStripe();

    let accountsChecked = 0;
    let driftsFound = 0;
    let errors = 0;

    for (const account of accounts) {
      try {
        const outcome = await reconcileAccount(stripe, account, overagePriceIds);
        accountsChecked += outcome.accountsChecked;
        errors += outcome.errors;
        for (const payload of outcome.drifts) {
          emitDriftAlert(account.id, payload);
          driftsFound++;
        }
      } catch (err) {
        errors++;
        logger.error(`Error reconciling account ${account.id}`, err);
      }
    }

    if (driftsFound > 0 || errors > 0) {
      logger.log(`Run complete: accountsChecked=${accountsChecked} driftsFound=${driftsFound} errors=${errors}`);
    } else {
      logger.log(`Run complete: ${accountsChecked} accounts checked, no drift detected`);
    }

    return { accountsChecked, driftsFound, errors };
  } finally {
    inProgress = false;
  }
}

/**
 * Starts the hourly reconciliation poller.
 */
export function startStripeLocationsReconcilePoller(): void {
  if (process.env.STRIPE_LOCATIONS_RECONCILE_DISABLED === 'true') {
    logger.log('STRIPE_LOCATIONS_RECONCILE_DISABLED=true — not starting');
    return;
  }
  if (process.env.MOCK_EXTERNAL_APIS === 'true') {
    logger.log('MOCK_EXTERNAL_APIS=true — not starting');
    return;
  }

  // Idempotent start
  if (timer !== null) {
    logger.log('Already started — ignoring duplicate startStripeLocationsReconcilePoller() call');
    return;
  }

  const envInterval = process.env.STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS;
  const parsed = envInterval ? parseInt(envInterval, 10) : NaN;
  const interval =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;

  logger.log(`Starting (interval=${interval}ms)`);
  runOnce().catch((err) => logger.error('Initial run failed', err));
  timer = setInterval(() => {
    runOnce().catch((err) => logger.error('Scheduled run failed', err));
  }, interval);
}

/**
 * Stops the reconciliation poller.
 */
export function stopStripeLocationsReconcilePoller(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
    logger.log('Stopped');
  }
  // Do NOT reset inProgress. If stop() fires mid-runOnce (graceful
  // shutdown), the in-flight run's finally{} clears the flag itself.
  // Same pattern as EmailChannelReconcilePoller.
}
