import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * customer.subscription.updated handler (worker/ingress/stripe/subscription-updated.ts):
 * two-item subscription mapping (base price -> tier, overage qty -> locations_paid),
 * legacy single-item tolerance, advisory lock, audit payload shapes, and
 * stale / active-offboarding subscription guards.
 *
 * Split out of the former stripe-webhook-handlers.test.ts (issue #268). Mock graph
 * + queue helpers come from the shared ./helpers/stripe-webhook-harness, which
 * builds the Postgres.js mock from the canonical worker/__tests__/helpers/mock-sql.
 */

// ── Hoisted mocks (shared stripe-webhook harness) ──────────────────
const {
  mockSql,
  sqlCalls,
  sqlReturnQueue,
  mockClaimInboundEvent,
  mockConstructEvent,
  mockWriteAccountAuditLog,
  resetStripeWebhookMocks,
  queueSubscriptionUpdated,
} = await vi.hoisted(async () => {
  const { createStripeWebhookHarness } = await import('./helpers/stripe-webhook-harness');
  return createStripeWebhookHarness();
});

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../src/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));
vi.mock('../shared', () => ({ claimInboundEvent: mockClaimInboundEvent }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));
vi.mock('stripe', () => ({
  default: class FakeStripe {
    webhooks = { constructEvent: mockConstructEvent };
  },
}));

import {
  installStripeWebhookEnv,
  mkRequest,
  mkReply,
  TEST_ACCOUNT_ID,
  TEST_CUSTOMER_ID,
  TEST_SUBSCRIPTION_ID,
} from './helpers/stripe-webhook-harness';
import { handleStripeWebhook } from '../stripe';

const restoreStripeWebhookEnv = installStripeWebhookEnv();
afterAll(restoreStripeWebhookEnv);

beforeEach(() => {
  resetStripeWebhookMocks();
});

describe('customer.subscription.updated — two-item subscription', () => {
  it('maps standard base price → tier "standard" and overage quantity → locations_paid', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
              { price: { id: 'price_standard_overage_test' }, quantity: 3 },
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'standard' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.values).toContain('standard');
    expect(updateAcct!.values).toContain(3);
  });

  it('maps premium base price → tier "premium" and overage quantity → locations_paid', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_2',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_premium_test' }, quantity: 1 },
              { price: { id: 'price_premium_overage_test' }, quantity: 5 },
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'premium' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.values).toContain('premium');
    expect(updateAcct!.values).toContain(5);
  });

  it('refreshes locations_included to premium default when Stripe changes tier from standard to premium', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_standard_to_premium',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_premium_test' }, quantity: 1 },
              { price: { id: 'price_premium_overage_test' }, quantity: 2 },
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'standard' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toContain('locations_included');
    expect(updateAcct!.text).toContain('base_price_cents');
    expect(updateAcct!.text).toContain('locations_overage_price_cents');
    // tier changed standard -> premium, so the premium base (19900) and
    // overage (2000) are re-snapshotted.
    expect(updateAcct!.values).toContain(19900);
    expect(updateAcct!.values).toContain(2000);
    expect(updateAcct!.values).toContain('premium');
    expect(updateAcct!.values).toContain(2);
    expect(updateAcct!.values).toContain(5);
  });

  it('preserves custom locations_included when Stripe sends same-tier overage-only update', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_standard_overage_only',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
              { price: { id: 'price_standard_overage_test' }, quantity: 4 },
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'standard' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/locations_included\s*=\s*CASE\s+WHEN\s+\?\s+THEN\s+\?\s+ELSE\s+locations_included\s+END/);
    expect(updateAcct!.text).toMatch(/base_price_cents\s*=\s*CASE\s+WHEN\s+\?\s+THEN\s+\?\s+ELSE\s+base_price_cents\s+END/);
    expect(updateAcct!.text).toMatch(/locations_overage_price_cents\s*=\s*CASE\s+WHEN\s+\?\s+THEN\s+\?\s+ELSE\s+locations_overage_price_cents\s+END/);
    expect(updateAcct!.values).toContain(false);
    expect(updateAcct!.values).toContain(4);
  });

  it('maps founders base price → tier "founders" with overage', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_3',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_founders_test' }, quantity: 1 },
              { price: { id: 'price_founders_overage_test' }, quantity: 2 },
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'founders' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.values).toContain('founders');
    expect(updateAcct!.values).toContain(2);
  });

  it('VAL-BILLING-011: legacy single-item subscription — tier updated, locations_paid stays 0, no crash', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_legacy',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
              // No overage item — legacy single-item subscription
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'standard' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.values).toContain('standard');
    expect(updateAcct!.values).toContain(0); // locations_paid = 0 for legacy
  });

  it('maps basic base price → tier "basic" with no overage item', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_basic',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_basic_test' }, quantity: 1 },
              // Basic has no overage item
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'basic' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.values).toContain('basic');
    expect(updateAcct!.values).toContain(0);
  });

  it('unknown base price ID (account exists, non-trialing) → warns and skips tier update', async () => {
    // FIX 3: tier resolution is no longer an early-return gate BEFORE the account
    // lookup. An unmapped base price for an existing, non-trialing account still
    // loads + matches the account (so a trial COULD convert), then skips only the
    // tier/locations sync. Provide the account row + lock so the realistic path
    // runs; the contract (no tier UPDATE, 200) is unchanged.
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_unknown',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          status: 'active',
          items: {
            data: [
              { price: { id: 'price_unknown_tier' }, quantity: 1 },
            ],
          },
        },
      },
    });

    // 1. account SELECT FOR UPDATE (active, not trialing → no conversion)
    sqlReturnQueue.push([{
      id: TEST_ACCOUNT_ID,
      subscription_tier: 'standard',
      subscription_status: 'active',
      locations_paid: 0,
      locations_overage_price_cents: 2500,
      stripe_subscription_id: TEST_SUBSCRIPTION_ID,
      active_offboarding_subscription_id: null,
    }]);
    // 2. pg_advisory_xact_lock — then the handler hits the unmapped-tier skip.
    sqlReturnQueue.push([]);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    // No accounts tier UPDATE should fire for unknown price
    const updateAcct = sqlCalls.filter(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && !c.text.includes('inbound_events'),
    );
    expect(updateAcct).toEqual([]);

    const warnedText = consoleSpy.mock.calls.flat().join(' ');
    expect(warnedText).toMatch(/unmapped base price/);

    consoleSpy.mockRestore();
  });

  it('grandfathered legacy-priced overage item (rotated env) keeps locations_paid synced — even when it sorts before the base item', async () => {
    // After an overage price rotation, the item's price ID is no longer in the
    // env set. The shared matcher recognizes it by the account's STORED cents;
    // the base item is resolved positively (price -> tier), so legacy-first
    // ordering cannot mis-pick the overage item as base and skip the sync.
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_gf',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_legacy_overage_rotated', unit_amount: 2500, metadata: {} }, quantity: 4 },
              { price: { id: 'price_standard_test', unit_amount: 7900, metadata: {} }, quantity: 1 },
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'standard', locationsPaid: 1, overagePriceCents: 2500 });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
    expect(updateAcct).toBeDefined();
    // locations_paid must be the legacy item's quantity (4), not zeroed.
    expect(updateAcct!.values).toContain(4);
  });

  it('missing customer → warns and skips', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_no_cust',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: null,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
            ],
          },
        },
      },
    });

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    const warnedText = consoleSpy.mock.calls.flat().join(' ');
    expect(warnedText).toMatch(/missing customer/);

    consoleSpy.mockRestore();
  });

  it('uses advisory lock before updating account (VAL-BILLING-062)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_lock',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
              { price: { id: 'price_standard_overage_test' }, quantity: 2 },
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({ tier: 'standard' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const lockIdx = sqlCalls.findIndex((c) => c.text.includes('pg_advisory_xact_lock'));
    const updateIdx = sqlCalls.findIndex(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && !c.text.includes('inbound_events'),
    );

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(lockIdx);
  });

  it('writes NO audit row on a true no-op (same tier, same locations_paid)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_noop',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
              { price: { id: 'price_standard_overage_test' }, quantity: 2 },
            ],
          },
        },
      },
    });

    // Prior tier 'standard' == computed; prior locations_paid 2 == overage qty 2.
    queueSubscriptionUpdated({ tier: 'standard', locationsPaid: 2 });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('writes a tier-only audit payload when tier changes but locations_paid does not', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_tier_only',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_premium_test' }, quantity: 1 },
              { price: { id: 'price_premium_overage_test' }, quantity: 2 },
            ],
          },
        },
      },
    });

    // Prior tier 'standard' -> 'premium'; prior locations_paid 2 == overage qty 2.
    queueSubscriptionUpdated({ tier: 'standard', locationsPaid: 2 });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    const [, input] = mockWriteAccountAuditLog.mock.calls[0]!;
    expect(input).toMatchObject({
      accountId: TEST_ACCOUNT_ID,
      eventType: 'subscription_updated',
      payload: { fromTier: 'standard', toTier: 'premium' },
    });
    expect(input.payload).not.toHaveProperty('locationsPaid');
  });

  it('writes a locations-only audit payload when locations_paid changes but tier does not', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_loc_only',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
              { price: { id: 'price_standard_overage_test' }, quantity: 5 },
            ],
          },
        },
      },
    });

    // Prior tier 'standard' == computed; prior locations_paid 2 -> overage qty 5.
    queueSubscriptionUpdated({ tier: 'standard', locationsPaid: 2 });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    const [, input] = mockWriteAccountAuditLog.mock.calls[0]!;
    expect(input).toMatchObject({
      accountId: TEST_ACCOUNT_ID,
      eventType: 'subscription_updated',
      payload: { locationsPaid: 5 },
    });
    expect(input.payload).not.toHaveProperty('fromTier');
  });

  it('writes a combined audit payload when both tier and locations_paid change', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_both',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_premium_test' }, quantity: 1 },
              { price: { id: 'price_premium_overage_test' }, quantity: 4 },
            ],
          },
        },
      },
    });

    // Prior tier 'standard' -> 'premium'; prior locations_paid 2 -> overage qty 4.
    queueSubscriptionUpdated({ tier: 'standard', locationsPaid: 2 });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    const [, input] = mockWriteAccountAuditLog.mock.calls[0]!;
    expect(input).toMatchObject({
      accountId: TEST_ACCOUNT_ID,
      eventType: 'subscription_updated',
      payload: { fromTier: 'standard', toTier: 'premium', locationsPaid: 4 },
    });
  });

  it('ignores stale old-subscription updates after reactivation/new checkout', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_stale_old_sub',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_old_cancelled',
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
              { price: { id: 'price_standard_overage_test' }, quantity: 9 },
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({
      tier: 'standard',
      stripeSubscriptionId: 'sub_new_reactivated',
      activeOffboardingSubscriptionId: null,
    });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    expect(
      sqlCalls.some((c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier')),
    ).toBe(false);
    expect(
      sqlCalls.some((c) => /\bUPDATE\s+businesses\b/.test(c.text) && c.text.includes('subscription_tier')),
    ).toBe(false);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('no-ops active offboarding subscription snapshot updates when account has a newer subscription', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_updated_active_offboarding_sub',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_old_tearing_down',
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_standard_test' }, quantity: 1 },
              { price: { id: 'price_standard_overage_test' }, quantity: 4 },
            ],
          },
        },
      },
    });

    queueSubscriptionUpdated({
      tier: 'standard',
      stripeSubscriptionId: 'sub_new_reactivated',
      activeOffboardingSubscriptionId: 'sub_old_tearing_down',
    });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    expect(
      sqlCalls.some((c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier')),
    ).toBe(false);
    expect(
      sqlCalls.some((c) => /\bUPDATE\s+businesses\b/.test(c.text) && c.text.includes('subscription_tier')),
    ).toBe(false);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});
