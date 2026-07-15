import type Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import {
  SubscriptionTier,
  isPriceVariant,
  isWs8SubscriptionTier,
  type PriceVariant,
  type Ws8SubscriptionTier,
} from '../../../src/lib/accounts/tier-config';
import { acquireTierBillingActivationLocks } from '../../../src/lib/accounts/billing-locks';
import {
  synchronizeBusinessTierMirror,
  writeResolvedTierSnapshot,
} from '../../../src/lib/accounts/tier-snapshot';
import {
  basePriceInfoForId,
  overagePriceInfoForId,
} from '../../../src/lib/payments/price-tier-map';
import { resolveOverageItem } from '../../../src/lib/payments/overage-item';
import { autopilotPurchasable } from '../../../src/lib/payments/tier-purchasability';
import { reportCaughtError } from '../../../src/lib/shared/report-caught-error';
import {
  LOG_PREFIX,
  extractCustomerId,
  extractSubscriptionId,
  UUID_RE,
  resumePrimaryBusinessBackfill,
  getStripe,
} from './shared';
import {
  applyStripeSubscriptionStateUnderEntitlementLock,
  synchronizeDeferredBusinessSubscriptionState,
  type TransitionResult,
} from './apply-subscription-state';

interface CheckoutAccountRow {
  id: string;
  subscription_tier: string;
  price_variant: string;
  base_price_cents: number;
  locations_paid: number;
  locations_overage_price_cents: number;
  locations_included: number;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
}

interface OperationalAlert {
  accountId: string;
  subscriptionId: string;
  reason:
    | 'account_missing'
    | 'customer_mismatch'
    | 'bound_subscription_mismatch'
    | 'bound_customer_mismatch'
    | 'invalid_trial'
    | 'unmapped_base_price'
    | 'variant_or_tier_mismatch'
    | 'untrusted_overage_item'
    | 'cross_tier_overage_price'
    | 'autopilot_activated_while_unavailable';
  priceId?: string;
}

interface CheckoutProjection {
  transition: TransitionResult | null;
  /** True only when this invocation reached the complete billing-snapshot write. */
  tierProjected: boolean;
  alerts: OperationalAlert[];
}

function reportOperationalAlert(alert: OperationalAlert): void {
  reportCaughtError(
    'ingress/stripe/checkout-completed',
    new Error(`Checkout projection requires operator attention: ${alert.reason}`),
    { ...alert },
  );
}

/**
 * Projects provider-current Checkout state under the fixed account lock graph.
 * Status ownership remains exclusively in applyStripeSubscriptionState; this
 * handler only applies the complete tier snapshot after Price/variant checks.
 */
async function projectCheckoutSubscription(
  accountId: string,
  sessionCustomerId: string | null,
  subscriptionId: string,
): Promise<CheckoutProjection> {
  return sql.begin(async (tx) => {
    await acquireTierBillingActivationLocks(tx, accountId, accountId);

    // This bounded shared-client call happens after advisory serialization but
    // before the account row lock. A retrieval failure aborts with zero writes.
    const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
    const providerCustomerId = extractCustomerId(subscription.customer);
    if (
      sessionCustomerId &&
      providerCustomerId &&
      sessionCustomerId !== providerCustomerId
    ) {
      return {
        transition: null,
        tierProjected: false,
        alerts: [{ accountId, subscriptionId, reason: 'customer_mismatch' }],
      };
    }

    if (
      subscription.status === 'trialing' &&
      (typeof subscription.trial_end !== 'number' ||
        subscription.trial_end <= Math.floor(Date.now() / 1000))
    ) {
      return {
        transition: null,
        tierProjected: false,
        alerts: [{ accountId, subscriptionId, reason: 'invalid_trial' }],
      };
    }

    const [account] = await tx<CheckoutAccountRow[]>`
      SELECT
        id,
        subscription_tier,
        price_variant,
        base_price_cents,
        locations_paid,
        locations_overage_price_cents,
        locations_included,
        stripe_subscription_id,
        stripe_customer_id
      FROM accounts
      WHERE id = ${accountId}::uuid
      FOR UPDATE
    `;
    if (!account) {
      return {
        transition: null,
        tierProjected: false,
        alerts: [{ accountId, subscriptionId, reason: 'account_missing' }],
      };
    }

    if (
      account.stripe_subscription_id !== null &&
      account.stripe_subscription_id !== subscription.id
    ) {
      return {
        transition: null,
        tierProjected: false,
        alerts: [
          {
            accountId,
            subscriptionId,
            reason: 'bound_subscription_mismatch',
          },
        ],
      };
    }
    if (
      account.stripe_customer_id !== null &&
      account.stripe_customer_id !== providerCustomerId
    ) {
      return {
        transition: null,
        tierProjected: false,
        alerts: [
          {
            accountId,
            subscriptionId,
            reason: 'bound_customer_mismatch',
          },
        ],
      };
    }

    const transition = await applyStripeSubscriptionStateUnderEntitlementLock(
      tx,
      { mode: 'checkout', accountId },
      subscription,
    );

    const items = subscription.items?.data ?? [];
    const mappedBaseItems = items.flatMap((item) => {
      const info = basePriceInfoForId(item.price?.id);
      return info ? [{ item, info }] : [];
    });
    const base = mappedBaseItems.length === 1 ? mappedBaseItems[0] : undefined;
    if (!base) {
      return {
        transition,
        tierProjected: false,
        alerts: [
          {
            accountId,
            subscriptionId,
            reason: 'unmapped_base_price',
            priceId: items[0]?.price?.id,
          },
        ],
      };
    }

    if (
      !isWs8SubscriptionTier(account.subscription_tier) ||
      !isPriceVariant(account.price_variant) ||
      base.info.tier !== account.subscription_tier ||
      base.info.variant !== account.price_variant
    ) {
      return {
        transition,
        tierProjected: false,
        alerts: [
          {
            accountId,
            subscriptionId,
            reason: 'variant_or_tier_mismatch',
            priceId: base.item.price.id,
          },
        ],
      };
    }

    const overage = resolveOverageItem(items, {
      storedOveragePriceCents: Number(account.locations_overage_price_cents),
    });
    if (overage.kind === 'untrusted') {
      return {
        transition,
        tierProjected: false,
        alerts: [
          {
            accountId,
            subscriptionId,
            reason: 'untrusted_overage_item',
            priceId: overage.item.price.id,
          },
        ],
      };
    }

    let locationsPaid = 0;
    if (overage.kind === 'trusted') {
      const mappedOverage = overagePriceInfoForId(overage.item.price.id);
      if (mappedOverage && mappedOverage.tier !== account.subscription_tier) {
        return {
          transition,
          tierProjected: false,
          alerts: [
            {
              accountId,
              subscriptionId,
              reason: 'cross_tier_overage_price',
              priceId: overage.item.price.id,
            },
          ],
        };
      }
      locationsPaid = overage.item.quantity ?? 0;
    }

    const tier = account.subscription_tier as Ws8SubscriptionTier;
    const variant = account.price_variant as PriceVariant;
    await writeResolvedTierSnapshot(tx, {
      accountId,
      snapshot: {
        tier,
        variant,
        baseCents: Number(account.base_price_cents),
        overageCents: Number(account.locations_overage_price_cents),
        included: Number(account.locations_included),
      },
      locationsPaid,
      audit: {
        eventType: 'subscription_updated',
        payload: {
          source: 'checkout_completed',
          stripe_subscription_id: subscriptionId,
        },
      },
    });

    const alerts: OperationalAlert[] = [];
    if (tier === SubscriptionTier.AUTOPILOT && !autopilotPurchasable()) {
      alerts.push({
        accountId,
        subscriptionId,
        reason: 'autopilot_activated_while_unavailable',
        priceId: base.item.price.id,
      });
    }
    return { transition, tierProjected: true, alerts };
  });
}

export async function processCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const refId = session.client_reference_id ?? session.metadata?.business_id;
  if (!refId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed missing client_reference_id — skipping`);
    return;
  }
  if (!UUID_RE.test(refId)) {
    console.warn(
      `${LOG_PREFIX} checkout.session.completed has malformed ref_id=${JSON.stringify(refId)} — skipping (Stripe will not retry; inbound_events marked processed)`,
    );
    return;
  }
  if (session.mode !== 'subscription') {
    console.warn(`${LOG_PREFIX} checkout.session.completed mode=${session.mode} (not subscription) — skipping activation`);
    return;
  }
  if (
    session.payment_status !== 'paid' &&
    session.payment_status !== 'no_payment_required'
  ) {
    console.warn(`${LOG_PREFIX} checkout.session.completed payment_status=${session.payment_status} (not paid/no_payment_required) — skipping activation for ref ${refId}`);
    return;
  }

  const subscriptionId = extractSubscriptionId(session.subscription);
  if (!subscriptionId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed for ref ${refId} has no subscription id — skipping activation`);
    return;
  }

  let accountId: string | null = null;
  let businessId: string | null = null;
  const [accountLookup] = await sql<{ id: string }[]>`
    SELECT id FROM accounts WHERE id = ${refId}::uuid
  `;
  if (accountLookup) {
    accountId = accountLookup.id;
  } else {
    const [bizLookup] = await sql<{ account_id: string }[]>`
      SELECT account_id FROM businesses WHERE id = ${refId}::uuid
    `;
    if (bizLookup) {
      accountId = bizLookup.account_id;
      businessId = refId;
    }
  }
  if (!accountId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed ref_id=${refId} matches neither account nor business — skipping`);
    return;
  }

  const projection = await projectCheckoutSubscription(
    accountId,
    extractCustomerId(session.customer),
    subscriptionId,
  );
  if (projection.tierProjected) {
    await synchronizeBusinessTierMirror(sql, accountId);
  }
  if (projection.transition?.accountResolved) {
    await synchronizeDeferredBusinessSubscriptionState(sql, accountId);
  }
  for (const alert of projection.alerts) reportOperationalAlert(alert);

  if (projection.transition?.changed && projection.transition.activated) {
    await resumePrimaryBusinessBackfill(
      businessId ?? projection.transition.primaryBusinessId,
    );
  }
}
