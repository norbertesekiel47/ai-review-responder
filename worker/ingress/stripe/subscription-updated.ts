import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { TIER_CONFIG, type SubscriptionTierValue } from '../../../src/lib/accounts/tier-config';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { tierForBasePriceId, overagePriceIdSet } from '../../../src/lib/payments/price-tier-map';
import { LOG_PREFIX, extractCustomerId } from './shared';

export async function processSubscriptionUpdated(sub: Stripe.Subscription): Promise<void> {
  const customerId = extractCustomerId(sub.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} customer.subscription.updated missing customer — skipping`);
    return;
  }

  const items = sub.items?.data ?? [];
  // Build the overage-price-ID set once; both item searches reuse it (the
  // price-tier-map module recommends this over per-item isOveragePriceId).
  const overagePriceIds = overagePriceIdSet();

  // VAL-BILLING-009: resolve base item -> tier via the single-owner price map.
  const baseItem = items.find(
    (item) => item.price?.id && !overagePriceIds.has(item.price.id),
  );
  if (!baseItem?.price?.id) {
    console.warn(`${LOG_PREFIX} customer.subscription.updated missing base price ID for customer=${customerId} — skipping tier update`);
    return;
  }

  const tier: SubscriptionTierValue | null = tierForBasePriceId(baseItem.price.id);
  if (!tier) {
    console.warn(`${LOG_PREFIX} Unknown base price ID ${baseItem.price.id} for customer=${customerId} — skipping tier update`);
    return;
  }

  // VAL-BILLING-010: overage item quantity -> accounts.locations_paid.
  // VAL-BILLING-011: tolerate legacy single-item subscriptions (quantity 0).
  const overageItem = items.find(
    (item) => item.price?.id && overagePriceIds.has(item.price.id),
  );
  const locationsPaid = overageItem?.quantity ?? 0;

  // VAL-BILLING-062: advisory lock prevents concurrent tier/overage writes.
  await sql.begin(async (tx) => {
    const [acctRow] = await tx<{
      id: string;
      subscription_tier: string;
      subscription_status: string;
      locations_paid: number;
    }[]>`
      SELECT id, subscription_tier, subscription_status, locations_paid
      FROM accounts
      WHERE stripe_customer_id = ${customerId}
      FOR UPDATE
    `;

    if (!acctRow) {
      console.warn(`${LOG_PREFIX} customer.subscription.updated no account found for customer=${customerId} — skipping tier update`);
      return;
    }

    await tx`SELECT pg_advisory_xact_lock(hashtext(${acctRow.id + ':subscription_update'}))`;

    const tierChanged = acctRow.subscription_tier !== tier;
    const locationsPaidChanged = acctRow.locations_paid !== locationsPaid;

    // Update accounts (source of truth)
    await tx`
      UPDATE accounts
      SET
        subscription_tier = ${tier},
        locations_paid = ${locationsPaid},
        locations_included = CASE WHEN ${tierChanged} THEN ${TIER_CONFIG[tier].included} ELSE locations_included END,
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
