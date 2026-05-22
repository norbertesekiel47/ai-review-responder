// worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts
//
// TDD assertions for UpdateStripeOverageWorker.
// Validation contract: VAL-BILLING-071, VAL-LOC-010, VAL-LOC-011, VAL-LOC-012.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockSql,
  mockStripeSubscriptionsRetrieve,
  mockStripeSubscriptionItemsUpdate,
  mockStripeSubscriptionItemsCreate,
  mockStripeSubscriptionItemsDel,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
} = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockStripeSubscriptionsRetrieve: vi.fn(),
  mockStripeSubscriptionItemsUpdate: vi.fn(),
  mockStripeSubscriptionItemsCreate: vi.fn(),
  mockStripeSubscriptionItemsDel: vi.fn(),
  mockMarkOutboxCompleted: vi.fn(),
  mockMarkOutboxFailed: vi.fn(),
}));

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
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

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_PRICE_STANDARD_OVERAGE = 'price_std_overage';
process.env.STRIPE_PRICE_PREMIUM_OVERAGE = 'price_prem_overage';
process.env.STRIPE_PRICE_FOUNDERS_OVERAGE = 'price_founders_overage';

import { handleUpdateStripeOverage } from '../UpdateStripeOverageWorker';

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
  } as any;
}

function mockAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    subscription_tier: 'standard',
    subscription_status: 'active',
    stripe_customer_id: 'cus_test',
    stripe_subscription_id: 'sub_test',
    locations_included: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockStripeSubscriptionsRetrieve.mockReset();
  mockStripeSubscriptionItemsUpdate.mockReset();
  mockStripeSubscriptionItemsCreate.mockReset();
  mockStripeSubscriptionItemsDel.mockReset();
  mockMarkOutboxCompleted.mockReset();
  mockMarkOutboxFailed.mockReset();

  // Default: account with active subscription
  mockSql.mockResolvedValueOnce([mockAccountRow()]); // account lookup
  mockSql.mockResolvedValueOnce([{ count: 3 }]); // location count
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('UpdateStripeOverageWorker', () => {
  // VAL-LOC-010: Calls stripe.subscriptionItems.update with proration
  it('updates existing overage item with correct quantity and proration', async () => {
    const overageItemId = 'si_overage_123';
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_standard' }, quantity: 1 },
          { id: overageItemId, price: { id: 'price_std_overage' }, quantity: 1 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockJob());

    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith(
      overageItemId,
      {
        quantity: 2, // 3 locations - 1 included = 2 overage
        proration_behavior: 'create_prorations',
      },
      {
        idempotencyKey: 'stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_overage_123:2:outbox:outbox-1:corr:corr-1',
      },
    );
    expect(mockStripeSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });

  // VAL-LOC-011: Computes overage quantity from active location count
  it('computes overage quantity from active locations minus included', async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([mockAccountRow({ locations_included: 5, subscription_tier: 'premium' })]);
    mockSql.mockResolvedValueOnce([{ count: 7 }]); // 7 locations

    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_premium' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_prem_overage' }, quantity: 1 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockJob());

    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith(
      'si_overage',
      expect.objectContaining({
        quantity: 2, // 7 - 5 = 2
      }),
      expect.objectContaining({
        idempotencyKey: 'stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_overage:2:outbox:outbox-1:corr:corr-1',
      }),
    );
  });

  it('deletes existing standard overage item when custom included quota covers active locations', async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([mockAccountRow({ locations_included: 3, subscription_tier: 'standard' })]);
    mockSql.mockResolvedValueOnce([{ count: 3 }]); // 3 active, 3 included

    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_standard' }, quantity: 1 },
          { id: 'si_custom_overage', price: { id: 'price_std_overage' }, quantity: 2 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockJob());

    expect(mockStripeSubscriptionItemsDel).toHaveBeenCalledWith(
      'si_custom_overage',
      {},
      {
        idempotencyKey: 'stripe-overage-delete:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_custom_overage:0:outbox:outbox-1:corr:corr-1',
      },
    );
    expect(mockStripeSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockStripeSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });

  it('creates standard overage quantity from active locations minus custom included quota', async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([mockAccountRow({ locations_included: 3, subscription_tier: 'standard' })]);
    mockSql.mockResolvedValueOnce([{ count: 5 }]); // 5 active, 3 included

    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_standard' }, quantity: 1 },
          // No overage item
        ],
      },
    });

    await handleUpdateStripeOverage(mockJob());

    expect(mockStripeSubscriptionItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: 'sub_test',
        price: 'price_std_overage',
        quantity: 2,
        proration_behavior: 'create_prorations',
      }),
      {
        idempotencyKey: 'stripe-overage-create:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:sub_test:price_std_overage:2:outbox:outbox-1:corr:corr-1',
      },
    );
    expect(mockStripeSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockStripeSubscriptionItemsDel).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });

  // VAL-LOC-012: Deletes overage item when locations fit in included quota
  it('deletes existing overage item when all locations fit in included quota', async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([mockAccountRow({ locations_included: 5, subscription_tier: 'premium' })]);
    mockSql.mockResolvedValueOnce([{ count: 3 }]); // 3 locations, 5 included

    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_premium' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_prem_overage' }, quantity: 2 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockJob());

    expect(mockStripeSubscriptionItemsDel).toHaveBeenCalledWith(
      'si_overage',
      {},
      {
        idempotencyKey: 'stripe-overage-delete:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_overage:0:outbox:outbox-1:corr:corr-1',
      },
    );
    expect(mockStripeSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockStripeSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });

  // VAL-BILLING-071: Creates overage subscription item when none exists
  it('creates overage subscription item when none exists on the subscription', async () => {
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_standard' }, quantity: 1 },
          // No overage item
        ],
      },
    });

    await handleUpdateStripeOverage(mockJob());

    expect(mockStripeSubscriptionItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: 'sub_test',
        price: 'price_std_overage',
        quantity: 2, // 3 - 1 = 2
        proration_behavior: 'create_prorations',
      }),
      {
        idempotencyKey: 'stripe-overage-create:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:sub_test:price_std_overage:2:outbox:outbox-1:corr:corr-1',
      },
    );
    expect(mockStripeSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });

  it('skips when account has no Stripe subscription', async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([mockAccountRow({ stripe_subscription_id: null })]);

    await handleUpdateStripeOverage(mockJob());

    expect(mockStripeSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });

  it('skips when subscription is not active', async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([mockAccountRow({ subscription_status: 'cancelled' })]);

    await handleUpdateStripeOverage(mockJob());

    expect(mockStripeSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });

  it('skips for basic tier (no overage allowed)', async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([mockAccountRow({ subscription_tier: 'basic' })]);
    mockSql.mockResolvedValueOnce([{ count: 1 }]);

    await handleUpdateStripeOverage(mockJob());

    expect(mockStripeSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });

  it('marks outbox failed when account not found', async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([]); // no account

    await handleUpdateStripeOverage(mockJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      'outbox-1',
      expect.stringContaining('Account not found'),
      1,
    );
  });

  it('marks outbox failed when Stripe API throws', async () => {
    mockStripeSubscriptionsRetrieve.mockRejectedValueOnce(
      new Error('Stripe rate limit'),
    );

    await expect(handleUpdateStripeOverage(mockJob())).rejects.toThrow('Stripe rate limit');
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      'outbox-1',
      'Stripe rate limit',
      1,
    );
  });

  // VAL-LOC-050: Worker is retry-safe / idempotent
  it('calling worker twice with same account produces same overage quantity (idempotent)', async () => {
    const overageItemId = 'si_overage_idem';
    mockSql.mockReset();

    // First call
    mockSql.mockResolvedValueOnce([mockAccountRow()]);
    mockSql.mockResolvedValueOnce([{ count: 3 }]); // 3 locations

    mockStripeSubscriptionsRetrieve.mockResolvedValue({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_standard' }, quantity: 1 },
          { id: overageItemId, price: { id: 'price_std_overage' }, quantity: 1 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockJob());

    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith(
      overageItemId,
      { quantity: 2, proration_behavior: 'create_prorations' },
      {
        idempotencyKey: 'stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_overage_idem:2:outbox:outbox-1:corr:corr-1',
      },
    );

    // Second call (same account, same state)
    mockStripeSubscriptionItemsUpdate.mockClear();
    mockMarkOutboxCompleted.mockClear();
    mockSql.mockResolvedValueOnce([mockAccountRow()]);
    mockSql.mockResolvedValueOnce([{ count: 3 }]);

    await handleUpdateStripeOverage(mockJob());

    // Same overage quantity computed from same location count
    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith(
      overageItemId,
      { quantity: 2, proration_behavior: 'create_prorations' },
      {
        idempotencyKey: 'stripe-overage-update:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:si_overage_idem:2:outbox:outbox-1:corr:corr-1',
      },
    );
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
  });

  it('uses different idempotency keys for different outbox jobs with the same target quantity', async () => {
    mockSql.mockReset();
    mockStripeSubscriptionsRetrieve.mockResolvedValue({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_standard' }, quantity: 1 },
          { id: 'si_overage_repeat', price: { id: 'price_std_overage' }, quantity: 0 },
        ],
      },
    });

    mockSql.mockResolvedValueOnce([mockAccountRow()]);
    mockSql.mockResolvedValueOnce([{ count: 2 }]);
    await handleUpdateStripeOverage(mockJob({
      outbox_id: 'outbox-add-2',
      correlation_id: 'corr-add-2',
    }));

    mockSql.mockResolvedValueOnce([mockAccountRow()]);
    mockSql.mockResolvedValueOnce([{ count: 2 }]);
    await handleUpdateStripeOverage(mockJob({
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

  it('does not use FOR UPDATE without a surrounding transaction', async () => {
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_standard' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_std_overage' }, quantity: 1 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockJob());

    const accountLookupSql = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(accountLookupSql).not.toMatch(/\bFOR\s+UPDATE\b/i);
  });
});
