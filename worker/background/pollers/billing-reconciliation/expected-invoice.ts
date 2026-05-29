import { computeOverageQuantity } from '../../../../src/lib/accounts/quota';
import { isSubscriptionTier, TIER_CONFIG } from '../../../../src/lib/accounts/tier-config';
import type { BillingReconciliationAccount, ExpectedInvoice } from './types';

export function expectedInvoiceForAccount(
  account: BillingReconciliationAccount,
): ExpectedInvoice {
  if (!isSubscriptionTier(account.subscription_tier)) {
    throw new Error(`Unknown subscription tier: ${account.subscription_tier}`);
  }

  const config = TIER_CONFIG[account.subscription_tier];
  const overageUnits = config.multiLocAllowed
    ? computeOverageQuantity(
        Number(account.active_location_count),
        Number(account.locations_included),
      )
    : 0;
  const overageUnitPriceCents = config.multiLocAllowed
    ? Number(account.locations_overage_price_cents)
    : 0;

  const baseCents = Number(account.base_price_cents);

  return {
    baseCents,
    overageUnits,
    overageUnitPriceCents,
    totalCents: baseCents + overageUnits * overageUnitPriceCents,
  };
}
