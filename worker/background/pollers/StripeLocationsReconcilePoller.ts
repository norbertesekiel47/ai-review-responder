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
//   - Only checks accounts with subscription_status = 'active' or 'past_due'
//   - Skips accounts with no overage item in Stripe (basic tier, legacy)
//   - Uses the stored billing snapshot to determine expected overage/invoice totals
//
// Default cadence: every 60 minutes (3_600_000 ms).
// Override via STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS.
// Set STRIPE_LOCATIONS_RECONCILE_DISABLED=true to skip entirely
// (mock mode does too).

import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { isSubscriptionTier, TIER_CONFIG } from '../../../src/lib/accounts/tier-config';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';
import { Sentry } from '../../sentry';
import {
  compareUpcomingInvoice,
  isExpectedStatusWindow,
  recurringSubscriptionLineTotalCents,
} from './billing-reconciliation/drift';
import { expectedInvoiceForAccount } from './billing-reconciliation/expected-invoice';
import type { BillingReconciliationAccount, DriftFinding } from './billing-reconciliation/types';

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

function extractStripeCustomerId(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): string | null {
  if (typeof customer === 'string') return customer;
  return customer?.id ?? null;
}

function findOverageItem(
  subscription: Stripe.Subscription,
  overagePriceIds: Set<string>,
  expectedOverageUnitPriceCents: number,
): Stripe.SubscriptionItem | undefined {
  const items = subscription.items?.data ?? [];
  return items.find((item) =>
    isOverageItem(item, overagePriceIds, expectedOverageUnitPriceCents, items.length),
  );
}

function isOverageItem(
  item: Stripe.SubscriptionItem,
  overagePriceIds: Set<string>,
  expectedOverageUnitPriceCents: number,
  itemCount: number,
): boolean {
  const price = item.price;
  if (!price) return false;
  if (price.id && overagePriceIds.has(price.id)) return true;

  const priceDescriptor = [
    price.lookup_key,
    price.nickname,
    price.metadata?.billing_role,
    price.metadata?.role,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\b(overage|additional|extra|add-on|addon)\b/.test(priceDescriptor)) {
    return true;
  }

  return itemCount > 1
    && expectedOverageUnitPriceCents > 0
    && price.unit_amount === expectedOverageUnitPriceCents;
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
  locations_overage_price_cents: number;
  active_location_count: number;
  past_due_at: Date | null;
  flags: Record<string, unknown> | null;
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
        a.locations_overage_price_cents,
        a.past_due_at,
        a.flags,
        COUNT(b.id) AS active_location_count
      FROM accounts a
      LEFT JOIN businesses b ON b.account_id = a.id AND b.archived_at IS NULL
      WHERE a.stripe_subscription_id IS NOT NULL
        AND a.subscription_status IN (${SubscriptionStatus.ACTIVE}, ${SubscriptionStatus.PAST_DUE})
      GROUP BY
        a.id,
        a.subscription_tier,
        a.subscription_status,
        a.stripe_subscription_id,
        a.locations_included,
        a.locations_overage_price_cents,
        a.past_due_at,
        a.flags
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
        const activeLocations = Number(account.active_location_count);
        const expectedAccount: BillingReconciliationAccount = {
          ...account,
          active_location_count: activeLocations,
          flags: account.flags ?? {},
        };
        const expectedInvoice = expectedInvoiceForAccount(expectedAccount);

        // Retrieve Stripe subscription
        const subscription = await stripe.subscriptions.retrieve(
          account.stripe_subscription_id,
        );
        const stripeCustomerId = extractStripeCustomerId(subscription.customer);

        if (
          subscription.status !== account.subscription_status
          && !isExpectedStatusWindow(expectedAccount, subscription.status)
        ) {
          emitDriftAlert(account.id, {
            driftType: 'status_mismatch',
            dbExpectedOverage: expectedInvoice.overageUnits,
            stripeOverageQuantity: 0,
            activeLocations,
            locationsIncluded: account.locations_included,
            tier,
            dbStatus: account.subscription_status,
            stripeStatus: subscription.status,
            stripeSubscriptionId: subscription.id,
            stripeCustomerId,
            driftMessage: `Stripe status ${subscription.status} differs from DB status ${account.subscription_status}`,
          });
          driftsFound++;
        }

        const overageItem = findOverageItem(
          subscription,
          overagePriceIds,
          expectedInvoice.overageUnitPriceCents,
        );
        const stripeOverageQuantity = overageItem?.quantity ?? 0;

        // Basic tier has no overage concept
        if (!config.multiLocAllowed || config.overageCents === 0) {
          if (overageItem && (overageItem.quantity ?? 0) > 0) {
            // Basic tier should never have overage items with quantity > 0
            emitDriftAlert(account.id, {
              driftType: 'quantity_mismatch',
              dbExpectedOverage: expectedInvoice.overageUnits,
              stripeOverageQuantity,
              activeLocations,
              locationsIncluded: account.locations_included,
              tier,
              dbStatus: account.subscription_status,
              stripeStatus: subscription.status,
              stripeSubscriptionId: subscription.id,
              stripeCustomerId,
            });
            driftsFound++;
          }
        } else if (stripeOverageQuantity !== expectedInvoice.overageUnits) {
          emitDriftAlert(account.id, {
            driftType: 'quantity_mismatch',
            dbExpectedOverage: expectedInvoice.overageUnits,
            stripeOverageQuantity,
            activeLocations,
            locationsIncluded: account.locations_included,
            tier,
            dbStatus: account.subscription_status,
            stripeStatus: subscription.status,
            stripeSubscriptionId: subscription.id,
            stripeCustomerId,
          });
          driftsFound++;
        }

        accountsChecked++;

        try {
          if (!stripeCustomerId) {
            throw new Error('Stripe subscription is missing a customer ID');
          }

          const upcoming = await stripe.invoices.createPreview({
            customer: stripeCustomerId,
            subscription: account.stripe_subscription_id,
          });
          const actualRecurringCents = recurringSubscriptionLineTotalCents(upcoming);

          if (actualRecurringCents === null) {
            throw new Error('Stripe invoice preview returned no recurring subscription lines');
          }

          for (const drift of compareUpcomingInvoice(account.id, expectedInvoice.totalCents, actualRecurringCents)) {
            emitDriftAlert(account.id, {
              driftType: drift.type,
              dbExpectedOverage: expectedInvoice.overageUnits,
              stripeOverageQuantity,
              activeLocations,
              locationsIncluded: account.locations_included,
              tier,
              expectedCents: drift.expectedCents,
              actualCents: drift.actualCents,
              dbStatus: account.subscription_status,
              stripeStatus: subscription.status,
              stripeSubscriptionId: subscription.id,
              stripeCustomerId,
              driftMessage: drift.message,
            });
            driftsFound++;
          }
        } catch (err) {
          errors++;
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `${LOG_PREFIX} Error reconciling invoice preview for account ${account.id}: ${message}`,
          );
        }
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
  driftType?: DriftFinding['type'];
  dbExpectedOverage: number;
  stripeOverageQuantity: number;
  activeLocations: number;
  locationsIncluded: number;
  tier: string;
  expectedCents?: number;
  actualCents?: number;
  dbStatus?: string;
  stripeStatus?: string;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string | null;
  driftMessage?: string;
}

/**
 * Emits a drift alert. Uses Sentry when SENTRY_DSN is set,
 * falls back to console.warn otherwise.
 */
function emitDriftAlert(
  accountId: string,
  payload: DriftAlertPayload,
): void {
  const message = payload.driftMessage ??
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
        drift_type: payload.driftType ?? 'quantity_mismatch',
      },
      extra: {
        accountId,
        driftMessage: payload.driftMessage,
        dbExpectedOverage: payload.dbExpectedOverage,
        stripeOverageQuantity: payload.stripeOverageQuantity,
        activeLocations: payload.activeLocations,
        locationsIncluded: payload.locationsIncluded,
        tier: payload.tier,
        expectedCents: payload.expectedCents,
        actualCents: payload.actualCents,
        dbStatus: payload.dbStatus,
        stripeStatus: payload.stripeStatus,
        stripeSubscriptionId: payload.stripeSubscriptionId,
        stripeCustomerId: payload.stripeCustomerId,
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
