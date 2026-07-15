// Verifies every immutable launch Price shape against the locked registry.
// Run manually before first charge and after creating any replacement Price.
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getStripe } from '../src/lib/payments/stripe-client';
import { priceIdFor } from '../src/lib/payments/price-tier-map';
import {
  resolveTierSnapshot,
  type PriceVariant,
  type SubscriptionTierValue,
} from '../src/lib/accounts/tier-config';

const TIERS = ['copilot', 'autopilot'] as const satisfies readonly SubscriptionTierValue[];
const VARIANTS = ['list', 'founding'] as const satisfies readonly PriceVariant[];

export interface StripePriceParityMismatch {
  label: string;
  field: string;
  expected: unknown;
  actual: unknown;
}

interface StripePriceShape {
  active: boolean;
  unit_amount: number | null;
  currency: string;
  recurring: { interval: string } | null;
  tax_behavior: string | null;
}

export type RetrieveStripePrice = (priceId: string) => Promise<StripePriceShape>;

async function checkPrice(
  retrievePrice: RetrieveStripePrice,
  taxRequired: boolean,
  label: string,
  priceId: string,
  expectedCents: number,
): Promise<StripePriceParityMismatch[]> {
  const price = await retrievePrice(priceId);
  const checks = [
    { field: 'active', expected: true, actual: price.active, required: true },
    { field: 'unit_amount', expected: expectedCents, actual: price.unit_amount, required: true },
    { field: 'currency', expected: 'usd', actual: price.currency, required: true },
    { field: 'recurring.interval', expected: 'month', actual: price.recurring?.interval, required: true },
    { field: 'tax_behavior', expected: 'exclusive', actual: price.tax_behavior, required: taxRequired },
  ] as const;
  return checks
    .filter((check) => check.required && check.expected !== check.actual)
    .map(({ field, expected, actual }) => ({ label, field, expected, actual }));
}

/** Verify the exact four base and two overage Prices configured for WS8. */
export async function verifyConfiguredStripePrices(
  retrievePrice: RetrieveStripePrice,
  taxRequired: boolean,
): Promise<StripePriceParityMismatch[]> {
  const mismatches: StripePriceParityMismatch[] = [];
  for (const tier of TIERS) {
    for (const variant of VARIANTS) {
      const snapshot = resolveTierSnapshot(tier, variant);
      const baseId = priceIdFor(tier, variant, 'base');
      if (!baseId) mismatches.push({ label: `${tier}/${variant} base`, field: 'env', expected: 'price id', actual: 'unset' });
      else mismatches.push(...await checkPrice(retrievePrice, taxRequired, `${tier}/${variant} base`, baseId, snapshot.baseCents));
    }
    const snapshot = resolveTierSnapshot(tier, 'list');
    const overageId = priceIdFor(tier, 'list', 'overage');
    if (!overageId) mismatches.push({ label: `${tier} overage`, field: 'env', expected: 'price id', actual: 'unset' });
    else mismatches.push(...await checkPrice(retrievePrice, taxRequired, `${tier} overage`, overageId, snapshot.overageCents));
  }
  return mismatches;
}

async function main(): Promise<void> {
  if (existsSync('.env.local')) dotenvConfig({ path: '.env.local' });
  else dotenvConfig();
  const taxRequired = process.env.STRIPE_TAX_ENABLED === 'true';
  const mismatches = await verifyConfiguredStripePrices(
    async (priceId) => getStripe().prices.retrieve(priceId),
    taxRequired,
  );
  if (mismatches.length > 0) {
    console.error('Stripe price parity FAILED:');
    for (const item of mismatches) console.error(`  ${item.label}: ${item.field} expected=${item.expected} actual=${item.actual}`);
    process.exit(1);
  }
  console.log(`Stripe price parity OK for ${TIERS.length} tiers and ${VARIANTS.length} variants.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
