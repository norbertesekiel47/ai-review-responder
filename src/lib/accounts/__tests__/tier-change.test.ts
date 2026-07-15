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

import { applyTierChange, validateTierChange } from '../tier-change';
import {
  TIER_CHANGE_OPERATION_METADATA_KEY,
  TIER_CHANGE_SOURCE_METADATA_KEY,
} from '../tier-change';
import { TierNotPurchasableError } from '@/lib/payments/tier-purchasability';
import * as tierConfig from '../tier-config';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OWNER_ID = '11111111-2222-3333-4444-555555555555';
const SUBSCRIPTION_ID = 'sub_ws8';
const BASE_ITEM_ID = 'si_base';
const OVERAGE_ITEM_ID = 'si_overage';

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

function queuePreview(accountRow: Record<string, unknown>, activeLocations?: number) {
  harness.sqlReturnQueue.push(mkTaggedResult([]), mkTaggedResult([]), [accountRow]);
  if (activeLocations !== undefined) harness.sqlReturnQueue.push([{ count: activeLocations }]);
}

function queueApply(accountRow: Record<string, unknown>, activeLocations?: number) {
  harness.sqlReturnQueue.push(mkTaggedResult([]), mkTaggedResult([]), [accountRow], []);
  if (activeLocations !== undefined) harness.sqlReturnQueue.push([{ count: activeLocations }]);
}

function committedAudit(overrides: Partial<Record<
  | 'new_tier'
  | 'price_variant'
  | 'base_price_cents'
  | 'locations_overage_price_cents'
  | 'locations_included'
  | 'locations_paid',
  string | null
>> = {}) {
  return {
    new_tier: 'autopilot',
    price_variant: 'founding',
    base_price_cents: '4900',
    locations_overage_price_cents: '2000',
    locations_included: '1',
    locations_paid: '2',
    ...overrides,
  };
}

function queueCommitted(
  accountRow: Record<string, unknown>,
  rows: Record<string, string | null>[],
) {
  harness.sqlReturnQueue.push(mkTaggedResult([]), mkTaggedResult([]), [accountRow], rows);
}

function queueExecution(
  accountRow: Record<string, unknown>,
  activeLocations: number,
  options: { auditExists?: boolean; snapshotChanged?: boolean } = {},
) {
  queueApply(accountRow, activeLocations);
  harness.sqlReturnQueue.push(
    mkTaggedResult(options.snapshotChanged === false ? [] : [{ id: ACCOUNT_ID }]),
    mkTaggedResult([]),
    options.auditExists ? [{ id: 'existing-audit' }] : [],
  );
  if (!options.auditExists) harness.sqlReturnQueue.push(mkTaggedResult([{}]));
}

function expectEntitlementThenBillingBeforeReads(expectedCalls: number) {
  expect(harness.sqlCalls).toHaveLength(expectedCalls);
  expect(harness.sqlCalls[0]!.text).toContain('pg_advisory_xact_lock');
  expect(harness.sqlCalls[0]!.values).toEqual([`${ACCOUNT_ID}:tier_entitlement`]);
  expect(harness.sqlCalls[1]!.text).toContain('pg_advisory_xact_lock');
  expect(harness.sqlCalls[1]!.values).toEqual([`${ACCOUNT_ID}:overage_sync`]);
  expect(harness.sqlCalls[2]!.text).toMatch(/FROM\s+accounts/);
  expect(harness.sqlCalls[2]!.text).toContain('FOR UPDATE');
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

describe('validateTierChange', () => {
  it.each([
    ['list', 'autopilot', 6900, 2000],
    ['founding', 'autopilot', 4900, 2000],
    ['list', 'copilot', 2900, 1500],
    ['founding', 'copilot', 1900, 1500],
  ] as const)('uses the immutable %s variant for a %s preview', async (
    variant,
    target,
    baseCents,
    overageCents,
  ) => {
    queuePreview(account({
      price_variant: variant,
      subscription_tier: target === 'autopilot' ? 'copilot' : 'autopilot',
    }), 3);

    const result = await validateTierChange(sql, ACCOUNT_ID, target);

    expect(result).toEqual({
      allowed: true,
      newBillingPreview: {
        basePriceCents: baseCents,
        includedLocations: 1,
        overagePriceCents: overageCents,
        overageUnits: 2,
        totalCents: baseCents + 2 * overageCents,
      },
    });
    expect(mockAssertTierPurchasable).toHaveBeenCalledWith(target);
    expectEntitlementThenBillingBeforeReads(4);
    expect(harness.sqlCalls[3]!.text).toMatch(/FROM\s+businesses/);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it.each([
    [0, 0],
    [1, 0],
    [5, 4],
  ])('uses max(active locations - one, zero): %i -> %i', async (locations, units) => {
    queuePreview(account(), locations);
    const result = await validateTierChange(sql, ACCOUNT_ID, 'autopilot');
    expect(result.newBillingPreview?.overageUnits).toBe(units);
    expectEntitlementThenBillingBeforeReads(4);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('treats trialing as full access and rejects pending, past-due, and cancelled', async () => {
    queuePreview(account({ subscription_status: 'trialing' }), 1);
    await expect(validateTierChange(sql, ACCOUNT_ID, 'autopilot')).resolves.toMatchObject({ allowed: true });
    expect(harness.sqlReturnQueue).toHaveLength(0);

    for (const status of ['pending_payment', 'past_due', 'cancelled']) {
      harness.resetMockSql();
      queuePreview(account({ subscription_status: status }));
      await expect(validateTierChange(sql, ACCOUNT_ID, 'autopilot')).resolves.toEqual({
        allowed: false,
        reason: 'subscription_inactive',
      });
      expectEntitlementThenBillingBeforeReads(3);
      expect(harness.sqlReturnQueue).toHaveLength(0);
    }
  });

  it('rejects legacy/unknown targets before SQL and has no Basic location rule', async () => {
    await expect(validateTierChange(sql, ACCOUNT_ID, 'basic')).resolves.toEqual({
      allowed: false,
      reason: 'unknown_tier',
    });
    expect(mockAssertTierPurchasable).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(0);
  });

  it('rejects the same tier after locks without reading locations', async () => {
    queuePreview(account({ subscription_tier: 'autopilot' }));
    await expect(validateTierChange(sql, ACCOUNT_ID, 'autopilot')).resolves.toEqual({
      allowed: false,
      reason: 'same_tier',
    });
    expectEntitlementThenBillingBeforeReads(3);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });
});

describe('applyTierChange', () => {
  it.each([
    ['list', 'price_autopilot_list', 6900],
    ['founding', 'price_autopilot_founding', 4900],
  ] as const)('executes Autopilot with the stored %s Price and complete cents', async (
    variant,
    expectedPrice,
    expectedBaseCents,
  ) => {
    queueExecution(account({ price_variant: variant }), 3);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem(variant === 'list' ? 'price_copilot_list' : 'price_copilot_founding'),
      overageItem('price_copilot_overage'),
    ]));
    mockSubscriptionItemsUpdate.mockResolvedValue({});

    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'owner-op',
    });

    expect(result).toEqual({
      ok: true,
      newBilling: {
        basePriceCents: expectedBaseCents,
        includedLocations: 1,
        overagePriceCents: 2000,
        overageUnits: 2,
        totalCents: expectedBaseCents + 4000,
      },
    });
    expect(mockSubscriptionItemsUpdate).toHaveBeenCalledWith(
      BASE_ITEM_ID,
      {
        price: expectedPrice,
        proration_behavior: 'create_prorations',
        metadata: {
          [TIER_CHANGE_OPERATION_METADATA_KEY]: 'owner-op',
          [TIER_CHANGE_SOURCE_METADATA_KEY]: 'copilot',
        },
      },
      { idempotencyKey: `tier-change:${ACCOUNT_ID}:owner-op:base` },
    );
    expect(mockSubscriptionItemsUpdate).toHaveBeenCalledWith(
      OVERAGE_ITEM_ID,
      expect.objectContaining({
        price: 'price_autopilot_overage',
        quantity: 2,
        proration_behavior: 'create_prorations',
      }),
      { idempotencyKey: `tier-change:${ACCOUNT_ID}:owner-op:overage-update` },
    );
    expectEntitlementThenBillingBeforeReads(9);
    expect(harness.sqlCalls[3]!.text).toMatch(/FROM\s+account_audit_log/);
    expect(harness.sqlCalls[4]!.text).toMatch(/FROM\s+businesses/);
    const snapshotWrite = harness.sqlCalls[5]!;
    expect(snapshotWrite.text).toMatch(/UPDATE\s+accounts/);
    expect(snapshotWrite.values).toEqual(expect.arrayContaining([
      'autopilot', expectedBaseCents, 2000, 1, 2, ACCOUNT_ID,
    ]));
    expect(snapshotWrite.text).not.toMatch(/SET\s+price_variant/);
    expect(harness.sqlCalls[7]!.text).toMatch(/FROM\s+account_audit_log/);
    expect(harness.sqlCalls[8]!.text).toMatch(/INSERT\s+INTO\s+account_audit_log/);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('downgrades founding Autopilot to founding Copilot mid-cycle with explicit proration', async () => {
    queueExecution(account({
      price_variant: 'founding',
      subscription_tier: 'autopilot',
      locations_overage_price_cents: 2000,
    }), 1);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem('price_autopilot_founding'),
      overageItem('price_autopilot_overage'),
    ]));
    mockSubscriptionItemsUpdate.mockResolvedValueOnce({});
    mockSubscriptionItemsDel.mockResolvedValueOnce({});

    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'copilot',
      operationKey: 'downgrade-op',
    });

    expect(result).toMatchObject({
      ok: true,
      newBilling: { basePriceCents: 1900, overageUnits: 0 },
    });
    expect(mockSubscriptionItemsUpdate).toHaveBeenCalledWith(
      BASE_ITEM_ID,
      expect.objectContaining({
        price: 'price_copilot_founding',
        proration_behavior: 'create_prorations',
        metadata: {
          [TIER_CHANGE_OPERATION_METADATA_KEY]: 'downgrade-op',
          [TIER_CHANGE_SOURCE_METADATA_KEY]: 'autopilot',
        },
      }),
      { idempotencyKey: `tier-change:${ACCOUNT_ID}:downgrade-op:base` },
    );
    expect(mockSubscriptionItemsDel).toHaveBeenCalledWith(
      OVERAGE_ITEM_ID,
      {},
      { idempotencyKey: `tier-change:${ACCOUNT_ID}:downgrade-op:overage-delete` },
    );
    expect(harness.sqlCalls[5]!.values).toEqual(expect.arrayContaining([
      'copilot', 1900, 1500, 1, 0, ACCOUNT_ID,
    ]));
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('downgrades list Autopilot to list Copilot with list cents and Price', async () => {
    queueExecution(account({
      subscription_tier: 'autopilot',
      locations_overage_price_cents: 2000,
    }), 2);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem('price_autopilot_list'),
      overageItem('price_autopilot_overage'),
    ]));
    mockSubscriptionItemsUpdate.mockResolvedValue({});

    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'copilot',
      operationKey: 'list-downgrade',
    });

    expect(result).toMatchObject({
      ok: true,
      newBilling: { basePriceCents: 2900, overagePriceCents: 1500, overageUnits: 1 },
    });
    expect(mockSubscriptionItemsUpdate).toHaveBeenCalledWith(
      BASE_ITEM_ID,
      expect.objectContaining({
        price: 'price_copilot_list',
        proration_behavior: 'create_prorations',
        metadata: {
          [TIER_CHANGE_OPERATION_METADATA_KEY]: 'list-downgrade',
          [TIER_CHANGE_SOURCE_METADATA_KEY]: 'autopilot',
        },
      }),
      { idempotencyKey: `tier-change:${ACCOUNT_ID}:list-downgrade:base` },
    );
    expect(harness.sqlCalls[5]!.values).toEqual(expect.arrayContaining([
      'copilot', 2900, 1500, 1, 1, ACCOUNT_ID,
    ]));
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('executes for a trialing account through the shared full-access predicate', async () => {
    queueExecution(account({ subscription_status: 'trialing' }), 1);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([baseItem('price_copilot_list')]));
    mockSubscriptionItemsUpdate.mockResolvedValueOnce({});

    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'trial-change',
    });
    expect(result.ok).toBe(true);
    expect(mockSubscriptionItemsUpdate).toHaveBeenCalledWith(
      BASE_ITEM_ID,
      expect.objectContaining({ proration_behavior: 'create_prorations' }),
      expect.anything(),
    );
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it.each([
    account({ subscription_status: 'past_due' }),
    account({ subscription_status: 'cancelled' }),
  ])('revalidates mutable eligibility inside the locks', async (accountRow) => {
    queueApply(accountRow);
    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'fresh-reject',
    });
    expect(result).toMatchObject({ ok: false, code: 'subscription_inactive' });
    expectEntitlementThenBillingBeforeReads(4);
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('rejects a distinct operation when the account is already on the target tier', async () => {
    queueApply(account({ subscription_tier: 'autopilot' }), 2);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem('price_autopilot_list', {
        [TIER_CHANGE_OPERATION_METADATA_KEY]: 'previous-operation',
        [TIER_CHANGE_SOURCE_METADATA_KEY]: 'copilot',
      }),
      overageItem('price_autopilot_overage'),
    ]));
    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'new-distinct-operation',
    });
    expect(result).toMatchObject({ ok: false, code: 'same_tier' });
    expectEntitlementThenBillingBeforeReads(5);
    expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('recomputes quantity from locked locations instead of accepting the preview', async () => {
    queueExecution(account(), 5);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([baseItem('price_copilot_list')]));
    mockSubscriptionItemsUpdate.mockResolvedValueOnce({});
    mockSubscriptionItemsCreate.mockResolvedValueOnce({});

    await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'fresh-plan',
    });

    expect(mockSubscriptionItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: SUBSCRIPTION_ID,
        price: 'price_autopilot_overage',
        quantity: 4,
        proration_behavior: 'create_prorations',
        metadata: { billing_role: 'overage' },
      }),
      { idempotencyKey: `tier-change:${ACCOUNT_ID}:fresh-plan:overage-create` },
    );
    expect(harness.sqlCalls[5]!.values).toEqual(expect.arrayContaining([4]));
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('rechecks the gate after preview and before any fresh account/location read', async () => {
    queuePreview(account(), 1);
    await expect(validateTierChange(sql, ACCOUNT_ID, 'autopilot')).resolves.toMatchObject({ allowed: true });
    mockAssertTierPurchasable.mockImplementationOnce(() => {
      throw new TierNotPurchasableError();
    });
    queueApply(account(), undefined);

    await expect(applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'closed-gate',
    })).rejects.toBeInstanceOf(TierNotPurchasableError);

    expect(harness.sqlCalls).toHaveLength(8);
    expect(harness.sqlCalls[4]!.values).toEqual([`${ACCOUNT_ID}:tier_entitlement`]);
    expect(harness.sqlCalls[5]!.values).toEqual([`${ACCOUNT_ID}:overage_sync`]);
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('uses stable per-step keys and converges after a partial provider success', async () => {
    queueApply(account(), 2);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([baseItem('price_copilot_list')]));
    mockSubscriptionItemsUpdate.mockResolvedValueOnce({});
    mockSubscriptionItemsCreate.mockRejectedValueOnce(new Error('timeout after provider create'));

    const first = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'retry-stable',
    });
    expect(first).toMatchObject({ ok: false, code: 'tier_change_failed' });
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
    const firstBaseKey = mockSubscriptionItemsUpdate.mock.calls[0]![2];
    const firstOverageKey = mockSubscriptionItemsCreate.mock.calls[0]![1];

    harness.resetMockSql();
    queueExecution(account(), 2);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([baseItem('price_copilot_list')]));
    mockSubscriptionItemsUpdate.mockResolvedValueOnce({});
    mockSubscriptionItemsCreate.mockResolvedValueOnce({});

    const second = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'retry-stable',
    });
    expect(second.ok).toBe(true);
    expect(mockSubscriptionItemsUpdate.mock.calls[1]![2]).toEqual(firstBaseKey);
    expect(mockSubscriptionItemsCreate.mock.calls[1]![1]).toEqual(firstOverageKey);
    expectEntitlementThenBillingBeforeReads(9);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('recovers the same operation after base success, overage failure, and webhook tier projection', async () => {
    queueApply(account(), 2);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem('price_copilot_list'),
      overageItem('price_copilot_overage'),
    ]));
    mockSubscriptionItemsUpdate
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('overage timeout after base success'));

    const first = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'projected-recovery',
    });
    expect(first).toMatchObject({ ok: false, code: 'tier_change_failed' });
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
    const firstBaseOptions = mockSubscriptionItemsUpdate.mock.calls[0]![2];
    const firstOverageOptions = mockSubscriptionItemsUpdate.mock.calls[1]![2];

    harness.resetMockSql();
    queueExecution(account({
      subscription_tier: 'autopilot',
      base_price_cents: 6900,
      locations_overage_price_cents: 2000,
    }), 2);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem('price_autopilot_list', {
        [TIER_CHANGE_OPERATION_METADATA_KEY]: 'projected-recovery',
        [TIER_CHANGE_SOURCE_METADATA_KEY]: 'copilot',
      }),
      overageItem('price_copilot_overage'),
    ]));
    mockSubscriptionItemsUpdate.mockResolvedValue({});

    const recovered = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'projected-recovery',
    });
    expect(recovered.ok).toBe(true);
    expect(mockSubscriptionItemsUpdate.mock.calls[2]![2]).toEqual(firstBaseOptions);
    expect(mockSubscriptionItemsUpdate.mock.calls[3]![2]).toEqual(firstOverageOptions);
    expect(mockSubscriptionItemsUpdate.mock.calls[2]![1]).toMatchObject({
      metadata: {
        [TIER_CHANGE_OPERATION_METADATA_KEY]: 'projected-recovery',
        [TIER_CHANGE_SOURCE_METADATA_KEY]: 'copilot',
      },
    });
    expect(harness.sqlCalls[8]!.text).toMatch(/INSERT\s+INTO\s+account_audit_log/);
    const auditPayload = harness.sqlCalls[8]!.values.find(
      (value) => typeof value === 'object' && value !== null && 'idempotency_key' in value,
    );
    expect(auditPayload).toMatchObject({
      old_tier: 'copilot',
      new_tier: 'autopilot',
      idempotency_key: 'projected-recovery',
      locations_paid: 1,
    });
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('retries with the same provider keys after Stripe succeeds but the DB snapshot fails', async () => {
    queueApply(account(), 2);
    harness.sqlReturnQueue.push(Promise.reject(new Error('snapshot commit failed')));
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem('price_copilot_list'),
      overageItem('price_copilot_overage'),
    ]));
    mockSubscriptionItemsUpdate.mockResolvedValue({});

    const first = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'db-retry',
    });
    expect(first).toMatchObject({ ok: false, code: 'tier_change_failed' });
    expect(harness.sqlCalls).toHaveLength(6);
    expect(harness.sqlReturnQueue).toHaveLength(0);
    const firstBaseOptions = mockSubscriptionItemsUpdate.mock.calls[0]![2];
    const firstOverageOptions = mockSubscriptionItemsUpdate.mock.calls[1]![2];

    harness.resetMockSql();
    queueExecution(account(), 2);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem('price_autopilot_list', {
        [TIER_CHANGE_OPERATION_METADATA_KEY]: 'db-retry',
        [TIER_CHANGE_SOURCE_METADATA_KEY]: 'copilot',
      }),
      overageItem('price_autopilot_overage'),
    ]));
    mockSubscriptionItemsUpdate.mockResolvedValue({});

    const second = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'db-retry',
    });
    expect(second.ok).toBe(true);
    expect(mockSubscriptionItemsUpdate.mock.calls[2]![2]).toEqual(firstBaseOptions);
    expect(mockSubscriptionItemsUpdate.mock.calls[3]![2]).toEqual(firstOverageOptions);
    expect(harness.sqlCalls[8]!.text).toMatch(/INSERT\s+INTO\s+account_audit_log/);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('returns the original committed response before current-state planning or Stripe', async () => {
    queueCommitted(account({
      price_variant: 'founding',
      subscription_tier: 'copilot',
      subscription_status: 'cancelled',
      stripe_subscription_id: null,
      locations_overage_price_cents: 1500,
    }), [committedAudit()]);

    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'completed-operation',
    });
    expect(result).toEqual({
      ok: true,
      newBilling: {
        basePriceCents: 4900,
        includedLocations: 1,
        overagePriceCents: 2000,
        overageUnits: 2,
        totalCents: 8900,
      },
    });
    expectEntitlementThenBillingBeforeReads(4);
    expect(harness.sqlCalls.some((call) => /FROM\s+businesses/.test(call.text))).toBe(false);
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsDel).not.toHaveBeenCalled();
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('rejects reuse of a committed operation key for a different target tier', async () => {
    queueCommitted(account({
      price_variant: 'founding',
      subscription_tier: 'autopilot',
    }), [committedAudit()]);
    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'copilot',
      operationKey: 'completed-operation',
    });
    expect(result).toMatchObject({ ok: false, code: 'operation_conflict' });
    expectEntitlementThenBillingBeforeReads(4);
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('fails closed when the committed audit variant differs from the locked account', async () => {
    queueCommitted(account({ price_variant: 'list' }), [committedAudit({
      price_variant: 'founding',
    })]);
    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'variant-mismatch',
    });
    expect(result).toMatchObject({ ok: false, code: 'tier_change_failed' });
    expectEntitlementThenBillingBeforeReads(4);
    expect(harness.sqlCalls.some((call) => /FROM\s+businesses/.test(call.text))).toBe(false);
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsDel).not.toHaveBeenCalled();
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('fails closed when a committed replay finds an invalid locked account variant', async () => {
    queueCommitted(account({ price_variant: 'legacy' }), [committedAudit()]);
    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'invalid-account-variant',
    });
    expect(result).toMatchObject({ ok: false, code: 'tier_change_failed' });
    expectEntitlementThenBillingBeforeReads(4);
    expect(harness.sqlCalls.some((call) => /FROM\s+businesses/.test(call.text))).toBe(false);
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsDel).not.toHaveBeenCalled();
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it.each([
    committedAudit({ new_tier: 'premium' }),
    committedAudit({ base_price_cents: '49.00' }),
    committedAudit({ base_price_cents: '2900' }),
    committedAudit({ locations_paid: '-1' }),
  ])('fails closed on inconsistent committed audit scalars', async (auditRow) => {
    queueCommitted(account({ price_variant: 'founding' }), [auditRow]);
    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'invalid-commit',
    });
    expect(result).toMatchObject({ ok: false, code: 'tier_change_failed' });
    expectEntitlementThenBillingBeforeReads(4);
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('resolves the target snapshot exactly once and writes that same object values', async () => {
    const resolver = vi.spyOn(tierConfig, 'resolveTierSnapshot').mockReturnValueOnce({
      tier: 'autopilot',
      variant: 'founding',
      baseCents: 6123,
      overageCents: 2456,
      included: 1,
    });
    queueExecution(account({ price_variant: 'founding' }), 3);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem('price_copilot_founding'),
      overageItem('price_copilot_overage'),
    ]));
    mockSubscriptionItemsUpdate.mockResolvedValue({});

    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'single-resolver',
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      newBilling: { basePriceCents: 6123, overagePriceCents: 2456, totalCents: 11035 },
    });
    expect(harness.sqlCalls[5]!.values).toEqual(expect.arrayContaining([
      'autopilot', 6123, 2456, 1, 2, ACCOUNT_ID,
    ]));
    expect(harness.sqlReturnQueue).toHaveLength(0);
    resolver.mockRestore();
  });

  it('does not write a snapshot or audit after a terminal Stripe failure', async () => {
    queueApply(account(), 1);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([baseItem('price_copilot_list')]));
    mockSubscriptionItemsUpdate.mockRejectedValueOnce(new Error('Stripe unavailable'));

    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'stripe-fail',
    });

    expect(result).toMatchObject({ ok: false, code: 'tier_change_failed' });
    expectEntitlementThenBillingBeforeReads(5);
    expect(harness.sqlCalls.some((call) => /UPDATE\s+accounts/.test(call.text))).toBe(false);
    expect(harness.sqlCalls.filter((call) => /account_audit_log/.test(call.text))).toHaveLength(1);
    expect(harness.sqlCalls.some((call) => /INSERT\s+INTO\s+account_audit_log/.test(call.text))).toBe(false);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('fails closed on an untrusted overage match before provider mutation', async () => {
    queueApply(account(), 2);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([
      baseItem('price_copilot_list'),
      {
        id: 'si_addon',
        quantity: 1,
        metadata: {},
        price: { id: 'price_addon', nickname: 'Extra seats', metadata: {} },
      },
    ]));

    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'ambiguous',
    });
    expect(result).toMatchObject({ ok: false, code: 'ambiguous_overage_item' });
    expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsDel).not.toHaveBeenCalled();
    expectEntitlementThenBillingBeforeReads(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('fails closed when the provider subscription has no configured base item', async () => {
    queueApply(account(), 1);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(subscription([{
      id: 'si_setup',
      quantity: 1,
      metadata: {},
      price: { id: 'price_setup', metadata: {} },
    }]));
    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'no-base',
    });
    expect(result).toMatchObject({ ok: false, code: 'base_item_not_found' });
    expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsDel).not.toHaveBeenCalled();
    expectEntitlementThenBillingBeforeReads(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('requires both target Prices before retrieving or mutating Stripe', async () => {
    delete process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE;
    queueApply(account(), 2);
    const result = await applyTierChange(sql, {
      accountId: ACCOUNT_ID,
      tier: 'autopilot',
      operationKey: 'missing-config',
    });
    expect(result).toMatchObject({ ok: false, code: 'missing_price_config' });
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expectEntitlementThenBillingBeforeReads(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });
});
