import { captureMessage } from '@sentry/node';
import type Stripe from 'stripe';
import type { TransitionResult } from './apply-subscription-state';
import { sql } from '../../../src/lib/db/server';
import {
  SubscriptionTier,
  isPriceVariant,
  type PriceVariant,
  type ResolvedTierSnapshot,
  type Ws8SubscriptionTier,
} from '../../../src/lib/accounts/tier-config';
import { acquireTierAndBillingLocks } from '../../../src/lib/accounts/billing-locks';
import {
  writeResolvedTierSnapshot,
  writeTierSnapshot,
} from '../../../src/lib/accounts/tier-snapshot';
import {
  overagePriceInfoForId,
} from '../../../src/lib/payments/price-tier-map';
import { resolveSubscriptionBilling } from '../../../src/lib/payments/overage-item';
import { autopilotPurchasable } from '../../../src/lib/payments/tier-purchasability';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { subscriptionGrantsFullAccess } from '../../../src/lib/shared/subscription-status';
import {
  LOG_PREFIX,
  extractCustomerId,
  AccountNotProvisionedYetError,
  getStripe,
} from './shared';
import { applyStripeSubscriptionState } from './apply-subscription-state';

const logger = createWorkerLogger('[ingress/stripe/subscription-updated]');

interface AccountReference {
  id: string;
  stripe_subscription_id: string | null;
  active_offboarding_subscription_id: string | null;
}

interface LockedAccountRow {
  id: string;
  subscription_tier: string;
  subscription_status: string;
  price_variant: string;
  base_price_cents: number;
  locations_paid: number;
  locations_overage_price_cents: number;
  locations_included: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

export type SubscriptionUpdateAlertReason =
  | 'unmapped_base_price'
  | 'variant_mismatch'
  | 'invalid_stored_variant'
  | 'untrusted_overage_item'
  | 'cross_tier_overage_price'
  | 'invalid_overage_quantity'
  | 'autopilot_activated_while_unavailable';

export interface SubscriptionUpdateOperationalAlert {
  reason: SubscriptionUpdateAlertReason;
  accountId: string;
  subscriptionId: string;
  priceId?: string;
  mappedTier?: Ws8SubscriptionTier;
  mappedVariant?: PriceVariant;
  storedVariant?: string;
}

interface SubscriptionUpdateOutcomeBase {
  accountId: string | null;
  subscriptionId: string;
  transition: TransitionResult | null;
  alerts: SubscriptionUpdateOperationalAlert[];
}

export type SubscriptionUpdatedOutcome =
  | (SubscriptionUpdateOutcomeBase & {
      kind: 'updated';
      accountId: string;
      tier: Ws8SubscriptionTier;
      variant: PriceVariant;
      snapshotChanged: boolean;
    })
  | (SubscriptionUpdateOutcomeBase & {
      kind: 'variant_mismatch';
      accountId: string;
      priceId: string;
      mappedTier: Ws8SubscriptionTier;
      mappedVariant: PriceVariant;
      storedVariant: string;
    })
  | (SubscriptionUpdateOutcomeBase & {
      kind: 'status_only';
      accountId: string;
      reason: Exclude<
        SubscriptionUpdateAlertReason,
        'variant_mismatch' | 'autopilot_activated_while_unavailable'
      >;
    })
  | (SubscriptionUpdateOutcomeBase & {
      kind: 'ignored';
      reason:
        | 'missing_subscription_id'
        | 'missing_customer_id'
        | 'stale_subscription'
        | 'active_offboarding_subscription'
        | 'account_disappeared'
        | 'provider_customer_mismatch';
    });

function ignoredOutcome(
  subscriptionId: string,
  reason: Extract<SubscriptionUpdatedOutcome, { kind: 'ignored' }>['reason'],
  accountId: string | null = null,
): SubscriptionUpdatedOutcome {
  return {
    kind: 'ignored',
    accountId,
    subscriptionId,
    reason,
    transition: null,
    alerts: [],
  };
}

/**
 * A handled projection warning is emitted only after the status/snapshot
 * transaction commits. The payload is deliberately narrow: no customer,
 * event, metadata, request, or subscription object reaches logs or Sentry.
 */
function reportOperationalAlert(alert: SubscriptionUpdateOperationalAlert): void {
  const safeContext = {
    account_id: alert.accountId,
    subscription_id: alert.subscriptionId,
    price_id: alert.priceId,
    mapped_tier: alert.mappedTier,
    mapped_variant: alert.mappedVariant,
    stored_variant: alert.storedVariant,
    reason: alert.reason,
  };
  try {
    captureMessage(`stripe_subscription_projection_${alert.reason}`, {
      level: 'error',
      tags: {
        feature: 'stripe_subscription_projection',
        reason: alert.reason,
        account_id: alert.accountId,
      },
      extra: safeContext,
    });
  } catch {
    // Observability is best-effort after the committed Stripe projection.
  }
  try {
    logger.error('Stripe subscription projection requires operator attention', safeContext);
  } catch {
    // Structured logging is also best-effort after commit.
  }
}

async function resolveAccountReference(
  customerId: string,
  subscriptionId: string,
): Promise<AccountReference | null> {
  const [reference] = await sql<AccountReference[]>`
    WITH account_candidates AS (
      SELECT
        a.id,
        a.stripe_subscription_id,
        NULL::text AS active_offboarding_subscription_id,
        0 AS resolution_priority
      FROM accounts a
      WHERE a.stripe_customer_id = ${customerId}
        AND a.stripe_subscription_id = ${subscriptionId}

      UNION ALL

      SELECT
        a.id,
        a.stripe_subscription_id,
        ao.stripe_subscription_id AS active_offboarding_subscription_id,
        1 AS resolution_priority
      FROM accounts a
      JOIN account_offboardings ao
        ON ao.account_id = a.id
       AND ao.stripe_subscription_id = ${subscriptionId}
       AND ao.terminal_at IS NULL
      WHERE a.stripe_customer_id = ${customerId}

      UNION ALL

      SELECT
        a.id,
        a.stripe_subscription_id,
        NULL::text AS active_offboarding_subscription_id,
        2 AS resolution_priority
      FROM accounts a
      WHERE a.stripe_customer_id = ${customerId}
        AND a.stripe_subscription_id IS DISTINCT FROM ${subscriptionId}
        AND NOT EXISTS (
          SELECT 1
          FROM account_offboardings ao
          WHERE ao.account_id = a.id
            AND ao.stripe_subscription_id = ${subscriptionId}
            AND ao.terminal_at IS NULL
        )
    )
    SELECT
      id,
      stripe_subscription_id,
      active_offboarding_subscription_id
    FROM account_candidates
    ORDER BY resolution_priority ASC, id ASC
    LIMIT 1
  `;
  return reference ?? null;
}

function storedSnapshot(account: LockedAccountRow): ResolvedTierSnapshot {
  if (!isPriceVariant(account.price_variant)) {
    throw new Error('storedSnapshot requires a validated price_variant');
  }
  return {
    tier: account.subscription_tier as Ws8SubscriptionTier,
    variant: account.price_variant,
    baseCents: Number(account.base_price_cents),
    overageCents: Number(account.locations_overage_price_cents),
    included: Number(account.locations_included),
  };
}

async function projectProviderCurrentSubscription(
  reference: AccountReference,
  customerId: string,
  subscriptionId: string,
): Promise<SubscriptionUpdatedOutcome> {
  const accountId = reference.id;
  return sql.begin(async (tx) => {
    // Fixed tier/webhook order. No account row is held while either advisory
    // lock is acquired or while provider-current Stripe state is retrieved.
    await acquireTierAndBillingLocks(tx, accountId);
    const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
    const providerCustomerId = extractCustomerId(subscription.customer);

    const [account] = await tx<LockedAccountRow[]>`
      SELECT
        a.id,
        a.subscription_tier,
        a.subscription_status,
        a.price_variant,
        a.base_price_cents,
        a.locations_paid,
        a.locations_overage_price_cents,
        a.locations_included,
        a.stripe_customer_id,
        a.stripe_subscription_id
      FROM accounts a
      WHERE a.id = ${accountId}::uuid
      FOR UPDATE
    `;

    if (!account) {
      return ignoredOutcome(subscriptionId, 'account_disappeared', accountId);
    }
    if (
      providerCustomerId !== customerId ||
      account.stripe_customer_id !== customerId
    ) {
      return ignoredOutcome(subscriptionId, 'provider_customer_mismatch', account.id);
    }
    if (account.stripe_subscription_id !== subscriptionId) {
      return ignoredOutcome(subscriptionId, 'stale_subscription', account.id);
    }

    // Absolute status ownership: every provider-current subscription status,
    // including unknown Price and variant-mismatch paths, enters through the
    // one Stripe status applier.
    const transition = await applyStripeSubscriptionState(
      tx,
      {
        mode: 'subscription',
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
      },
      subscription,
    );

    const billing = resolveSubscriptionBilling(subscription.items?.data ?? [], {
      storedOveragePriceCents: Number(account.locations_overage_price_cents),
    });
    const base = billing.base;
    if (!base || base.tier === null) {
      const priceId = base?.item.price?.id;
      const alert: SubscriptionUpdateOperationalAlert = {
        reason: 'unmapped_base_price',
        accountId: account.id,
        subscriptionId,
        priceId,
        storedVariant: account.price_variant,
      };
      return {
        kind: 'status_only',
        accountId: account.id,
        subscriptionId,
        reason: 'unmapped_base_price',
        transition,
        alerts: [alert],
      };
    }

    if (!isPriceVariant(account.price_variant)) {
      const alert: SubscriptionUpdateOperationalAlert = {
        reason: 'invalid_stored_variant',
        accountId: account.id,
        subscriptionId,
        priceId: base.item.price.id,
        mappedTier: base.tier,
        mappedVariant: base.variant,
        storedVariant: account.price_variant,
      };
      return {
        kind: 'status_only',
        accountId: account.id,
        subscriptionId,
        reason: 'invalid_stored_variant',
        transition,
        alerts: [alert],
      };
    }

    if (base.variant !== account.price_variant) {
      const alert: SubscriptionUpdateOperationalAlert = {
        reason: 'variant_mismatch',
        accountId: account.id,
        subscriptionId,
        priceId: base.item.price.id,
        mappedTier: base.tier,
        mappedVariant: base.variant,
        storedVariant: account.price_variant,
      };
      return {
        kind: 'variant_mismatch',
        accountId: account.id,
        subscriptionId,
        priceId: base.item.price.id,
        mappedTier: base.tier,
        mappedVariant: base.variant,
        storedVariant: account.price_variant,
        transition,
        alerts: [alert],
      };
    }

    const overage = billing.overage;
    if (overage.kind === 'untrusted') {
      const alert: SubscriptionUpdateOperationalAlert = {
        reason: 'untrusted_overage_item',
        accountId: account.id,
        subscriptionId,
        priceId: overage.item.price.id,
        mappedTier: base.tier,
        mappedVariant: base.variant,
        storedVariant: account.price_variant,
      };
      return {
        kind: 'status_only',
        accountId: account.id,
        subscriptionId,
        reason: 'untrusted_overage_item',
        transition,
        alerts: [alert],
      };
    }

    if (overage.kind === 'trusted') {
      const mappedOverage = overagePriceInfoForId(overage.item.price.id);
      if (mappedOverage && mappedOverage.tier !== base.tier) {
        const alert: SubscriptionUpdateOperationalAlert = {
          reason: 'cross_tier_overage_price',
          accountId: account.id,
          subscriptionId,
          priceId: overage.item.price.id,
          mappedTier: base.tier,
          mappedVariant: base.variant,
          storedVariant: account.price_variant,
        };
        return {
          kind: 'status_only',
          accountId: account.id,
          subscriptionId,
          reason: 'cross_tier_overage_price',
          transition,
          alerts: [alert],
        };
      }
    }

    const locationsPaid = overage.kind === 'trusted'
      ? (overage.item.quantity ?? 0)
      : 0;
    if (!Number.isSafeInteger(locationsPaid) || locationsPaid < 0) {
      const alert: SubscriptionUpdateOperationalAlert = {
        reason: 'invalid_overage_quantity',
        accountId: account.id,
        subscriptionId,
        priceId: overage.kind === 'trusted' ? overage.item.price.id : undefined,
        mappedTier: base.tier,
        mappedVariant: base.variant,
        storedVariant: account.price_variant,
      };
      return {
        kind: 'status_only',
        accountId: account.id,
        subscriptionId,
        reason: 'invalid_overage_quantity',
        transition,
        alerts: [alert],
      };
    }

    const snapshotResult = account.subscription_tier === base.tier
      ? await writeResolvedTierSnapshot(tx, {
          accountId: account.id,
          snapshot: storedSnapshot(account),
          locationsPaid,
          audit: {
            eventType: 'subscription_updated',
            payload: {
              source: 'provider_current_subscription',
              stripe_subscription_id: subscriptionId,
            },
          },
        })
      : await writeTierSnapshot(tx, {
          accountId: account.id,
          tier: base.tier,
          variant: account.price_variant,
          locationsPaid,
          audit: {
            eventType: 'subscription_updated',
            payload: {
              source: 'provider_current_subscription',
              previous_tier: account.subscription_tier,
              stripe_subscription_id: subscriptionId,
            },
          },
        });

    const alerts: SubscriptionUpdateOperationalAlert[] = [];
    if (
      base.tier === SubscriptionTier.AUTOPILOT &&
      subscriptionGrantsFullAccess(subscription.status) &&
      !autopilotPurchasable()
    ) {
      alerts.push({
        reason: 'autopilot_activated_while_unavailable',
        accountId: account.id,
        subscriptionId,
        priceId: base.item.price.id,
        mappedTier: base.tier,
        mappedVariant: base.variant,
        storedVariant: account.price_variant,
      });
    }

    return {
      kind: 'updated',
      accountId: account.id,
      subscriptionId,
      tier: base.tier,
      variant: base.variant,
      snapshotChanged: snapshotResult.changed,
      transition,
      alerts,
    };
  });
}

export async function processSubscriptionUpdated(
  eventSnapshot: Stripe.Subscription,
): Promise<SubscriptionUpdatedOutcome> {
  const subscriptionId = eventSnapshot.id;
  if (!subscriptionId) {
    console.warn(
      `${LOG_PREFIX} customer.subscription.updated missing subscription id — skipping tier update`,
    );
    return ignoredOutcome('', 'missing_subscription_id');
  }

  const customerId = extractCustomerId(eventSnapshot.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} customer.subscription.updated missing customer — skipping`);
    return ignoredOutcome(subscriptionId, 'missing_customer_id');
  }

  const reference = await resolveAccountReference(customerId, subscriptionId);
  if (!reference) {
    console.warn(
      `${LOG_PREFIX} customer.subscription.updated no account found for customer=${customerId} — signaling retry`,
    );
    throw new AccountNotProvisionedYetError(customerId);
  }
  if (reference.stripe_subscription_id !== subscriptionId) {
    if (reference.active_offboarding_subscription_id === subscriptionId) {
      console.log(
        `${LOG_PREFIX} customer.subscription.updated subscription=${subscriptionId} matches active offboarding snapshot for account ${reference.id} — skipping live projection`,
      );
      return ignoredOutcome(
        subscriptionId,
        'active_offboarding_subscription',
        reference.id,
      );
    }
    console.warn(
      `${LOG_PREFIX} customer.subscription.updated subscription=${subscriptionId} is stale for account ${reference.id} — skipping`,
    );
    return ignoredOutcome(subscriptionId, 'stale_subscription', reference.id);
  }

  const outcome = await projectProviderCurrentSubscription(
    reference,
    customerId,
    subscriptionId,
  );
  for (const alert of outcome.alerts) reportOperationalAlert(alert);
  return outcome;
}
