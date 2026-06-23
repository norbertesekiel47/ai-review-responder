import Stripe from 'stripe';
import type postgres from 'postgres';
import { sql } from '../../../src/lib/db/server';
import { TIER_CONFIG, type SubscriptionTierValue } from '../../../src/lib/accounts/tier-config';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { tierForBasePriceId } from '../../../src/lib/payments/price-tier-map';
import { resolveOverageItem } from '../../../src/lib/payments/overage-item';
import { LOG_PREFIX, extractCustomerId, AccountNotProvisionedYetError } from './shared';
import { applyStripeSubscriptionState } from './apply-subscription-state';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';

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

  // VAL-BILLING-009: resolve base item -> tier via the single-owner price map.
  // Resolve POSITIVELY (the item whose price maps to a tier) rather than
  // "first item not in the env overage set" — after an overage price rotation
  // a grandfathered overage item is outside the env set and, if it sorts
  // first, the old negative match would mis-pick it as the base item.
  //
  // FIX 3: tier resolution is computed here but is NO LONGER an early-return
  // gate. An unmapped/rotated/grandfathered base price must NOT block trial
  // conversion — the conversion path below runs even when `tier` is null (only
  // the tier/locations sync is skipped). Previously this returned early, so a
  // converting trial whose base price wasn't in the map only healed via the
  // hourly reconcile poller.
  const baseItem = items.find(
    (item) => item.price?.id != null && tierForBasePriceId(item.price.id) !== null,
  );
  const tier: SubscriptionTierValue | null = baseItem?.price?.id
    ? tierForBasePriceId(baseItem.price.id)
    : null;

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
      // Out-of-order delivery (deep-scan §6.2): this event likely arrived before
      // checkout.session.completed wrote accounts.stripe_customer_id. THROW (not a
      // clean return) so the wrapper replies 500 and Stripe redelivers once the
      // account exists. Redelivery is idempotent (status-guarded tier UPDATE +
      // claimInboundEvent). The mismatch branches below stay clean returns.
      console.warn(`${LOG_PREFIX} customer.subscription.updated no account found for customer=${customerId} — signaling retry`);
      throw new AccountNotProvisionedYetError(customerId);
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

    // Trial conversion: Stripe emits customer.subscription.updated with
    // status='active' when a trial converts. Convert trialing→active through the
    // SINGLE applier (subscription mode), in THIS tx, ONLY when the event's
    // subscription status is 'active' (plan §4.12 — the $0 trial-start invoice
    // can't flip the status early). The applier's transition table makes this a
    // no-op for any other source status, so it is safe to call whenever the
    // account is trialing.
    //
    // FIX 3: this runs BEFORE the tier-resolution gate below, so conversion is
    // independent of a successful base-price→tier mapping (an unmapped/rotated
    // price still converts via webhook, not only via the reconcile poller).
    if (
      acctRow.subscription_status === SubscriptionStatus.TRIALING
      && sub.status === 'active'
    ) {
      await applyStripeSubscriptionState(
        tx,
        { mode: 'subscription', stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId },
        sub,
      );
    }

    // FIX 3: tier/locations sync only when the base price maps to a known tier.
    // An unmapped base price skips the sync (the reconcile poller / a later
    // mapped event heals tier drift) but never blocks the conversion above.
    if (!tier) {
      console.warn(`${LOG_PREFIX} customer.subscription.updated unmapped base price for customer=${customerId} — skipping tier/locations sync (conversion, if any, already applied)`);
      return;
    }

    // VAL-BILLING-010: overage item quantity -> accounts.locations_paid.
    // VAL-BILLING-011: tolerate legacy single-item subscriptions (quantity 0).
    // Shared matcher (4th consumer): a grandfathered legacy-priced overage item
    // — recognized by the account's STORED cents — keeps its quantity synced
    // instead of being zeroed when the env overage price has been rotated.
    const locationsPaid = trustedOverageQuantity(items, acctRow);

    await applyAccountSubscriptionUpdate(tx, acctRow, tier, locationsPaid);
  });
}

/**
 * Overage quantity from the shared resolver. Descriptor-only (keyword)
 * matches are not trusted for this write — treated as no overage item.
 */
function trustedOverageQuantity(
  items: Stripe.SubscriptionItem[],
  acctRow: { id: string; locations_overage_price_cents: number },
): number {
  const resolution = resolveOverageItem(items, {
    storedOveragePriceCents: Number(acctRow.locations_overage_price_cents),
  });
  if (resolution.kind === 'untrusted') {
    console.warn(
      `${LOG_PREFIX} descriptor-only overage match (item ${resolution.item.id}) for account ${acctRow.id} — treating as no overage item`,
    );
  }
  return resolution.kind === 'trusted' ? resolution.item.quantity ?? 0 : 0;
}

/**
 * Writes the tier + locations_paid sync: accounts (source of truth), the
 * change-only audit row, and the deprecated businesses compat column.
 */
async function applyAccountSubscriptionUpdate(
  tx: postgres.TransactionSql,
  acctRow: { id: string; subscription_tier: string; locations_paid: number },
  tier: SubscriptionTierValue,
  locationsPaid: number,
): Promise<void> {
  const tierChanged = acctRow.subscription_tier !== tier;
  const locationsPaidChanged = acctRow.locations_paid !== locationsPaid;

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
  // only when it changed lets the dispatch guard skip no-op deliveries entirely.
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
}
