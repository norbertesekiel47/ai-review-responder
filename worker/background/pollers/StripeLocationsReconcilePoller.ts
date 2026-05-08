// worker/background/pollers/StripeLocationsReconcilePoller.ts
//
// Hourly drift detection: compares actual non-archived location count
// against Stripe subscription_items[overage].quantity. Drift > 0
// emits Sentry alert (or console.warn when SENTRY_DSN unset).
//
// Does NOT auto-correct — manual investigation only.
//
// Scope conditions:
//   - Only checks accounts with stripe_subscription_id IS NOT NULL
//   - Only checks accounts with subscription_status = 'active'
//   - Skips accounts with no overage item in Stripe (basic tier, legacy)
//   - Uses computeOverageQuantity to determine expected overage from DB
//
// Default cadence: every 60 minutes (3_600_000 ms).
// Override via STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS.
// Set STRIPE_LOCATIONS_RECONCILE_DISABLED=true to skip entirely
// (mock mode does too).

import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { computeOverageQuantity } from '../../../src/lib/accounts/quota';
import { isSubscriptionTier, TIER_CONFIG, type SubscriptionTierValue } from '../../../src/lib/accounts/tier-config';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { Sentry } from '../../sentry';

const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour
const LOG_PREFIX = '[StripeLocationsReconcilePoller]';

let timer: ReturnType<typeof setInterval> | null = null;
// Single-flight guard. Same pattern as EmailChannelReconcilePoller —
// prevents two scheduled ticks from running concurrently.
let inProgress = false;

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

// Overage price IDs — used to identify the overage subscription item
function getOveragePriceIds(): Set<string> {
  return new Set([
    process.env.STRIPE_PRICE_STANDARD_OVERAGE ?? '',
    process.env.STRIPE_PRICE_PREMIUM_OVERAGE ?? '',
    process.env.STRIPE_PRICE_FOUNDERS_OVERAGE ?? '',
  ].filter(Boolean));
}

interface ReconcileResult {
  accountsChecked: number;
  driftsFound: number;
  errors: number;
}

interface AccountWithLocations {
  id: string;
  subscription_tier: string;
  subscription_status: string;
  stripe_subscription_id: string;
  locations_included: number;
  active_location_count: number;
}

/**
 * Runs one reconciliation cycle. For each active account with a Stripe
 * subscription, compares the expected overage quantity (from DB) with
 * the actual overage quantity (from Stripe). Emits alert on drift.
 */
export async function runOnce(): Promise<ReconcileResult> {
  if (inProgress) {
    console.log(`${LOG_PREFIX} Previous run still in progress — skipping this tick`);
    return { accountsChecked: 0, driftsFound: 0, errors: 0 };
  }
  inProgress = true;

  try {
    // Fetch all active accounts with Stripe subscriptions and their
    // active location counts in a single query.
    const accounts = await sql<AccountWithLocations[]>`
      SELECT
        a.id,
        a.subscription_tier,
        a.subscription_status,
        a.stripe_subscription_id,
        a.locations_included,
        COUNT(b.id) AS active_location_count
      FROM accounts a
      LEFT JOIN businesses b ON b.account_id = a.id AND b.archived_at IS NULL
      WHERE a.stripe_subscription_id IS NOT NULL
        AND a.subscription_status = ${SubscriptionStatus.ACTIVE}
      GROUP BY a.id
    `;

    if (accounts.length === 0) {
      console.log(`${LOG_PREFIX} No active accounts with Stripe subscriptions to reconcile`);
      return { accountsChecked: 0, driftsFound: 0, errors: 0 };
    }

    const overagePriceIds = getOveragePriceIds();
    const stripe = getStripe();

    let accountsChecked = 0;
    let driftsFound = 0;
    let errors = 0;

    for (const account of accounts) {
      try {
        const tier = account.subscription_tier;
        if (!isSubscriptionTier(tier)) {
          console.error(`${LOG_PREFIX} Unknown tier ${tier} for account ${account.id} — skipping`);
          errors++;
          continue;
        }

        const config = TIER_CONFIG[tier];

        // Basic tier has no overage concept
        if (!config.multiLocAllowed || config.overageCents === 0) {
          // For basic tier, check that there's no unexpected overage item
          const subscription = await stripe.subscriptions.retrieve(
            account.stripe_subscription_id,
          );

          const overageItem = subscription.items.data.find(
            (item) => item.price?.id && overagePriceIds.has(item.price.id),
          );

          if (overageItem && (overageItem.quantity ?? 0) > 0) {
            // Basic tier should never have overage items with quantity > 0
            emitDriftAlert(account.id, {
              dbExpectedOverage: 0,
              stripeOverageQuantity: overageItem.quantity ?? 0,
              activeLocations: Number(account.active_location_count),
              locationsIncluded: account.locations_included,
              tier,
            });
            driftsFound++;
          }

          accountsChecked++;
          continue;
        }

        // Compute expected overage from DB
        const activeLocations = Number(account.active_location_count);
        const dbExpectedOverage = computeOverageQuantity(activeLocations, config.included);

        // Retrieve Stripe subscription
        const subscription = await stripe.subscriptions.retrieve(
          account.stripe_subscription_id,
        );

        // Find overage item in subscription
        const overageItem = subscription.items.data.find(
          (item) => item.price?.id && overagePriceIds.has(item.price.id),
        );

        const stripeOverageQuantity = overageItem?.quantity ?? 0;

        // Compare
        if (stripeOverageQuantity !== dbExpectedOverage) {
          emitDriftAlert(account.id, {
            dbExpectedOverage,
            stripeOverageQuantity,
            activeLocations,
            locationsIncluded: account.locations_included,
            tier,
          });
          driftsFound++;
        }

        accountsChecked++;
      } catch (err) {
        errors++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `${LOG_PREFIX} Error reconciling account ${account.id}: ${message}`,
        );
      }
    }

    if (driftsFound > 0 || errors > 0) {
      console.log(
        `${LOG_PREFIX} Run complete: accountsChecked=${accountsChecked} driftsFound=${driftsFound} errors=${errors}`,
      );
    } else {
      console.log(
        `${LOG_PREFIX} Run complete: ${accountsChecked} accounts checked, no drift detected`,
      );
    }

    return { accountsChecked, driftsFound, errors };
  } finally {
    inProgress = false;
  }
}

interface DriftAlertPayload {
  dbExpectedOverage: number;
  stripeOverageQuantity: number;
  activeLocations: number;
  locationsIncluded: number;
  tier: string;
}

/**
 * Emits a drift alert. Uses Sentry when SENTRY_DSN is set,
 * falls back to console.warn otherwise.
 */
function emitDriftAlert(
  accountId: string,
  payload: DriftAlertPayload,
): void {
  const message =
    `Stripe location drift detected for account ${accountId}: ` +
    `expected_overage=${payload.dbExpectedOverage} (from DB: ${payload.activeLocations} active - ${payload.locationsIncluded} included), ` +
    `stripe_overage=${payload.stripeOverageQuantity}, ` +
    `tier=${payload.tier}`;

  if (process.env.SENTRY_DSN) {
    Sentry.captureMessage(message, {
      level: 'warning',
      tags: {
        feature: 'stripe_reconciliation',
        account_id: accountId,
        drift_type: payload.stripeOverageQuantity > payload.dbExpectedOverage ? 'stripe_over' : 'stripe_under',
      },
      extra: {
        accountId,
        dbExpectedOverage: payload.dbExpectedOverage,
        stripeOverageQuantity: payload.stripeOverageQuantity,
        activeLocations: payload.activeLocations,
        locationsIncluded: payload.locationsIncluded,
        tier: payload.tier,
      },
    });
  } else {
    console.warn(`${LOG_PREFIX} ${message}`);
  }
}

/**
 * Starts the hourly reconciliation poller.
 */
export function startStripeLocationsReconcilePoller(): void {
  if (process.env.STRIPE_LOCATIONS_RECONCILE_DISABLED === 'true') {
    console.log(
      `${LOG_PREFIX} STRIPE_LOCATIONS_RECONCILE_DISABLED=true — not starting`,
    );
    return;
  }
  if (process.env.MOCK_EXTERNAL_APIS === 'true') {
    console.log(
      `${LOG_PREFIX} MOCK_EXTERNAL_APIS=true — not starting`,
    );
    return;
  }

  // Idempotent start
  if (timer !== null) {
    console.log(
      `${LOG_PREFIX} Already started — ignoring duplicate startStripeLocationsReconcilePoller() call`,
    );
    return;
  }

  const envInterval = process.env.STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS;
  const parsed = envInterval ? parseInt(envInterval, 10) : NaN;
  const interval =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;

  console.log(`${LOG_PREFIX} Starting (interval=${interval}ms)`);
  runOnce().catch((err) =>
    console.error(`${LOG_PREFIX} Initial run failed:`, err),
  );
  timer = setInterval(() => {
    runOnce().catch((err) =>
      console.error(`${LOG_PREFIX} Scheduled run failed:`, err),
    );
  }, interval);
}

/**
 * Stops the reconciliation poller.
 */
export function stopStripeLocationsReconcilePoller(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
  // Do NOT reset inProgress. If stop() fires mid-runOnce (graceful
  // shutdown), the in-flight run's finally{} clears the flag itself.
  // Same pattern as EmailChannelReconcilePoller.
}
