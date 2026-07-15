// worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts
//
// TDD assertions for UpdateStripeOverageWorker.
// Validation contract: VAL-BILLING-071, VAL-LOC-010, VAL-LOC-011, VAL-LOC-012.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { createMockSql, mkTaggedResult, type MockSqlHarness } from '../../../__tests__/helpers/mock-sql';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockStripeSubscriptionsRetrieve,
  mockStripeSubscriptionItemsUpdate,
  mockStripeSubscriptionItemsCreate,
  mockStripeSubscriptionItemsDel,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockRecordOutboxTransientError,
  mockCaptureMessage,
} = vi.hoisted(() => ({
  mockStripeSubscriptionsRetrieve: vi.fn(),
  mockStripeSubscriptionItemsUpdate: vi.fn(),
  mockStripeSubscriptionItemsCreate: vi.fn(),
  mockStripeSubscriptionItemsDel: vi.fn(),
  mockMarkOutboxCompleted: vi.fn(),
  mockMarkOutboxFailed: vi.fn(),
  mockRecordOutboxTransientError: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  recordOutboxTransientError: mockRecordOutboxTransientError,
  extractOutboxHandle: vi.fn((data: { outbox_id?: string; outbox_attempt?: number }, jobId: string) => ({
    outboxId: data.outbox_id ?? jobId,
    attempt: data.outbox_attempt ?? 1,
  })),
}));

vi.mock('stripe', () => {
  return {
    default: class FakeStripe {
      subscriptions = {
        retrieve: mockStripeSubscriptionsRetrieve,
      };
      subscriptionItems = {
        update: mockStripeSubscriptionItemsUpdate,
        create: mockStripeSubscriptionItemsCreate,
        del: mockStripeSubscriptionItemsDel,
      };
    },
  };
});

vi.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
  captureException: vi.fn(),
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_PRICE_COPILOT_LIST = 'price_copilot';
process.env.STRIPE_PRICE_COPILOT_FOUNDING = 'price_copilot_founding';
process.env.STRIPE_PRICE_AUTOPILOT_LIST = 'price_autopilot';
process.env.STRIPE_PRICE_AUTOPILOT_FOUNDING = 'price_autopilot_founding';
process.env.STRIPE_PRICE_COPILOT_OVERAGE = 'price_copilot_overage';
process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE = 'price_autopilot_overage';

import {
  handleUpdateStripeOverage,
  type UpdateStripeOveragePayload,
} from '../UpdateStripeOverageWorker';

// ── Helpers ────────────────────────────────────────────────────────────────

function mockJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    data: {
      account_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      correlation_id: 'corr-1',
      outbox_id: 'outbox-1',
      outbox_attempt: 1,
      ...overrides,
    },
  } as unknown as Job<UpdateStripeOveragePayload>;
}

function mockAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    subscription_tier: 'copilot',
    subscription_status: 'active',
    price_variant: 'list',
    stripe_customer_id: 'cus_test',
    stripe_subscription_id: 'sub_test',
    locations_included: 1,
    locations_overage_price_cents: 1500,
    ...overrides,
  };
}

// handleUpdateStripeOverage is born-injected (sql is a leading parameter), so
// no @/lib/db/server module mocking is needed — the fragment-aware
// createMockSql harness (shared with other worker suites) stands in for
// `sql` directly (same convention as src/lib/payments/__tests__/plan-activation.test.ts).
//
// For any given control-flow path the handler issues its Postgres queries in
// a FIXED order inside sql.begin: billing advisory lock, account row FOR UPDATE,
// then — only for a valid entitled account — the live businesses COUNT(*).
let harness: MockSqlHarness;
let mockSql: Sql;

function queueAccountRow(overrides: Record<string, unknown> = {}) {
  harness.sqlReturnQueue.push(mkTaggedResult([])); // billing advisory lock
  harness.sqlReturnQueue.push(mkTaggedResult([mockAccountRow(overrides)]));
}

function queueNoAccount() {
  harness.sqlReturnQueue.push(mkTaggedResult([])); // billing advisory lock
  harness.sqlReturnQueue.push(mkTaggedResult([]));
}

/** Queues the live location COUNT(*) after lock + account row. */
function queueOverageTx(locationCount: number) {
  harness.sqlReturnQueue.push(mkTaggedResult([{ count: locationCount }])); // COUNT(*) FROM businesses
}

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
  mockStripeSubscriptionsRetrieve.mockReset();
  mockStripeSubscriptionItemsUpdate.mockReset();
  mockStripeSubscriptionItemsCreate.mockReset();
  mockStripeSubscriptionItemsDel.mockReset();
  mockMarkOutboxCompleted.mockReset();
  mockMarkOutboxFailed.mockReset();
  mockRecordOutboxTransientError.mockReset();
  mockCaptureMessage.mockReset();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('UpdateStripeOverageWorker', () => {
  // VAL-LOC-010: Calls stripe.subscriptionItems.update with proration
  it('updates existing overage item with correct quantity and proration', async () => {
    const overageItemId = 'si_overage_123';
    queueAccountRow();
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          {
            id: overageItemId,
            price: { id: 'price_copilot_overage', unit_amount: 1500 },
            quantity: 1,
          },
        ],
      },
    });

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith(
      overageItemId,
      {
        quantity: 2, // 3 locations - 1 included = 2 overage
        proration_behavior: 'create_prorations',
        metadata: { billing_role: 'overage' },
      },
      {
        idempotencyKey: 'stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_overage_123:2:outbox:outbox-1:corr:corr-1',
      },
    );
    expect(mockStripeSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
    expect(harness.sqlCalls).toHaveLength(3);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  // VAL-LOC-011: Computes overage quantity from active location count
  it('computes overage quantity from active locations minus included', async () => {
    queueAccountRow({ locations_included: 5, subscription_tier: 'autopilot' });
    queueOverageTx(7); // 7 locations

    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_autopilot' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_autopilot_overage' }, quantity: 1 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith(
      'si_overage',
      expect.objectContaining({
        quantity: 2, // 7 - 5 = 2
      }),
      expect.objectContaining({
        idempotencyKey: 'stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_overage:2:outbox:outbox-1:corr:corr-1',
      }),
    );
    expect(harness.sqlCalls).toHaveLength(3);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('deletes existing Copilot overage item when custom included quota covers active locations', async () => {
    queueAccountRow({ locations_included: 3, subscription_tier: 'copilot' });
    queueOverageTx(3); // 3 active, 3 included

    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          { id: 'si_custom_overage', price: { id: 'price_copilot_overage' }, quantity: 2 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionItemsDel).toHaveBeenCalledWith(
      'si_custom_overage',
      {},
      {
        idempotencyKey: 'stripe-overage-delete:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_custom_overage:0:outbox:outbox-1:corr:corr-1',
      },
    );
    expect(mockStripeSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockStripeSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
    expect(harness.sqlCalls).toHaveLength(3);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('creates Copilot overage quantity from active locations minus custom included quota', async () => {
    queueAccountRow({ locations_included: 3, subscription_tier: 'copilot' });
    queueOverageTx(5); // 5 active, 3 included

    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          // No overage item
        ],
      },
    });

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: 'sub_test',
        price: 'price_copilot_overage',
        quantity: 2,
        proration_behavior: 'create_prorations',
      }),
      {
        idempotencyKey: 'stripe-overage-create:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:sub_test:price_copilot_overage:2:outbox:outbox-1:corr:corr-1',
      },
    );
    expect(mockStripeSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockStripeSubscriptionItemsDel).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
  });

  // VAL-LOC-012: Deletes overage item when locations fit in included quota
  it('deletes existing overage item when all locations fit in included quota', async () => {
    queueAccountRow({ locations_included: 5, subscription_tier: 'autopilot' });
    queueOverageTx(3); // 3 locations, 5 included

    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_autopilot' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_autopilot_overage' }, quantity: 2 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionItemsDel).toHaveBeenCalledWith(
      'si_overage',
      {},
      {
        idempotencyKey: 'stripe-overage-delete:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_overage:0:outbox:outbox-1:corr:corr-1',
      },
    );
    expect(mockStripeSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockStripeSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
  });

  // VAL-BILLING-071: Creates overage subscription item when none exists
  it('creates overage subscription item when none exists on the subscription', async () => {
    queueAccountRow();
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          // No overage item
        ],
      },
    });

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: 'sub_test',
        price: 'price_copilot_overage',
        quantity: 2, // 3 - 1 = 2
        proration_behavior: 'create_prorations',
      }),
      {
        idempotencyKey: 'stripe-overage-create:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:sub_test:price_copilot_overage:2:outbox:outbox-1:corr:corr-1',
      },
    );
    expect(mockStripeSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
  });

  it.each([
    ['copilot', 'list', 'price_copilot', 'price_copilot_overage'],
    ['copilot', 'founding', 'price_copilot_founding', 'price_copilot_overage'],
    ['autopilot', 'list', 'price_autopilot', 'price_autopilot_overage'],
    ['autopilot', 'founding', 'price_autopilot_founding', 'price_autopilot_overage'],
  ] as const)(
    'trialing %s/%s preserves a compatible existing overage Price',
    async (tier, variant, basePriceId, overagePriceId) => {
      queueAccountRow({
        subscription_tier: tier,
        price_variant: variant,
        subscription_status: 'trialing',
        locations_overage_price_cents: tier === 'copilot' ? 1500 : 2000,
      });
      queueOverageTx(2);
      mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
        items: {
          data: [
            { id: 'si_base', price: { id: basePriceId }, quantity: 1 },
            {
              id: 'si_existing_overage',
              price: {
                id: overagePriceId,
                unit_amount: tier === 'copilot' ? 1500 : 2000,
              },
              quantity: 7,
            },
          ],
        },
      });

      await handleUpdateStripeOverage(mockSql, mockJob());

      expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith(
        'si_existing_overage',
        expect.objectContaining({
          quantity: 1,
        }),
        expect.objectContaining({
          idempotencyKey:
            `stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:`
            + 'si_existing_overage:1:outbox:outbox-1:corr:corr-1',
        }),
      );
      expect(mockStripeSubscriptionItemsUpdate.mock.calls[0]?.[1]).not.toHaveProperty('price');
      expect(mockStripeSubscriptionItemsCreate).not.toHaveBeenCalled();
      expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
      expect(harness.sqlCalls).toHaveLength(3);
      expect(harness.sqlReturnQueue).toHaveLength(0);
    },
  );

  // A rotated-out historical Price that still matches the stored account cents
  // is the account's immutable billing contract; config rotation cannot reprice it.
  it('preserves a historical compatible Price across operator config rotation', async () => {
    queueAccountRow({
      locations_included: 1,
      locations_overage_price_cents: 3000,
    });
    queueOverageTx(3); // 3 active, 1 included → quantity 2

    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          // Legacy/rotated overage price: not the configured Price, matched by stored unit-amount.
          { id: 'si_leg', price: { id: 'price_legacy_overage', unit_amount: 3000 }, quantity: 1 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith(
      'si_leg',
      expect.objectContaining({
        quantity: 2,
      }),
      expect.objectContaining({
        idempotencyKey:
          'stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_leg:2:outbox:outbox-1:corr:corr-1',
      }),
    );
    expect(mockStripeSubscriptionItemsUpdate.mock.calls[0]?.[1]).not.toHaveProperty('price');
    expect(mockStripeSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
    expect(harness.sqlCalls).toHaveLength(3);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('re-prices a trusted historical item whose unit amount conflicts with the stored snapshot', async () => {
    queueAccountRow({
      locations_overage_price_cents: 1500,
    });
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          {
            id: 'si_incompatible',
            metadata: { billing_role: 'overage' },
            price: { id: 'price_historical_wrong_amount', unit_amount: 1400 },
            quantity: 1,
          },
        ],
      },
    });

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith(
      'si_incompatible',
      {
        price: 'price_copilot_overage',
        quantity: 2,
        proration_behavior: 'create_prorations',
        metadata: { billing_role: 'overage' },
      },
      {
        idempotencyKey:
          'stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_incompatible:price_copilot_overage:2:outbox:outbox-1:corr:corr-1',
      },
    );
    expect(harness.sqlCalls).toHaveLength(3);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('re-prices a stale Copilot item to Autopilot under the locked account snapshot', async () => {
    queueAccountRow({
      subscription_tier: 'autopilot',
      price_variant: 'founding',
      locations_overage_price_cents: 2000,
    });
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockResolvedValue({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_autopilot_founding' }, quantity: 1 },
          {
            id: 'si_stale_copilot_overage',
            price: { id: 'price_copilot_overage', unit_amount: 1500 },
            quantity: 1,
          },
        ],
      },
    });

    await handleUpdateStripeOverage(mockSql, mockJob());

    queueAccountRow({
      subscription_tier: 'autopilot',
      price_variant: 'founding',
      locations_overage_price_cents: 2000,
    });
    queueOverageTx(3);
    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledTimes(2);
    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenNthCalledWith(
      1,
      'si_stale_copilot_overage',
      {
        price: 'price_autopilot_overage',
        quantity: 2,
        proration_behavior: 'create_prorations',
        metadata: { billing_role: 'overage' },
      },
      {
        idempotencyKey:
          'stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_stale_copilot_overage:price_autopilot_overage:2:outbox:outbox-1:corr:corr-1',
      },
    );
    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenNthCalledWith(
      2,
      'si_stale_copilot_overage',
      expect.objectContaining({ price: 'price_autopilot_overage', quantity: 2 }),
      expect.objectContaining({
        idempotencyKey:
          'stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_stale_copilot_overage:price_autopilot_overage:2:outbox:outbox-1:corr:corr-1',
      }),
    );
    expect(mockStripeSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
    expect(harness.sqlCalls).toHaveLength(6);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('skips when account has no Stripe subscription', async () => {
    queueAccountRow({ stripe_subscription_id: null });

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
  });

  it('skips when subscription is not active', async () => {
    queueAccountRow({ subscription_status: 'cancelled' });

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
  });

  it('fails closed for a legacy Basic tier instead of silently skipping overage', async () => {
    queueAccountRow({ subscription_tier: 'basic' });

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-1',
      'Unknown tier: basic',
      1,
    );
  });

  it('marks outbox failed when account not found', async () => {
    queueNoAccount();

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-1',
      expect.stringContaining('Account not found'),
      1,
    );
  });

  it('marks outbox failed when Stripe API throws', async () => {
    queueAccountRow();
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockRejectedValueOnce(
      new Error('Stripe rate limit'),
    );

    await expect(handleUpdateStripeOverage(mockSql, mockJob())).rejects.toThrow('Stripe rate limit');
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-1',
      'Stripe rate limit',
      1,
    );
  });

  // VAL-LOC-050: Worker is retry-safe / idempotent
  it('calling worker twice with same account produces same overage quantity (idempotent)', async () => {
    const overageItemId = 'si_overage_idem';
    // Same account state (3 locations) both calls.
    queueAccountRow();
    queueOverageTx(3);

    mockStripeSubscriptionsRetrieve.mockResolvedValue({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          { id: overageItemId, price: { id: 'price_copilot_overage' }, quantity: 1 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith(
      overageItemId,
      {
        quantity: 2,
        proration_behavior: 'create_prorations',
        metadata: { billing_role: 'overage' },
      },
      {
        idempotencyKey: 'stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_overage_idem:2:outbox:outbox-1:corr:corr-1',
      },
    );

    // Second call (same account, same state)
    mockStripeSubscriptionItemsUpdate.mockClear();
    mockMarkOutboxCompleted.mockClear();
    queueAccountRow();
    queueOverageTx(3);

    await handleUpdateStripeOverage(mockSql, mockJob());

    // Same overage quantity computed from same location count
    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith(
      overageItemId,
      {
        quantity: 2,
        proration_behavior: 'create_prorations',
        metadata: { billing_role: 'overage' },
      },
      {
        idempotencyKey: 'stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_overage_idem:2:outbox:outbox-1:corr:corr-1',
      },
    );
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-1', 1);
    expect(harness.sqlCalls).toHaveLength(6);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('uses different idempotency keys for different outbox jobs with the same target quantity', async () => {
    mockStripeSubscriptionsRetrieve.mockResolvedValue({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          { id: 'si_overage_repeat', price: { id: 'price_copilot_overage' }, quantity: 0 },
        ],
      },
    });

    queueAccountRow();
    queueOverageTx(2);
    await handleUpdateStripeOverage(mockSql, mockJob({
      outbox_id: 'outbox-add-2',
      correlation_id: 'corr-add-2',
    }));

    queueAccountRow();
    queueOverageTx(2);
    await handleUpdateStripeOverage(mockSql, mockJob({
      outbox_id: 'outbox-add-3',
      correlation_id: 'corr-add-3',
    }));

    const firstKey = mockStripeSubscriptionItemsUpdate.mock.calls[0]?.[2]?.idempotencyKey;
    const secondKey = mockStripeSubscriptionItemsUpdate.mock.calls[1]?.[2]?.idempotencyKey;

    expect(firstKey).toBe(
      'stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_overage_repeat:1:outbox:outbox-add-2:corr:corr-add-2',
    );
    expect(secondKey).toBe(
      'stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_overage_repeat:1:outbox:outbox-add-3:corr:corr-add-3',
    );
    expect(firstKey).not.toBe(secondKey);
  });

  it('acquires the billing lock before the account FOR UPDATE read', async () => {
    queueAccountRow();
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_copilot_overage' }, quantity: 1 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockSql, mockJob());

    const lockIndex = harness.sqlCalls.findIndex((call) =>
      call.text.includes('pg_advisory_xact_lock'),
    );
    const accountIndex = harness.sqlCalls.findIndex((call) =>
      /FROM\s+accounts/i.test(call.text),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(accountIndex).toBeGreaterThan(lockIndex);
    expect(harness.sqlCalls[accountIndex]!.text).toMatch(/\bFOR\s+UPDATE\b/i);
    expect(harness.sqlCalls).toHaveLength(3);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  // ── Transient/terminal outbox semantics (mirrors #255) ────────────────────
  // Transient Stripe failures must leave the outbox row 'dispatched' (BullMQ
  // retries + 1h watchdog re-dispatches) — markOutboxFailed forfeits the
  // watchdog. Terminal failures must markOutboxFailed (deterministic, never
  // heals on retry).

  function subscriptionWithOverageItem() {
    return {
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_copilot_overage' }, quantity: 1 },
        ],
      },
    };
  }

  it('TRANSIENT: a Stripe rate-limit error leaves the outbox row dispatched (no markOutboxFailed)', async () => {
    queueAccountRow();
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce(subscriptionWithOverageItem());
    mockStripeSubscriptionItemsUpdate.mockRejectedValueOnce(
      Object.assign(new Error('Too many requests'), { type: 'StripeRateLimitError', statusCode: 429 }),
    );

    await expect(handleUpdateStripeOverage(mockSql, mockJob())).rejects.toThrow('Too many requests');
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    // Observability without status change: the real Stripe error lands on the
    // row's last_error while it stays 'dispatched' for the watchdog.
    expect(mockRecordOutboxTransientError).toHaveBeenCalledWith(
      mockSql,
      'outbox-1',
      expect.stringContaining('Too many requests'),
      1,
    );
  });

  it('TERMINAL: a 400 idempotency_error marks the outbox row failed', async () => {
    queueAccountRow();
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce(subscriptionWithOverageItem());
    mockStripeSubscriptionItemsUpdate.mockRejectedValueOnce(
      Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), {
        type: 'StripeInvalidRequestError',
        code: 'idempotency_error',
        statusCode: 400,
      }),
    );

    await expect(handleUpdateStripeOverage(mockSql, mockJob())).rejects.toThrow();
    expect(mockMarkOutboxFailed).toHaveBeenCalled();
  });

  it('TRANSIENT: a 409 in-flight idempotency conflict leaves the outbox row dispatched (no markOutboxFailed)', async () => {
    queueAccountRow();
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce(subscriptionWithOverageItem());
    mockStripeSubscriptionItemsUpdate.mockRejectedValueOnce(
      Object.assign(new Error('A request with this idempotency key is already in progress'), {
        type: 'StripeIdempotencyError',
        statusCode: 409,
      }),
    );

    await expect(handleUpdateStripeOverage(mockSql, mockJob())).rejects.toThrow();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('TRANSIENT: a 5xx Stripe server error leaves the outbox row dispatched (no markOutboxFailed)', async () => {
    queueAccountRow();
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockRejectedValueOnce(
      Object.assign(new Error('Service unavailable'), { statusCode: 503 }),
    );

    await expect(handleUpdateStripeOverage(mockSql, mockJob())).rejects.toThrow();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('TERMINAL: a StripeAuthenticationError marks the outbox row failed', async () => {
    queueAccountRow();
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockRejectedValueOnce(
      Object.assign(new Error('Invalid API key'), { type: 'StripeAuthenticationError', statusCode: 401 }),
    );

    await expect(handleUpdateStripeOverage(mockSql, mockJob())).rejects.toThrow();
    expect(mockMarkOutboxFailed).toHaveBeenCalled();
  });

  it('idempotency keys stay operation-scoped (per-outbox) so a delete→re-add yields a fresh key', async () => {
    queueAccountRow();
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce(subscriptionWithOverageItem());

    await handleUpdateStripeOverage(mockSql, mockJob());

    const options = mockStripeSubscriptionItemsUpdate.mock.calls[0]?.[2];
    expect(options?.idempotencyKey).toContain('outbox:outbox-1');
  });
});

describe('UpdateStripeOverageWorker — confidence gate + outbox isolation', () => {
  it('AMBIGUOUS: a descriptor-only (keyword) match never mutates Stripe; outbox failed with ambiguous_overage_item', async () => {
    // Quantity computes to 0 (1 active location, 1 included) — on a fuzzy match
    // this would have DELETED the add-on before the confidence gate existed.
    queueAccountRow();
    queueOverageTx(1);
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          {
            id: 'si_addon',
            price: { id: 'price_support', nickname: 'Priority Support Add-on', unit_amount: 9900, metadata: {} },
            quantity: 1,
          },
        ],
      },
    });

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionItemsDel).not.toHaveBeenCalled();
    expect(mockStripeSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockStripeSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      mockSql,
      'outbox-1',
      expect.stringContaining('ambiguous_overage_item'),
      1,
    );
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('ambiguous'),
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({
          feature: 'stripe_overage',
          account_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          drift_type: 'ambiguous_overage_item',
        }),
      }),
    );
  });

  it('CREATE stamps metadata.billing_role=overage so the item is exactly matchable after any price rotation', async () => {
    queueAccountRow();
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: { data: [{ id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 }] },
    });

    await handleUpdateStripeOverage(mockSql, mockJob());

    expect(mockStripeSubscriptionItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { billing_role: 'overage' } }),
      expect.anything(),
    );
  });

  it('TERMINAL errors throw UnrecoverableError so BullMQ does not re-run a deterministic failure', async () => {
    queueAccountRow();
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_copilot_overage' }, quantity: 1 },
        ],
      },
    });
    mockStripeSubscriptionItemsUpdate.mockRejectedValueOnce(
      Object.assign(new Error('key reused with different params'), {
        type: 'StripeInvalidRequestError',
        statusCode: 400,
        code: 'idempotency_error',
      }),
    );

    await expect(handleUpdateStripeOverage(mockSql, mockJob())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mockMarkOutboxFailed).toHaveBeenCalled();
  });

  it('a transient DB error on markOutboxCompleted after a SUCCESSFUL Stripe mutation never reaches the classifier (no markOutboxFailed, original error propagates)', async () => {
    queueAccountRow();
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_copilot_overage' }, quantity: 1 },
        ],
      },
    });
    const dbBlip = Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' });
    mockMarkOutboxCompleted.mockRejectedValueOnce(dbBlip);

    await expect(handleUpdateStripeOverage(mockSql, mockJob())).rejects.toThrow('write CONNECTION_CLOSED');
    // The Stripe mutation succeeded; a completion blip must stay a plain job
    // failure (BullMQ retry → idempotent re-run), never a terminal outbox flip.
    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  // OVERAGE-F1: account-scoped pg_advisory_xact_lock serializes concurrent syncs
  it('serializes the overage sync under an account-scoped advisory xact lock (OVERAGE-F1)', async () => {
    queueAccountRow();
    queueOverageTx(3);
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_copilot_overage' }, quantity: 1 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockSql, mockJob({ account_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }));

    expect(harness.mockSql.begin).toHaveBeenCalled();
    // The advisory lock query must have been issued inside the tx (which is mockSql itself).
    const lockCall = harness.sqlCalls.find((call) => call.text.includes('pg_advisory_xact_lock'));
    expect(lockCall).toBeDefined();
    // Must use hashtext so the string account_id fits pg_advisory_xact_lock's bigint param.
    expect(lockCall!.text).toMatch(/hashtext/i);
  });

  it('a Postgres error during lock acquisition is transient (no markOutboxFailed)', async () => {
    queueAccountRow();
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_copilot_overage' }, quantity: 1 },
        ],
      },
    });
    // Simulate a Postgres pool/transport error thrown from inside sql.begin
    harness.mockSql.begin = vi.fn(async () => {
      throw Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
    });

    await expect(handleUpdateStripeOverage(mockSql, mockJob())).rejects.toThrow('connection terminated');
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockRecordOutboxTransientError).toHaveBeenCalled();
  });

  // FINDING A: a transient postgres.js error from the lock tx (connection-lifecycle
  // code or transient server SQLSTATE) is INFRA, not a deterministic Stripe
  // failure — it must RETRY (BullMQ + 1h watchdog), never terminal-fail the sync.
  // These codes are NOT in the Stripe RETRYABLE_NETWORK_ERROR_CODES set, so before
  // the fix they classified terminal (markOutboxFailed + UnrecoverableError).
  it.each(['57014', '57P01', 'CONNECTION_CLOSED', '08006'])(
    'a transient Postgres error (%s) during the lock tx is retried, not terminal-failed',
    async (code) => {
      queueAccountRow();
      mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
        items: {
          data: [
            { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
            { id: 'si_overage', price: { id: 'price_copilot_overage' }, quantity: 1 },
          ],
        },
      });
      harness.mockSql.begin = vi.fn(async () => {
        throw Object.assign(new Error('db blip'), { code });
      });

      await expect(handleUpdateStripeOverage(mockSql, mockJob({ account_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }))).rejects.toThrow();
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
      expect(mockRecordOutboxTransientError).toHaveBeenCalled();
    },
  );

  // FINDING B: the live location count + newQuantity must be recomputed INSIDE the
  // lock so the serialized section acts on fresh state (a pre-lock snapshot could
  // be stale under concurrent same-account syncs and overwrite a newer quantity).
  // Assert the businesses COUNT(*) query is issued AFTER the advisory-lock query,
  // i.e. inside the tx (which is mockSql itself in the test harness).
  it('recomputes the location count INSIDE the lock (count query runs after the advisory lock)', async () => {
    queueAccountRow();
    queueOverageTx(3); // 3 active locations
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_copilot' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_copilot_overage' }, quantity: 1 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockSql, mockJob());

    const lockIdx = harness.sqlCalls.findIndex((call) => call.text.includes('pg_advisory_xact_lock'));
    const countIdx = harness.sqlCalls.findIndex(
      (call) => call.text.includes('FROM') && call.text.includes('businesses') && call.text.includes('COUNT'),
    );
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(countIdx).toBeGreaterThan(lockIdx);

    // The count read (3 active − 1 included = 2) must drive the Stripe quantity.
    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith(
      'si_overage',
      expect.objectContaining({ quantity: 2 }),
      expect.anything(),
    );
  });
});
