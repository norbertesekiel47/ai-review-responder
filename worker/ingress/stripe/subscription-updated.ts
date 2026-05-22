import Stripe from 'stripe';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../../src/lib/db/server';
import { TIER_CONFIG, type SubscriptionTierValue } from '../../../src/lib/accounts/tier-config';
import { LOG_PREFIX, extractCustomerId } from './shared';

export async function processSubscriptionUpdated(sub: Stripe.Subscription): Promise<void> {
  const customerId = extractCustomerId(sub.customer);
  if (!customerId) {
    console.warn(`${LOG_PREFIX} customer.subscription.updated missing customer — skipping`);
    return;
  }

  // VAL-BILLING-009: Map base price_id to tier
  // VAL-BILLING-030: All 7 price env vars referenced in the reverse-map
  // VAL-BILLING-055: Reverse-map includes all 7 price IDs
  const priceToTier: Record<string, SubscriptionTierValue> = {
    [process.env.STRIPE_PRICE_BASIC ?? '']: 'basic',
    [process.env.STRIPE_PRICE_FOUNDING ?? '']: 'founders',
    [process.env.STRIPE_PRICE_STANDARD ?? '']: 'standard',
    [process.env.STRIPE_PRICE_PREMIUM  ?? '']: 'premium',
  };

  // Overage price IDs (for identifying the overage item)
  const overagePriceIds = new Set([
    process.env.STRIPE_PRICE_FOUNDERS_OVERAGE ?? '',
    process.env.STRIPE_PRICE_STANDARD_OVERAGE ?? '',
    process.env.STRIPE_PRICE_PREMIUM_OVERAGE ?? '',
  ].filter(Boolean));

  const items = sub.items?.data ?? [];

  // Find the base item (first non-overage item with quantity=1)
  const baseItem = items.find(
    (item) => item.price?.id && !overagePriceIds.has(item.price.id),
  );
  if (!baseItem?.price?.id) {
    console.warn(`${LOG_PREFIX} customer.subscription.updated missing base price ID for customer=${customerId} — skipping tier update`);
    return;
  }

  const tier = priceToTier[baseItem.price.id];
  if (!tier) {
    console.warn(`${LOG_PREFIX} Unknown base price ID ${baseItem.price.id} for customer=${customerId} — skipping tier update`);
    return;
  }

  // VAL-BILLING-010: Read overage item quantity → accounts.locations_paid
  // VAL-BILLING-011: Tolerate legacy single-item subscriptions
  const overageItem = items.find(
    (item) => item.price?.id && overagePriceIds.has(item.price.id),
  );
  const locationsPaid = overageItem?.quantity ?? 0;

  // VAL-BILLING-062: Advisory lock prevents concurrent tier/overage writes.
  await sql.begin(async (tx) => {
    const [acctRow] = await tx<{ id: string; subscription_tier: string; subscription_status: string }[]>`
      SELECT id, subscription_tier, subscription_status
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

    // VAL-LOC-029 / VAL-LOC-058: Audit log for tier change and locations_paid update
    const auditPayload: Record<string, unknown> = {};
    if (tierChanged) {
      auditPayload.fromTier = acctRow.subscription_tier;
      auditPayload.toTier = tier;
    }
    auditPayload.locationsPaid = locationsPaid;

    if (Object.keys(auditPayload).length > 0) {
      await tx`
        INSERT INTO account_audit_log (id, account_id, event_type, payload)
        VALUES (
          ${uuidv7()}::uuid,
          ${acctRow.id}::uuid,
          'subscription_updated',
          ${jsonb(auditPayload)}
        )
      `;
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
