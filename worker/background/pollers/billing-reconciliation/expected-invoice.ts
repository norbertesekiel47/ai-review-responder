import { computeOverageQuantity } from '../../../../src/lib/accounts/quota';
import { isSubscriptionTier } from '../../../../src/lib/accounts/tier-config';
import type { BillingReconciliationAccount, ExpectedInvoice } from './types';

export function expectedInvoiceForAccount(
  account: BillingReconciliationAccount,
): ExpectedInvoice {
  if (!isSubscriptionTier(account.subscription_tier)) {
    throw new Error(`Unknown subscription tier: ${account.subscription_tier}`);
  }

  // Point-in-time stored values are the only invoice-math authority. Never
  // re-derive quota or cents from the mutable runtime tier registry.
  const overageUnits = computeOverageQuantity(
    Number(account.active_location_count),
    Number(account.locations_included),
  );
  const overageUnitPriceCents = Number(account.locations_overage_price_cents);
  const baseCents = Number(account.base_price_cents);

  return {
    baseCents,
    overageUnits,
    overageUnitPriceCents,
    totalCents: baseCents + overageUnits * overageUnitPriceCents,
  };
}
