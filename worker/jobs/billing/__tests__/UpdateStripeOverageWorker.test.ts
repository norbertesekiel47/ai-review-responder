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
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
} = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockStripeSubscriptionsRetrieve: vi.fn(),
  mockStripeSubscriptionItemsUpdate: vi.fn(),
  mockStripeSubscriptionItemsCreate: vi.fn(),
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
  extractOutboxHandle: vi.fn(() => ({ outboxId: 'outbox-1', attempt: 1 })),
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
    );
  });

  // VAL-LOC-012: Sets quantity to 0 when locations ≤ included
  it('sets overage quantity to 0 when all locations fit in included quota', async () => {
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

    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith(
      'si_overage',
      expect.objectContaining({
        quantity: 0,
      }),
    );
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
});
