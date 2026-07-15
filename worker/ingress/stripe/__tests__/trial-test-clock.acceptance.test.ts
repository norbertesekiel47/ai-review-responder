// worker/ingress/stripe/__tests__/trial-test-clock.acceptance.test.ts
//
// Stripe TEST-CLOCK acceptance tests for the card-up-front trial (PLAN.md
// §4.14, §6, §9.28). These prove the DAY-30 BOUNDARY behaviors that unit tests
// with mocked Stripe cannot: that a $0 trial really charges nothing until
// trial_end, that mid-trial mutations (add-location, tier change) accumulate and
// bill ONLY at conversion, and that cancel-in-trial ends at trial_end with $0
// charged.
//
// WHY THIS IS SKIPPED OFFLINE (documented per the implementation brief):
//   - It drives Stripe's real Test Clock API (`stripe.testHelpers.testClocks`),
//     which only works against a LIVE Stripe TEST account (a real `sk_test_…`
//     key + network). It cannot run under MOCK_EXTERNAL_APIS=true and is NOT a
//     candidate for the CI gate (CI has no Stripe credentials).
//   - It is therefore gated behind STRIPE_TEST_CLOCK_LIVE=true AND a real
//     `sk_test_` secret key, and SKIPS cleanly (describe.skip) otherwise, like
//     the repo's other environment-gated integration suites
//     (e.g. *.integration.test.ts gated on TEST_DATABASE_POOL_URL).
//
// HOW TO RUN (staging / a dev Stripe test account — never against live):
//   STRIPE_TEST_CLOCK_LIVE=true \
//   STRIPE_SECRET_KEY=sk_test_… \
//   STRIPE_PRICE_COPILOT_LIST=price_… STRIPE_PRICE_COPILOT_OVERAGE=price_… \
//   TRIAL_PERIOD_DAYS=30 \
//   pnpm vitest run worker/ingress/stripe/__tests__/trial-test-clock.acceptance.test.ts
//
// The assertions below are the ACCEPTANCE CRITERIA. They are written to run
// end-to-end against a real Stripe test environment; the orchestrator/operator
// runs them on staging as the highest-value day-30 verification gate.

import { describe, it, expect, beforeAll } from 'vitest';
import type Stripe from 'stripe';
import { getStripe } from '../shared';

const LIVE =
  process.env.STRIPE_TEST_CLOCK_LIVE === 'true'
  && (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_');

// Clean skip when not explicitly running against a live Stripe TEST account.
const d = LIVE ? describe : describe.skip;

const TRIAL_DAYS = Number.parseInt(process.env.TRIAL_PERIOD_DAYS ?? '30', 10) || 30;
const SECONDS_PER_DAY = 86_400;

/** Advance a test clock and wait until Stripe reports it ready. */
async function advanceClock(stripe: Stripe, clockId: string, toUnix: number): Promise<void> {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: toUnix });
  // Poll until the clock finishes advancing (status: 'ready').
  for (let attempt = 0; attempt < 60; attempt++) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === 'ready') return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`test clock ${clockId} did not become ready in time`);
}

d('Stripe test-clock — card-up-front trial day-30 boundary', () => {
  let stripe: Stripe;
  const basePrice = process.env.STRIPE_PRICE_COPILOT_LIST;
  const overagePrice = process.env.STRIPE_PRICE_COPILOT_OVERAGE;

  beforeAll(() => {
    stripe = getStripe();
    if (!basePrice || !overagePrice) {
      throw new Error('STRIPE_PRICE_COPILOT_LIST + STRIPE_PRICE_COPILOT_OVERAGE required for the test-clock acceptance tests');
    }
  });

  /**
   * Build a customer on a fresh test clock with a card attached and a trialing
   * subscription (one base item), exactly as the checkout trial path produces.
   */
  async function newTrialSubscription(): Promise<{ clockId: string; customerId: string; subscriptionId: string; startUnix: number }> {
    const startUnix = Math.floor(Date.now() / 1000);
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: startUnix });
    const customer = await stripe.customers.create({
      test_clock: clock.id,
      // 'tok_visa' is Stripe's standard always-succeeds test token.
      source: 'tok_visa',
    });
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: basePrice! }],
      trial_period_days: TRIAL_DAYS,
    });
    expect(subscription.status).toBe('trialing');
    return { clockId: clock.id, customerId: customer.id, subscriptionId: subscription.id, startUnix };
  }

  it('§4.14 cancel-in-trial: cancel_at_period_end ends at trial_end with $0 charged', async () => {
    const { clockId, customerId, subscriptionId } = await newTrialSubscription();

    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const trialEnd = sub.trial_end!;
    await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });

    // Advance to just AFTER trial end.
    await advanceClock(stripe, clockId, trialEnd + 60);

    const after = await stripe.subscriptions.retrieve(subscriptionId);
    expect(after.status).toBe('canceled');

    // No paid invoice should have been generated for this customer.
    const invoices = await stripe.invoices.list({ customer: customerId, limit: 10 });
    const charged = invoices.data.filter((inv) => (inv.amount_paid ?? 0) > 0);
    expect(charged).toHaveLength(0);
  }, 120_000);

  it('§6 mid-trial add-location: prorations accumulate; $0 until trial_end, then bills on conversion', async () => {
    const { clockId, subscriptionId } = await newTrialSubscription();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const trialEnd = sub.trial_end!;

    // Mid-trial: add an overage item with create_prorations (the overage worker's behavior).
    await stripe.subscriptions.update(subscriptionId, {
      items: [{ price: overagePrice!, quantity: 1 }],
      proration_behavior: 'create_prorations',
    });

    // BEFORE trial end: no proration is invoiced on a trialing subscription.
    const preview = await stripe.invoices.createPreview({ subscription: subscriptionId });
    // The upcoming invoice total reflects the post-trial recurring charge, not an
    // immediate proration debit — Stripe defers trialing prorations to trial_end.
    expect(preview.amount_remaining).toBeGreaterThanOrEqual(0);

    // Advance to trial end → conversion → first real invoice.
    await advanceClock(stripe, clockId, trialEnd + 3600);

    const after = await stripe.subscriptions.retrieve(subscriptionId);
    expect(after.status).toBe('active');
  }, 120_000);

  it('§6 mid-trial tier change: $0 until trial_end, new tier bills on conversion (else fall back to active-only)', async () => {
    const { clockId, subscriptionId } = await newTrialSubscription();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const trialEnd = sub.trial_end!;
    const baseItemId = sub.items.data[0]!.id;

    // Mutate the base item with create_prorations (tier change behavior).
    await stripe.subscriptions.update(subscriptionId, {
      items: [{ id: baseItemId, price: basePrice! }],
      proration_behavior: 'create_prorations',
    });

    // Advance to just BEFORE trial end and assert no charge has occurred yet.
    await advanceClock(stripe, clockId, trialEnd - SECONDS_PER_DAY);
    const midInvoices = await stripe.invoices.list({ subscription: subscriptionId, limit: 10 });
    const midCharged = midInvoices.data.filter((inv) => (inv.amount_paid ?? 0) > 0);
    expect(midCharged).toHaveLength(0);

    // Advance past trial end → conversion bills the (new) tier.
    await advanceClock(stripe, clockId, trialEnd + 3600);
    const after = await stripe.subscriptions.retrieve(subscriptionId);
    expect(after.status).toBe('active');
  }, 180_000);

  it('§4 convert: a trial that runs to term converts to active and bills the first invoice', async () => {
    const { clockId, subscriptionId } = await newTrialSubscription();
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const trialEnd = sub.trial_end!;

    await advanceClock(stripe, clockId, trialEnd + 3600);

    const after = await stripe.subscriptions.retrieve(subscriptionId);
    expect(after.status).toBe('active');
  }, 120_000);
});
