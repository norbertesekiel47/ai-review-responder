import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * Stripe price reverse-map completeness (VAL-BILLING-055) across all 7 price IDs.
 * Cross-cutting over the subscription-updated mapping path.
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
  TEST_CUSTOMER_ID,
  TEST_SUBSCRIPTION_ID,
} from './helpers/stripe-webhook-harness';
import { handleStripeWebhook } from '../stripe';

const restoreStripeWebhookEnv = installStripeWebhookEnv();
afterAll(restoreStripeWebhookEnv);

beforeEach(() => {
  resetStripeWebhookMocks();
});

describe('Stripe reverse-map includes all 7 price IDs (VAL-BILLING-055)', () => {
  const basePriceTestCases = [
    { priceId: 'price_basic_test', expectedTier: 'basic' },
    { priceId: 'price_founders_test', expectedTier: 'founders' },
    { priceId: 'price_standard_test', expectedTier: 'standard' },
    { priceId: 'price_premium_test', expectedTier: 'premium' },
  ];

  for (const tc of basePriceTestCases) {
    it(`maps base price ${tc.priceId} → tier "${tc.expectedTier}"`, async () => {
      sqlReturnQueue.length = 0;
      sqlCalls.length = 0;
      mockConstructEvent.mockReturnValue({
        id: `evt_reverse_map_${tc.expectedTier}`,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: TEST_SUBSCRIPTION_ID,
            customer: TEST_CUSTOMER_ID,
            items: {
              data: [
                { price: { id: tc.priceId }, quantity: 1 },
              ],
            },
          },
        },
      });

      queueSubscriptionUpdated({ tier: tc.expectedTier });

      const { status, send } = mkReply();
      await handleStripeWebhook(mkRequest(), { status, send } as any);

      expect(status).toHaveBeenCalledWith(200);

      const updateAcct = sqlCalls.find(
        (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
      );
      expect(updateAcct).toBeDefined();
      expect(updateAcct!.values).toContain(tc.expectedTier);
    });
  }

  const overageTestCases = [
    { basePriceId: 'price_standard_test', overagePriceId: 'price_standard_overage_test', overageQty: 4, expectedTier: 'standard' },
    { basePriceId: 'price_premium_test', overagePriceId: 'price_premium_overage_test', overageQty: 7, expectedTier: 'premium' },
    { basePriceId: 'price_founders_test', overagePriceId: 'price_founders_overage_test', overageQty: 3, expectedTier: 'founders' },
  ];

  for (const tc of overageTestCases) {
    it(`overage price ${tc.overagePriceId} → locations_paid=${tc.overageQty} for ${tc.expectedTier}`, async () => {
      sqlReturnQueue.length = 0;
      sqlCalls.length = 0;
      mockConstructEvent.mockReturnValue({
        id: `evt_overage_${tc.expectedTier}`,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: TEST_SUBSCRIPTION_ID,
            customer: TEST_CUSTOMER_ID,
            items: {
              data: [
                { price: { id: tc.basePriceId }, quantity: 1 },
                { price: { id: tc.overagePriceId }, quantity: tc.overageQty },
              ],
            },
          },
        },
      });

      queueSubscriptionUpdated({ tier: tc.expectedTier });

      const { status, send } = mkReply();
      await handleStripeWebhook(mkRequest(), { status, send } as any);

      expect(status).toHaveBeenCalledWith(200);

      // Use a specific pattern to avoid matching "SELECT ... FOR UPDATE"
      const updateAcct = sqlCalls.find(
        (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
      );
      expect(updateAcct).toBeDefined();
      expect(updateAcct!.values).toContain(tc.expectedTier);
      expect(updateAcct!.values).toContain(tc.overageQty);
    });
  }
});
