// WS8 cutover §1: create the six immutable launch Prices in the TARGET Stripe
// account. Mirrors the staging test-mode catalog exactly (verified against the
// six staging Price objects on 2026-07-16).
//
//   railway run --environment production --service repworth-worker -- \
//     pnpm tsx scripts/ws8-create-launch-prices.ts
//
// Idempotent: products are matched by exact name, prices by (product, amount,
// currency, monthly interval); existing matches are REUSED, never duplicated —
// a rerun after a partial failure completes the catalog instead of forking it.
// Refuses a non-live key unless --allow-test-mode is passed, so a mispasted
// sk_test_ can never masquerade as the production catalog. Never loads
// .env.local (gotcha #1).
import { getStripe } from '../src/lib/payments/stripe-client';
import { runDirectCli } from './run-direct-cli';

interface LaunchPriceSpec {
  envVar: string;
  productName: string;
  nickname: string;
  unitAmount: number;
}

const LAUNCH_CATALOG: readonly LaunchPriceSpec[] = [
  { envVar: 'STRIPE_PRICE_COPILOT_LIST', productName: 'RepWorth Copilot', nickname: 'Copilot base', unitAmount: 2900 },
  { envVar: 'STRIPE_PRICE_COPILOT_FOUNDING', productName: 'RepWorth Copilot', nickname: 'Copilot founding base', unitAmount: 1900 },
  { envVar: 'STRIPE_PRICE_AUTOPILOT_LIST', productName: 'RepWorth Autopilot', nickname: 'Autopilot base', unitAmount: 6900 },
  { envVar: 'STRIPE_PRICE_AUTOPILOT_FOUNDING', productName: 'RepWorth Autopilot', nickname: 'Autopilot founding base', unitAmount: 4900 },
  { envVar: 'STRIPE_PRICE_COPILOT_OVERAGE', productName: 'RepWorth Copilot - Extra Location', nickname: 'Copilot extra location', unitAmount: 1500 },
  { envVar: 'STRIPE_PRICE_AUTOPILOT_OVERAGE', productName: 'RepWorth Autopilot - Extra Location', nickname: 'Autopilot extra location', unitAmount: 2000 },
] as const;

async function resolveProductId(name: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;
  const existing = await getStripe().products.list({ active: true, limit: 100 });
  for (const product of existing.data) cache.set(product.name, product.id);
  const found = cache.get(name);
  if (found) return found;
  const created = await getStripe().products.create({ name });
  cache.set(name, created.id);
  return created.id;
}

async function main(): Promise<number> {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  const liveKey = key.startsWith('sk_live_');
  if (!liveKey && !process.argv.includes('--allow-test-mode')) {
    console.error(
      `WS8_LAUNCH_PRICES REFUSED key_prefix=${key.slice(0, 8) || '(unset)'} — live key required (pass --allow-test-mode only for rehearsal)`,
    );
    return 1;
  }
  console.log(`WS8_LAUNCH_PRICES mode=${liveKey ? 'LIVE' : 'test-rehearsal'}`);

  const productCache = new Map<string, string>();
  let failures = 0;
  for (const spec of LAUNCH_CATALOG) {
    const productId = await resolveProductId(spec.productName, productCache);
    const prices = await getStripe().prices.list({ product: productId, active: true, limit: 100 });
    let price = prices.data.find(
      (candidate) =>
        candidate.unit_amount === spec.unitAmount &&
        candidate.currency === 'usd' &&
        candidate.recurring?.interval === 'month' &&
        candidate.recurring?.interval_count === 1,
    );
    const action = price ? 'REUSED' : 'CREATED';
    if (!price) {
      price = await getStripe().prices.create({
        product: productId,
        unit_amount: spec.unitAmount,
        currency: 'usd',
        recurring: { interval: 'month' },
        nickname: spec.nickname,
      });
    }

    // Fresh retrieve — mutation responses are never trusted as final state.
    const verified = await getStripe().prices.retrieve(price.id);
    const ok =
      verified.unit_amount === spec.unitAmount &&
      verified.currency === 'usd' &&
      verified.recurring?.interval === 'month' &&
      verified.recurring?.interval_count === 1 &&
      verified.active === true &&
      verified.livemode === liveKey;
    if (!ok) failures += 1;
    console.log(
      `WS8_LAUNCH_PRICE ${ok ? 'OK' : 'MISMATCH'} ${action} ${spec.envVar}=${verified.id} ` +
        `amount=${verified.unit_amount} livemode=${verified.livemode}`,
    );
  }
  return failures === 0 ? 0 : 1;
}

runDirectCli({
  importMetaUrl: import.meta.url,
  main,
  onError: (error) => {
    console.error('WS8_LAUNCH_PRICES driver error', error);
    return 1;
  },
});
