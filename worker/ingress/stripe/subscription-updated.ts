import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { TIER_CONFIG, type SubscriptionTierValue } from '../../../src/lib/accounts/tier-config';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { tierForBasePriceId, overagePriceIdSet, basePriceIdSet } from '../../../src/lib/payments/price-tier-map';
import {
  findOverageItemMatch,
  MUTATION_SAFE_OVERAGE_MATCHES,
} from '../../../src/lib/payments/overage-item';
import { LOG_PREFIX, extractCustomerId } from './shared';

export async function processSubscriptionUpdated(sub: Stripe.Subscription): Promise<void> {
  const subscriptionId = sub.id;
  if (!subscriptionId) {
    console.warn(`${LOG_PREFIX} customer.subscription.updated missing subscription id — skipping tier update`);
    return;
  }

  const customerId = extractCustomerId(sub.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} customer.subscription.updated missing customer — skipping`);
    return;
  }

  const items = sub.items?.data ?? [];
  const overagePriceIds = overagePriceIdSet();

  // VAL-BILLING-009: resolve base item -> tier via the single-owner price map.
  // Resolve POSITIVELY (the item whose price maps to a tier) rather than
  // "first item not in the env overage set" — after an overage price rotation
  // a grandfathered overage item is outside the env set and, if it sorts
  // first, the old negative match would mis-pick it as the base item.
  const baseItem = items.find(
    (item) => item.price?.id != null && tierForBasePriceId(item.price.id) !== null,
  );
  if (!baseItem?.price?.id) {
    console.warn(`${LOG_PREFIX} customer.subscription.updated missing base price ID for customer=${customerId} — skipping tier update`);
    return;
  }

  const basePriceId = baseItem.price.id;
  const tier: SubscriptionTierValue | null = tierForBasePriceId(basePriceId);
  if (!tier) {
    console.warn(`${LOG_PREFIX} Unknown base price ID ${basePriceId} for customer=${customerId} — skipping tier update`);
    return;
  }

  // VAL-BILLING-062: advisory lock prevents concurrent tier/overage writes.
  await sql.begin(async (tx) => {
    const [acctRow] = await tx<{
      id: string;
      subscription_tier: string;
      subscription_status: string;
      locations_paid: number;
      locations_overage_price_cents: number;
      stripe_subscription_id: string | null;
      active_offboarding_subscription_id: string | null;
    }[]>`
      SELECT
        a.id,
        a.subscription_tier,
        a.subscription_status,
        a.locations_paid,
        a.locations_overage_price_cents,
        a.stripe_subscription_id,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM account_offboardings ao
            WHERE ao.account_id = a.id
              AND ao.stripe_subscription_id = ${subscriptionId}
              AND ao.terminal_at IS NULL
          )
          THEN ${subscriptionId}
          ELSE NULL
        END AS active_offboarding_subscription_id
      FROM accounts a
      WHERE a.stripe_customer_id = ${customerId}
      FOR UPDATE
    `;

    if (!acctRow) {
      console.warn(`${LOG_PREFIX} customer.subscription.updated no account found for customer=${customerId} — skipping tier update`);
      return;
    }

    if (subscriptionId !== acctRow.stripe_subscription_id) {
      if (subscriptionId === acctRow.active_offboarding_subscription_id) {
        console.log(
          `${LOG_PREFIX} customer.subscription.updated subscription=${subscriptionId} matches active offboarding snapshot for account ${acctRow.id} but not current subscription — skipping live tier update`,
        );
        return;
      }

      console.warn(
        `${LOG_PREFIX} customer.subscription.updated subscription=${subscriptionId} does not match account ${acctRow.id} current/active-offboarding subscription — skipping tier update`,
      );
      return;
    }

    await tx`SELECT pg_advisory_xact_lock(hashtext(${acctRow.id + ':subscription_update'}))`;

    // VAL-BILLING-010: overage item quantity -> accounts.locations_paid.
    // VAL-BILLING-011: tolerate legacy single-item subscriptions (quantity 0).
    // Shared matcher (4th consumer): a grandfathered legacy-priced overage item
    // — recognized by the account's STORED cents — keeps its quantity synced
    // instead of being zeroed when the env overage price has been rotated.
    // Descriptor-only (keyword) matches are not trusted for this write.
    const overageMatch = findOverageItemMatch(items, {
      overagePriceIds,
      basePriceIds: new Set([...basePriceIdSet(), basePriceId]),
      storedOveragePriceCents: Number(acctRow.locations_overage_price_cents),
    });
    const overageMatchTrusted =
      overageMatch !== undefined && MUTATION_SAFE_OVERAGE_MATCHES.has(overageMatch.matchedBy);
    if (overageMatch && !overageMatchTrusted) {
      console.warn(
        `${LOG_PREFIX} descriptor-only overage match (item ${overageMatch.item.id}) for account ${acctRow.id} — treating as no overage item`,
      );
    }
    const locationsPaid = overageMatchTrusted ? overageMatch.item.quantity ?? 0 : 0;

    const tierChanged = acctRow.subscription_tier !== tier;
    const locationsPaidChanged = acctRow.locations_paid !== locationsPaid;

    // Update accounts (source of truth)
    await tx`
      UPDATE accounts
      SET
        subscription_tier = ${tier},
        locations_paid = ${locationsPaid},
        locations_included = CASE WHEN ${tierChanged} THEN ${TIER_CONFIG[tier].included} ELSE locations_included END,
        locations_overage_price_cents = CASE WHEN ${tierChanged} THEN ${TIER_CONFIG[tier].overageCents} ELSE locations_overage_price_cents END,
        base_price_cents = CASE WHEN ${tierChanged} THEN ${TIER_CONFIG[tier].baseCents} ELSE base_price_cents END,
        updated_at = NOW()
      WHERE id = ${acctRow.id}::uuid
    `;

    // VAL-LOC-029 / VAL-LOC-058: audit only real changes. Setting locationsPaid
    // only when it changed lets the guard below skip no-op deliveries entirely.
    const auditPayload: Record<string, unknown> = {};
    if (tierChanged) {
      auditPayload.fromTier = acctRow.subscription_tier;
      auditPayload.toTier = tier;
    }
    if (locationsPaidChanged) {
      auditPayload.locationsPaid = locationsPaid;
    }

    if (Object.keys(auditPayload).length > 0) {
      await writeAccountAuditLog(
        {
          accountId: acctRow.id,
          eventType: 'subscription_updated',
          payload: auditPayload,
        },
        tx,
      );
    }

    // Also update businesses deprecated column
    await tx`
      UPDATE businesses
      SET subscription_tier = ${tier}, updated_at = NOW()
      WHERE account_id = ${acctRow.id}::uuid
    `;

    console.log(`${LOG_PREFIX} Account ${acctRow.id} tier updated to ${tier}, locations_paid=${locationsPaid}`);
  });
}
