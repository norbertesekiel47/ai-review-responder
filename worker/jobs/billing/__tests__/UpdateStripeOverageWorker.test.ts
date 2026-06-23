// worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts
//
// TDD assertions for UpdateStripeOverageWorker.
// Validation contract: VAL-BILLING-071, VAL-LOC-010, VAL-LOC-011, VAL-LOC-012.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnrecoverableError } from 'bullmq';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockSql,
  mockStripeSubscriptionsRetrieve,
  mockStripeSubscriptionItemsUpdate,
  mockStripeSubscriptionItemsCreate,
  mockStripeSubscriptionItemsDel,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockRecordOutboxTransientError,
  mockCaptureMessage,
} = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockStripeSubscriptionsRetrieve: vi.fn(),
  mockStripeSubscriptionItemsUpdate: vi.fn(),
  mockStripeSubscriptionItemsCreate: vi.fn(),
  mockStripeSubscriptionItemsDel: vi.fn(),
  mockMarkOutboxCompleted: vi.fn(),
  mockMarkOutboxFailed: vi.fn(),
  mockRecordOutboxTransientError: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
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
    locations_overage_price_cents: 2500,
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
  mockRecordOutboxTransientError.mockReset();
  mockCaptureMessage.mockReset();

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
        metadata: { billing_role: 'overage' },
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

  // Grandfathering: a legacy/rotated overage price (not in the env set) matched
  // by stored unit-amount must be UPDATED in place, never duplicated by a CREATE.
  it('updates a legacy-priced overage item (not in env set) and does not create a duplicate', async () => {
    mockSql.mockReset();
    mockSql.mockResolvedValueOnce([mockAccountRow({
      locations_included: 1,
      locations_overage_price_cents: 3000,
    })]);
    mockSql.mockResolvedValueOnce([{ count: 3 }]); // 3 active, 1 included → quantity 2

    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_standard' }, quantity: 1 },
          // Legacy/rotated overage price: NOT 'price_std_overage', matched by stored unit-amount.
          { id: 'si_leg', price: { id: 'price_legacy_overage', unit_amount: 3000 }, quantity: 1 },
        ],
      },
    });

    await handleUpdateStripeOverage(mockJob());

    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalledWith(
      'si_leg',
      expect.objectContaining({ quantity: 2 }),
      expect.anything(),
    );
    // The legacy update must NOT switch the price.
    expect(mockStripeSubscriptionItemsUpdate.mock.calls[0]?.[1]).not.toHaveProperty('price');
    expect(mockStripeSubscriptionItemsCreate).not.toHaveBeenCalled();
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
      { quantity: 2, proration_behavior: 'create_prorations', metadata: { billing_role: 'overage' } },
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
      { quantity: 2, proration_behavior: 'create_prorations', metadata: { billing_role: 'overage' } },
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

  // ── Transient/terminal outbox semantics (mirrors #255) ────────────────────
  // Transient Stripe failures must leave the outbox row 'dispatched' (BullMQ
  // retries + 1h watchdog re-dispatches) — markOutboxFailed forfeits the
  // watchdog. Terminal failures must markOutboxFailed (deterministic, never
  // heals on retry).

  function subscriptionWithOverageItem() {
    return {
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_standard' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_std_overage' }, quantity: 1 },
        ],
      },
    };
  }

  it('TRANSIENT: a Stripe rate-limit error leaves the outbox row dispatched (no markOutboxFailed)', async () => {
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce(subscriptionWithOverageItem());
    mockStripeSubscriptionItemsUpdate.mockRejectedValueOnce(
      Object.assign(new Error('Too many requests'), { type: 'StripeRateLimitError', statusCode: 429 }),
    );

    await expect(handleUpdateStripeOverage(mockJob())).rejects.toThrow('Too many requests');
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    // Observability without status change: the real Stripe error lands on the
    // row's last_error while it stays 'dispatched' for the watchdog.
    expect(mockRecordOutboxTransientError).toHaveBeenCalledWith(
      'outbox-1',
      expect.stringContaining('Too many requests'),
      1,
    );
  });

  it('TERMINAL: a 400 idempotency_error marks the outbox row failed', async () => {
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce(subscriptionWithOverageItem());
    mockStripeSubscriptionItemsUpdate.mockRejectedValueOnce(
      Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), {
        type: 'StripeInvalidRequestError',
        code: 'idempotency_error',
        statusCode: 400,
      }),
    );

    await expect(handleUpdateStripeOverage(mockJob())).rejects.toThrow();
    expect(mockMarkOutboxFailed).toHaveBeenCalled();
  });

  it('TRANSIENT: a 409 in-flight idempotency conflict leaves the outbox row dispatched (no markOutboxFailed)', async () => {
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce(subscriptionWithOverageItem());
    mockStripeSubscriptionItemsUpdate.mockRejectedValueOnce(
      Object.assign(new Error('A request with this idempotency key is already in progress'), {
        type: 'StripeIdempotencyError',
        statusCode: 409,
      }),
    );

    await expect(handleUpdateStripeOverage(mockJob())).rejects.toThrow();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('TRANSIENT: a 5xx Stripe server error leaves the outbox row dispatched (no markOutboxFailed)', async () => {
    mockStripeSubscriptionsRetrieve.mockRejectedValueOnce(
      Object.assign(new Error('Service unavailable'), { statusCode: 503 }),
    );

    await expect(handleUpdateStripeOverage(mockJob())).rejects.toThrow();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('TERMINAL: a StripeAuthenticationError marks the outbox row failed', async () => {
    mockStripeSubscriptionsRetrieve.mockRejectedValueOnce(
      Object.assign(new Error('Invalid API key'), { type: 'StripeAuthenticationError', statusCode: 401 }),
    );

    await expect(handleUpdateStripeOverage(mockJob())).rejects.toThrow();
    expect(mockMarkOutboxFailed).toHaveBeenCalled();
  });

  it('idempotency keys stay operation-scoped (per-outbox) so a delete→re-add yields a fresh key', async () => {
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce(subscriptionWithOverageItem());

    await handleUpdateStripeOverage(mockJob());

    const options = mockStripeSubscriptionItemsUpdate.mock.calls[0]?.[2];
    expect(options?.idempotencyKey).toContain('outbox:outbox-1');
  });
});

describe('UpdateStripeOverageWorker — confidence gate + outbox isolation', () => {
  it('AMBIGUOUS: a descriptor-only (keyword) match never mutates Stripe; outbox failed with ambiguous_overage_item', async () => {
    // Quantity computes to 0 (1 active location, 1 included) — on a fuzzy match
    // this would have DELETED the add-on before the confidence gate existed.
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
    mockSql.mockResolvedValueOnce([mockAccountRow()]);
    mockSql.mockResolvedValueOnce([{ count: 1 }]);
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_standard' }, quantity: 1 },
          {
            id: 'si_addon',
            price: { id: 'price_support', nickname: 'Priority Support Add-on', unit_amount: 9900, metadata: {} },
            quantity: 1,
          },
        ],
      },
    });

    await handleUpdateStripeOverage(mockJob());

    expect(mockStripeSubscriptionItemsDel).not.toHaveBeenCalled();
    expect(mockStripeSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockStripeSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
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
          drift_type: 'ambiguous_overage_item',
        }),
      }),
    );
  });

  it('CREATE stamps metadata.billing_role=overage so the item is exactly matchable after any price rotation', async () => {
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: { data: [{ id: 'si_base', price: { id: 'price_standard' }, quantity: 1 }] },
    });

    await handleUpdateStripeOverage(mockJob());

    expect(mockStripeSubscriptionItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { billing_role: 'overage' } }),
      expect.anything(),
    );
  });

  it('TERMINAL errors throw UnrecoverableError so BullMQ does not re-run a deterministic failure', async () => {
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_standard' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_std_overage' }, quantity: 1 },
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

    await expect(handleUpdateStripeOverage(mockJob())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mockMarkOutboxFailed).toHaveBeenCalled();
  });

  it('a transient DB error on markOutboxCompleted after a SUCCESSFUL Stripe mutation never reaches the classifier (no markOutboxFailed, original error propagates)', async () => {
    mockStripeSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_base', price: { id: 'price_standard' }, quantity: 1 },
          { id: 'si_overage', price: { id: 'price_std_overage' }, quantity: 1 },
        ],
      },
    });
    const dbBlip = Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' });
    mockMarkOutboxCompleted.mockRejectedValueOnce(dbBlip);

    await expect(handleUpdateStripeOverage(mockJob())).rejects.toThrow('write CONNECTION_CLOSED');
    // The Stripe mutation succeeded; a completion blip must stay a plain job
    // failure (BullMQ retry → idempotent re-run), never a terminal outbox flip.
    expect(mockStripeSubscriptionItemsUpdate).toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });
});
