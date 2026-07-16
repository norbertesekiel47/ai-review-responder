import { captureMessage } from '@sentry/node';
import type { TransactionSql } from 'postgres';
import type Stripe from 'stripe';
import type { TransitionResult } from './apply-subscription-state';
import { sql } from '../../../src/lib/db/server';
import {
  SubscriptionTier,
  isPriceVariant,
  type PriceVariant,
  type ResolvedTierSnapshot,
  type SubscriptionTierValue,
} from '../../../src/lib/accounts/tier-config';
import { acquireTierAndBillingLocks } from '../../../src/lib/accounts/billing-locks';
import {
  synchronizeBusinessTierMirror,
  writeResolvedTierSnapshot,
  writeTierSnapshot,
} from '../../../src/lib/accounts/tier-snapshot';
import {
  overagePriceInfoForId,
} from '../../../src/lib/payments/price-tier-map';
import {
  resolveSubscriptionBilling,
  type BaseItemResolution,
  type OverageItemResolution,
} from '../../../src/lib/payments/overage-item';
import { autopilotPurchasable } from '../../../src/lib/payments/tier-purchasability';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { enqueueStripeSubscriptionMirrorSync } from '../../../src/lib/shared/job-outbox-helpers';
import { subscriptionGrantsFullAccess } from '../../../src/lib/shared/subscription-status';
import {
  LOG_PREFIX,
  extractCustomerId,
  AccountNotProvisionedYetError,
  getStripe,
} from './shared';
import {
  applyStripeSubscriptionStateUnderEntitlementLock,
} from './apply-subscription-state';

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

interface SubscriptionUpdateOperationalAlert {
  reason: SubscriptionUpdateAlertReason;
  accountId: string;
  subscriptionId: string;
  priceId?: string;
  mappedTier?: SubscriptionTierValue;
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
      tier: SubscriptionTierValue;
      variant: PriceVariant;
      snapshotChanged: boolean;
    })
  | (SubscriptionUpdateOutcomeBase & {
      kind: 'variant_mismatch';
      accountId: string;
      priceId: string;
      mappedTier: SubscriptionTierValue;
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
    tier: account.subscription_tier as SubscriptionTierValue,
    variant: account.price_variant,
    baseCents: Number(account.base_price_cents),
    overageCents: Number(account.locations_overage_price_cents),
    included: Number(account.locations_included),
  };
}

type MappedBaseItem = Extract<BaseItemResolution, { tier: SubscriptionTierValue }>;

type ProjectionBillingResult =
  | { ok: true; base: MappedBaseItem; locationsPaid: number }
  | { ok: false; outcome: SubscriptionUpdatedOutcome };

type StatusOnlyReason = Extract<
  SubscriptionUpdatedOutcome,
  { kind: 'status_only' }
>['reason'];

function statusOnlyOutcome(input: {
  account: LockedAccountRow;
  subscriptionId: string;
  transition: TransitionResult;
  reason: StatusOnlyReason;
  priceId?: string;
  base?: MappedBaseItem;
}): SubscriptionUpdatedOutcome {
  const alert: SubscriptionUpdateOperationalAlert = {
    reason: input.reason,
    accountId: input.account.id,
    subscriptionId: input.subscriptionId,
    priceId: input.priceId,
    mappedTier: input.base?.tier,
    mappedVariant: input.base?.variant,
    storedVariant: input.account.price_variant,
  };
  return {
    kind: 'status_only',
    accountId: input.account.id,
    subscriptionId: input.subscriptionId,
    reason: input.reason,
    transition: input.transition,
    alerts: [alert],
  };
}

function validateMappedBase(input: {
  account: LockedAccountRow;
  subscriptionId: string;
  transition: TransitionResult;
  base: BaseItemResolution | undefined;
}): { ok: true; base: MappedBaseItem } | { ok: false; outcome: SubscriptionUpdatedOutcome } {
  if (!input.base || input.base.tier === null) {
    return {
      ok: false,
      outcome: statusOnlyOutcome({
        account: input.account,
        subscriptionId: input.subscriptionId,
        transition: input.transition,
        reason: 'unmapped_base_price',
        priceId: input.base?.item.price?.id,
      }),
    };
  }
  if (!isPriceVariant(input.account.price_variant)) {
    return {
      ok: false,
      outcome: statusOnlyOutcome({
        ...input,
        reason: 'invalid_stored_variant',
        priceId: input.base.item.price.id,
        base: input.base,
      }),
    };
  }
  if (input.base.variant === input.account.price_variant) {
    return { ok: true, base: input.base };
  }
  const alert: SubscriptionUpdateOperationalAlert = {
    reason: 'variant_mismatch',
    accountId: input.account.id,
    subscriptionId: input.subscriptionId,
    priceId: input.base.item.price.id,
    mappedTier: input.base.tier,
    mappedVariant: input.base.variant,
    storedVariant: input.account.price_variant,
  };
  return {
    ok: false,
    outcome: {
      kind: 'variant_mismatch',
      accountId: input.account.id,
      subscriptionId: input.subscriptionId,
      priceId: input.base.item.price.id,
      mappedTier: input.base.tier,
      mappedVariant: input.base.variant,
      storedVariant: input.account.price_variant,
      transition: input.transition,
      alerts: [alert],
    },
  };
}

function validateOverage(input: {
  account: LockedAccountRow;
  subscriptionId: string;
  transition: TransitionResult;
  base: MappedBaseItem;
  overage: OverageItemResolution;
}): ProjectionBillingResult {
  const overageError = validateOveragePrice(input);
  if (overageError) return { ok: false, outcome: overageError };
  const locationsPaid = providerOverageQuantity(input.overage);
  if (Number.isSafeInteger(locationsPaid) && locationsPaid >= 0) {
    return { ok: true, base: input.base, locationsPaid };
  }
  return {
    ok: false,
    outcome: statusOnlyOutcome({
      ...input,
      reason: 'invalid_overage_quantity',
      priceId: input.overage.kind === 'trusted' ? input.overage.item.price.id : undefined,
    }),
  };
}

function validateOveragePrice(input: {
  account: LockedAccountRow;
  subscriptionId: string;
  transition: TransitionResult;
  base: MappedBaseItem;
  overage: OverageItemResolution;
}): SubscriptionUpdatedOutcome | null {
  if (input.overage.kind === 'untrusted') {
    return statusOnlyOutcome({
      ...input,
      reason: 'untrusted_overage_item',
      priceId: input.overage.item.price.id,
    });
  }
  if (input.overage.kind === 'trusted') {
    const mappedOverage = overagePriceInfoForId(input.overage.item.price.id);
    if (mappedOverage && mappedOverage.tier !== input.base.tier) {
      return statusOnlyOutcome({
        ...input,
        reason: 'cross_tier_overage_price',
        priceId: input.overage.item.price.id,
      });
    }
  }
  return null;
}

function providerOverageQuantity(overage: OverageItemResolution): number {
  return overage.kind === 'trusted' ? (overage.item.quantity ?? 0) : 0;
}

function resolveProjectionBilling(input: {
  account: LockedAccountRow;
  subscription: Stripe.Subscription;
  subscriptionId: string;
  transition: TransitionResult;
}): ProjectionBillingResult {
  const billing = resolveSubscriptionBilling(input.subscription.items?.data ?? [], {
    storedOveragePriceCents: Number(input.account.locations_overage_price_cents),
  });
  const base = validateMappedBase({ ...input, base: billing.base });
  if (!base.ok) return base;
  return validateOverage({ ...input, base: base.base, overage: billing.overage });
}

async function writeProviderSnapshot(
  tx: TransactionSql,
  input: {
    account: LockedAccountRow;
    base: MappedBaseItem;
    locationsPaid: number;
    subscriptionId: string;
  },
): Promise<{ changed: boolean }> {
  if (input.account.subscription_tier === input.base.tier) {
    return writeResolvedTierSnapshot(tx, {
      accountId: input.account.id,
      snapshot: storedSnapshot(input.account),
      locationsPaid: input.locationsPaid,
      audit: {
        eventType: 'subscription_updated',
        payload: {
          source: 'provider_current_subscription',
          stripe_subscription_id: input.subscriptionId,
        },
      },
    });
  }
  return writeTierSnapshot(tx, {
    accountId: input.account.id,
    tier: input.base.tier,
    variant: input.account.price_variant as PriceVariant,
    locationsPaid: input.locationsPaid,
    audit: {
      eventType: 'subscription_updated',
      payload: {
        source: 'provider_current_subscription',
        previous_tier: input.account.subscription_tier,
        stripe_subscription_id: input.subscriptionId,
      },
    },
  });
}

function unavailableAutopilotAlerts(input: {
  account: LockedAccountRow;
  base: MappedBaseItem;
  subscription: Stripe.Subscription;
  subscriptionId: string;
}): SubscriptionUpdateOperationalAlert[] {
  const unavailable = input.base.tier === SubscriptionTier.AUTOPILOT
    && subscriptionGrantsFullAccess(input.subscription.status)
    && !autopilotPurchasable();
  if (!unavailable) return [];
  return [{
    reason: 'autopilot_activated_while_unavailable',
    accountId: input.account.id,
    subscriptionId: input.subscriptionId,
    priceId: input.base.item.price.id,
    mappedTier: input.base.tier,
    mappedVariant: input.base.variant,
    storedVariant: input.account.price_variant,
  }];
}

async function projectProviderCurrentSubscriptionTx(
  tx: TransactionSql,
  input: {
    accountId: string;
    customerId: string;
    subscriptionId: string;
  },
): Promise<SubscriptionUpdatedOutcome> {
  // Fixed tier/webhook order. No account row is held while either advisory
  // lock is acquired or while provider-current Stripe state is retrieved.
  await acquireTierAndBillingLocks(tx, input.accountId);
  const subscription = await getStripe().subscriptions.retrieve(input.subscriptionId);
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
    WHERE a.id = ${input.accountId}::uuid
    FOR UPDATE
  `;

  if (!account) {
    return ignoredOutcome(input.subscriptionId, 'account_disappeared', input.accountId);
  }
  if (providerCustomerId !== input.customerId || account.stripe_customer_id !== input.customerId) {
    return ignoredOutcome(input.subscriptionId, 'provider_customer_mismatch', account.id);
  }
  if (account.stripe_subscription_id !== input.subscriptionId) {
    return ignoredOutcome(input.subscriptionId, 'stale_subscription', account.id);
  }

  // Absolute status ownership: every provider-current subscription status,
  // including unknown Price and variant-mismatch paths, enters through the
  // one Stripe status applier.
  const transition = await applyStripeSubscriptionStateUnderEntitlementLock(
    tx,
    account.id,
    {
      mode: 'subscription',
      stripeCustomerId: input.customerId,
      stripeSubscriptionId: input.subscriptionId,
    },
    subscription,
  );
  // A provider-current replay may be a canonical no-op while the deprecated
  // business status/activation mirror is stale. Changed transitions enqueue
  // this work inside the applier; enqueue only the resolved no-op case here so
  // every provider-current projection repairs the mirror exactly once.
  if (transition.accountResolved && !transition.changed) {
    await enqueueStripeSubscriptionMirrorSync(tx, account.id);
  }
  const billing = resolveProjectionBilling({
    account,
    subscription,
    subscriptionId: input.subscriptionId,
    transition,
  });
  if (!billing.ok) return billing.outcome;

  const snapshotResult = await writeProviderSnapshot(tx, {
    account,
    base: billing.base,
    locationsPaid: billing.locationsPaid,
    subscriptionId: input.subscriptionId,
  });
  return {
    kind: 'updated',
    accountId: account.id,
    subscriptionId: input.subscriptionId,
    tier: billing.base.tier,
    variant: billing.base.variant,
    snapshotChanged: snapshotResult.changed,
    transition,
    alerts: unavailableAutopilotAlerts({
      account,
      base: billing.base,
      subscription,
      subscriptionId: input.subscriptionId,
    }),
  };
}

async function projectProviderCurrentSubscription(
  reference: AccountReference,
  customerId: string,
  subscriptionId: string,
): Promise<SubscriptionUpdatedOutcome> {
  return sql.begin((tx) => projectProviderCurrentSubscriptionTx(tx, {
    accountId: reference.id,
    customerId,
    subscriptionId,
  }));
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
  if (outcome.accountId) {
    if (outcome.kind === 'updated') {
      await synchronizeBusinessTierMirror(sql, outcome.accountId);
    }
  }
  for (const alert of outcome.alerts) reportOperationalAlert(alert);
  return outcome;
}
