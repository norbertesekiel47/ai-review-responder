// scripts/verify-stripe-price-parity.ts
//
// Fails loudly if a configured Stripe Price has drifted from TIER_CONFIG —
// the displayed price (TIER_CONFIG) and the charged price (Stripe unit_amount)
// are two copies of one fact, so this reconciles them. Run before the first
// charge and after ANY price change (see the price-change procedure in
// .claude/reference/env-vars.md). NOT in blocking CI (needs live Stripe keys).
//
//   pnpm verify:stripe-prices
//
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
if (existsSync('.env.local')) dotenvConfig({ path: '.env.local' });
else dotenvConfig();

import { getStripe } from '../src/lib/payments/stripe-client';
import { basePriceIdForTier, overagePriceIdForTier } from '../src/lib/payments/price-tier-map';
import { TIER_CONFIG, type SubscriptionTierValue } from '../src/lib/accounts/tier-config';

const TAX_REQUIRED = process.env.STRIPE_TAX_ENABLED === 'true';
const TIERS = Object.keys(TIER_CONFIG) as SubscriptionTierValue[];

interface Mismatch { label: string; field: string; expected: unknown; actual: unknown; }

async function checkPrice(label: string, priceId: string, expectedCents: number): Promise<Mismatch[]> {
  const price = await getStripe().prices.retrieve(priceId);
  // One row per reconciled field; `active` gates the tax_behavior row behind the
  // flag. Data-driven so adding a field never grows the branch count.
  const checks: ReadonlyArray<{ field: string; expected: unknown; actual: unknown; active: boolean }> = [
    { field: 'unit_amount', expected: expectedCents, actual: price.unit_amount, active: true },
    { field: 'currency', expected: 'usd', actual: price.currency, active: true },
    { field: 'recurring.interval', expected: 'month', actual: price.recurring?.interval, active: true },
    { field: 'tax_behavior', expected: 'exclusive', actual: price.tax_behavior, active: TAX_REQUIRED },
  ];
  return checks
    .filter((c) => c.active && c.expected !== c.actual)
    .map((c) => ({ label, field: c.field, expected: c.expected, actual: c.actual }));
}

async function tierMismatches(tier: SubscriptionTierValue): Promise<Mismatch[]> {
  const baseId = basePriceIdForTier(tier);
  if (!baseId) return [{ label: `${tier} base`, field: 'env', expected: 'price id', actual: 'unset' }];

  const out = await checkPrice(`${tier} base`, baseId, TIER_CONFIG[tier].baseCents);
  const overageId = overagePriceIdForTier(tier);
  if (overageId) out.push(...await checkPrice(`${tier} overage`, overageId, TIER_CONFIG[tier].overageCents));
  return out;
}

function failWith(mismatches: Mismatch[]): never {
  console.error('Stripe price parity FAILED:');
  for (const m of mismatches) console.error(`  ${m.label}: ${m.field} expected=${m.expected} actual=${m.actual}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const mismatches: Mismatch[] = [];
  for (const tier of TIERS) mismatches.push(...await tierMismatches(tier));

  if (mismatches.length > 0) failWith(mismatches);

  const taxNote = TAX_REQUIRED ? ' (incl. tax_behavior)' : '';
  console.log(`Stripe price parity OK for ${TIERS.length} tiers${taxNote}.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
