// P8: the three Stripe calls inside applyTierChangeInTx run while two pg
// advisory locks + FOR UPDATE are held. They must carry an explicit short
// per-call bound (timeout: 8000, maxNetworkRetries: 0) so a slow provider
// cannot pin the locked transaction open. These tests assert that bound reaches
// every under-lock Stripe request without disturbing the idempotency keys.

import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';

const {
  mockAssertTierPurchasable,
  mockSubscriptionsRetrieve,
  mockSubscriptionItemsUpdate,
  mockSubscriptionItemsCreate,
  mockSubscriptionItemsDel,
} = vi.hoisted(() => ({
  mockAssertTierPurchasable: vi.fn(),
  mockSubscriptionsRetrieve: vi.fn(),
  mockSubscriptionItemsUpdate: vi.fn(),
  mockSubscriptionItemsCreate: vi.fn(),
  mockSubscriptionItemsDel: vi.fn(),
}));

vi.mock('@/lib/payments/tier-purchasability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/tier-purchasability')>()),
  assertTierPurchasable: mockAssertTierPurchasable,
}));

vi.mock('@/lib/payments/stripe-client', () => ({
  getStripe: () => ({
    subscriptions: { retrieve: mockSubscriptionsRetrieve },
    subscriptionItems: {
      update: mockSubscriptionItemsUpdate,
      create: mockSubscriptionItemsCreate,
      del: mockSubscriptionItemsDel,
    },
  }),
}));

import { applyTierChange } from '../tier-change';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OWNER_ID = '11111111-2222-3333-4444-555555555555';
const SUBSCRIPTION_ID = 'sub_ws8';
const BASE_ITEM_ID = 'si_base';
const OVERAGE_ITEM_ID = 'si_overage';

const EXPECTED_BOUND = { timeout: 8000, maxNetworkRetries: 0 } as const;

let harness: MockSqlHarness;
let sql: Sql;

function account(overrides: Record<string, unknown> = {}) {
  return {
    owner_user_id: OWNER_ID,
    price_variant: 'list',
    stripe_subscription_id: SUBSCRIPTION_ID,
    subscription_status: 'active',
    subscription_tier: 'copilot',
    locations_overage_price_cents: 1500,
    ...overrides,
  };
}

function baseItem(priceId: string, metadata: Record<string, string> = {}) {
  return { id: BASE_ITEM_ID, quantity: 1, metadata, price: { id: priceId, metadata: {} } };
}

function overageItem(priceId: string, quantity = 1) {
  return {
    id: OVERAGE_ITEM_ID,
    quantity,
    metadata: { billing_role: 'overage' },
    price: { id: priceId, metadata: {} },
  };
}

function subscription(items: unknown[]) {
  return { id: SUBSCRIPTION_ID, items: { data: items } };
}

function queueApply(accountRow: Record<string, unknown>, activeLocations?: number) {
  harness.sqlReturnQueue.push(
    mkTaggedResult([]),
    mkTaggedResult([]),
    mkTaggedResult([{ id: ACCOUNT_ID }]),
    [accountRow],
    [],
  );
  if (activeLocations !== undefined) harness.sqlReturnQueue.push([{ count: activeLocations }]);
}

function queueBusinessMirrorSync(tier = 'autopilot', status = 'active') {
  harness.sqlReturnQueue.push(
    mkTaggedResult([{ id: 'business-1' }]),
    mkTaggedResult([{}]),
    mkTaggedResult([{ subscription_tier: tier, subscription_status: status }]),
    mkTaggedResult([{}]),
  );
}

function queueExecution(accountRow: Record<string, unknown>, activeLocations: number) {
  queueApply(accountRow, activeLocations);
  harness.sqlReturnQueue.push(mkTaggedResult([{ id: ACCOUNT_ID }]), []);
  harness.sqlReturnQueue.push(mkTaggedResult([{}]));
  queueBusinessMirrorSync();
}

/** RequestOptions is always the LAST arg the SDK method receives. */
function lastArgOf(mock: ReturnType<typeof vi.fn>, callIndex: number): Record<string, unknown> {
  const call = mock.mock.calls[callIndex]!;
  return call[call.length - 1] as Record<string, unknown>;
}

beforeEach(() => {
  harness = createMockSql();
  sql = harness.mockSql as unknown as Sql;
  vi.clearAllMocks();
  mockAssertTierPurchasable.mockImplementation(() => undefined);
  mockSubscriptionsRetrieve.mockReset();
  mockSubscriptionItemsUpdate.mockReset();
  mockSubscriptionItemsCreate.mockReset();
  mockSubscriptionItemsDel.mockReset();
  process.env.STRIPE_PRICE_COPILOT_LIST = 'price_copilot_list';
  process.env.STRIPE_PRICE_COPILOT_FOUNDING = 'price_copilot_founding';
  process.env.STRIPE_PRICE_AUTOPILOT_LIST = 'price_autopilot_list';
  process.env.STRIPE_PRICE_AUTOPILOT_FOUNDING = 'price_autopilot_founding';
  process.env.STRIPE_PRICE_COPILOT_OVERAGE = 'price_copilot_overage';
  process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE = 'price_autopilot_overage';
});

describe('applyTierChange bounds under-lock Stripe calls', () => {
  it('overage=update: base update + overage update both carry the 8s/0-retry bound', async () => {
    queueExecution(account(), 3); // 3 active - 1 included = 2 overage units → update existing item
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem('price_copilot_list'),
      overageItem('price_copilot_overage'),
    ]));
    mockSubscriptionItemsUpdate.mockResolvedValue({});

    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'op-update',
    });

    expect(result.ok).toBe(true);
    expect(mockSubscriptionItemsUpdate).toHaveBeenCalledTimes(2);
    expect(lastArgOf(mockSubscriptionItemsUpdate, 0)).toMatchObject(EXPECTED_BOUND);
    expect(lastArgOf(mockSubscriptionItemsUpdate, 1)).toMatchObject(EXPECTED_BOUND);
  });

  it('overage=create: base update + overage create both carry the bound', async () => {
    queueExecution(account(), 5); // no existing overage item → create
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([baseItem('price_copilot_list')]));
    mockSubscriptionItemsUpdate.mockResolvedValue({});
    mockSubscriptionItemsCreate.mockResolvedValue({});

    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'op-create',
    });

    expect(result.ok).toBe(true);
    expect(lastArgOf(mockSubscriptionItemsUpdate, 0)).toMatchObject(EXPECTED_BOUND);
    expect(mockSubscriptionItemsCreate).toHaveBeenCalledTimes(1);
    expect(lastArgOf(mockSubscriptionItemsCreate, 0)).toMatchObject(EXPECTED_BOUND);
  });

  it('overage=delete: base update + overage delete both carry the bound', async () => {
    queueExecution(account({
      subscription_tier: 'autopilot',
      locations_overage_price_cents: 2000,
    }), 1); // downgrade, 1 active → 0 overage units, existing item → delete
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem('price_autopilot_list'),
      overageItem('price_autopilot_overage'),
    ]));
    mockSubscriptionItemsUpdate.mockResolvedValue({});
    mockSubscriptionItemsDel.mockResolvedValue({});

    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'copilot',
      operationKey: 'op-delete',
    });

    expect(result.ok).toBe(true);
    expect(lastArgOf(mockSubscriptionItemsUpdate, 0)).toMatchObject(EXPECTED_BOUND);
    expect(mockSubscriptionItemsDel).toHaveBeenCalledTimes(1);
    expect(lastArgOf(mockSubscriptionItemsDel, 0)).toMatchObject(EXPECTED_BOUND);
  });

  it('overage=none: base update carries the bound and no overage call is made', async () => {
    queueExecution(account(), 1); // 1 active → 0 overage units, no existing item → none
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([baseItem('price_copilot_list')]));
    mockSubscriptionItemsUpdate.mockResolvedValue({});

    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'op-none',
    });

    expect(result.ok).toBe(true);
    expect(mockSubscriptionItemsUpdate).toHaveBeenCalledTimes(1);
    expect(lastArgOf(mockSubscriptionItemsUpdate, 0)).toMatchObject(EXPECTED_BOUND);
    expect(mockSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsDel).not.toHaveBeenCalled();
  });

  it('subscriptions.retrieve is called with the bound and no idempotency key', async () => {
    queueExecution(account(), 3);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem('price_copilot_list'),
      overageItem('price_copilot_overage'),
    ]));
    mockSubscriptionItemsUpdate.mockResolvedValue({});

    await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'op-retrieve',
    });

    expect(mockSubscriptionsRetrieve).toHaveBeenCalledTimes(1);
    const options = lastArgOf(mockSubscriptionsRetrieve, 0);
    expect(options).toMatchObject(EXPECTED_BOUND);
    // GET request: no idempotency key on a read.
    expect(options).not.toHaveProperty('idempotencyKey');
  });

  it('preserves the exact per-step idempotency keys alongside the bound', async () => {
    queueExecution(account(), 5); // update base + create overage
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([baseItem('price_copilot_list')]));
    mockSubscriptionItemsUpdate.mockResolvedValue({});
    mockSubscriptionItemsCreate.mockResolvedValue({});

    await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'op-keys',
    });

    expect(lastArgOf(mockSubscriptionItemsUpdate, 0).idempotencyKey).toBe(
      `tier-change:${ACCOUNT_ID}:op-keys:base`,
    );
    expect(lastArgOf(mockSubscriptionItemsCreate, 0).idempotencyKey).toBe(
      `tier-change:${ACCOUNT_ID}:op-keys:overage-create`,
    );
  });

  it('preserves the overage-update idempotency key alongside the bound', async () => {
    queueExecution(account(), 3);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem('price_copilot_list'),
      overageItem('price_copilot_overage'),
    ]));
    mockSubscriptionItemsUpdate.mockResolvedValue({});

    await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'op-upd-key',
    });

    expect(lastArgOf(mockSubscriptionItemsUpdate, 1).idempotencyKey).toBe(
      `tier-change:${ACCOUNT_ID}:op-upd-key:overage-update`,
    );
  });

  it('preserves the overage-delete idempotency key alongside the bound', async () => {
    queueExecution(account({
      subscription_tier: 'autopilot',
      locations_overage_price_cents: 2000,
    }), 1);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem('price_autopilot_list'),
      overageItem('price_autopilot_overage'),
    ]));
    mockSubscriptionItemsUpdate.mockResolvedValue({});
    mockSubscriptionItemsDel.mockResolvedValue({});

    await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'copilot',
      operationKey: 'op-del-key',
    });

    expect(lastArgOf(mockSubscriptionItemsDel, 0).idempotencyKey).toBe(
      `tier-change:${ACCOUNT_ID}:op-del-key:overage-delete`,
    );
  });
});

describe('applyTierChange under-lock Stripe bound invariants', () => {
  it('every recorded Stripe request carries timeout=8000 and maxNetworkRetries=0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 50 }),
        fc.boolean(),
        async (activeLocations, hasOverageItem) => {
          harness.resetMockSql();
          mockSubscriptionsRetrieve.mockReset();
          mockSubscriptionItemsUpdate.mockReset();
          mockSubscriptionItemsCreate.mockReset();
          mockSubscriptionItemsDel.mockReset();
          mockSubscriptionItemsUpdate.mockResolvedValue({});
          mockSubscriptionItemsCreate.mockResolvedValue({});
          mockSubscriptionItemsDel.mockResolvedValue({});

          queueExecution(account(), activeLocations);
          const items: unknown[] = [baseItem('price_copilot_list')];
          if (hasOverageItem) items.push(overageItem('price_copilot_overage'));
          mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription(items));

          const result = await applyTierChange(sql, {
            accountId: ACCOUNT_ID,
            tier: 'autopilot',
            operationKey: `prop-${activeLocations}-${hasOverageItem}`,
          });
          expect(result.ok).toBe(true);

          const optionArgs: Record<string, unknown>[] = [];
          for (const call of mockSubscriptionsRetrieve.mock.calls) {
            optionArgs.push(call[call.length - 1] as Record<string, unknown>);
          }
          for (const mock of [
            mockSubscriptionItemsUpdate,
            mockSubscriptionItemsCreate,
            mockSubscriptionItemsDel,
          ]) {
            for (const call of mock.mock.calls) {
              optionArgs.push(call[call.length - 1] as Record<string, unknown>);
            }
          }

          // retrieve + base update always run; overage adds 0 or 1 more.
          expect(optionArgs.length).toBeGreaterThanOrEqual(2);
          for (const options of optionArgs) {
            expect(options.timeout).toBe(8000);
            expect(options.maxNetworkRetries).toBe(0);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
