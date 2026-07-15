// src/lib/accounts/__tests__/repo.test.ts
//
// TDD assertions for src/lib/accounts/repo.ts.
// Tests: getAccountById, getAccountOwnerUserId.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

// repo.ts is born-injected (sql is a parameter, A+ campaign PR 2b), so
// @/lib/db/server no longer needs mocking here — the fragment-aware
// createMockSql harness stands in for `sql` directly.

import { getAccountById, getAccountOwnerUser, getAccountOwnerUserId } from '../repo';

// ── Helpers ─────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OWNER_USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';

function mkAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    owner_user_id: OWNER_USER_ID,
    display_name: 'Test Account',
    subscription_tier: 'copilot',
    subscription_status: 'active',
    stripe_customer_id: 'cus_test123' as string | null,
    stripe_subscription_id: 'sub_test123' as string | null,
    trial_ends_at: null as Date | null,
    subscription_activated_at: new Date('2026-01-01'),
    locations_included: 1,
    locations_paid: 0,
    locations_overage_price_cents: 2500,
    base_price_cents: 7900,
    flags: {} as Record<string, unknown>,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
    ...overrides,
  };
}

// ── Test setup ───────────────────────────────────────────────────────────────

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
});

// ── getAccountById ──────────────────────────────────────────────────────────

describe('getAccountById', () => {
  it('returns account when it exists', async () => {
    const accountRow = mkAccountRow();
    harness.sqlReturnQueue.push([accountRow]);

    const result = await getAccountById(mockSql, ACCOUNT_ID);

    expect(result).toBeDefined();
    expect(result!.id).toBe(ACCOUNT_ID);
    expect(result!.owner_user_id).toBe(OWNER_USER_ID);
    expect(result!.subscription_tier).toBe('copilot');
    expect(result!.subscription_status).toBe('active');
    expect(result!.locations_included).toBe(1);
    expect(result!.locations_paid).toBe(0);
    expect(result!.base_price_cents).toBe(7900);
  });

  it('returns null when account does not exist', async () => {
    harness.sqlReturnQueue.push([]);

    const result = await getAccountById(mockSql, '00000000-0000-7f00-8000-000000000000');

    expect(result).toBeNull();
  });

  it('returns all account fields including flags', async () => {
    const accountRow = mkAccountRow({ flags: { some_flag: true } });
    harness.sqlReturnQueue.push([accountRow]);

    const result = await getAccountById(mockSql, ACCOUNT_ID);

    expect(result!.flags).toEqual({ some_flag: true });
  });

  it('queries accounts table by id', async () => {
    harness.sqlReturnQueue.push([mkAccountRow()]);

    await getAccountById(mockSql, ACCOUNT_ID);

    const call = harness.sqlCalls[0];
    expect(call).toBeDefined();
    expect(call!.text).toContain('FROM accounts');
    expect(call!.text).toContain('WHERE id =');
    expect(call!.text).toContain('base_price_cents');
  });

  it('returns account with null stripe_customer_id', async () => {
    const accountRow = mkAccountRow({
      stripe_customer_id: null,
      stripe_subscription_id: null,
    });
    harness.sqlReturnQueue.push([accountRow]);

    const result = await getAccountById(mockSql, ACCOUNT_ID);

    expect(result!.stripe_customer_id).toBeNull();
    expect(result!.stripe_subscription_id).toBeNull();
  });

  it('returns an Autopilot account snapshot', async () => {
    const accountRow = mkAccountRow({
      subscription_tier: 'autopilot',
      locations_included: 1,
      locations_overage_price_cents: 2000,
    });
    harness.sqlReturnQueue.push([accountRow]);

    const result = await getAccountById(mockSql, ACCOUNT_ID);

    expect(result!.subscription_tier).toBe('autopilot');
    expect(result!.locations_included).toBe(1);
    expect(result!.locations_overage_price_cents).toBe(2000);
  });

  it('fails closed when a raw account row has an unsupported tier', async () => {
    harness.sqlReturnQueue.push([mkAccountRow({ subscription_tier: 'retired_tier' })]);

    await expect(getAccountById(mockSql, ACCOUNT_ID)).rejects.toThrow(
      'invalid_ws8_subscription_tier:retired_tier',
    );
    expect(harness.sqlCalls).toHaveLength(1);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });
});

// ── getAccountOwnerUserId ───────────────────────────────────────────────────

describe('getAccountOwnerUserId', () => {
  it('returns owner_user_id when account exists', async () => {
    harness.sqlReturnQueue.push([{ owner_user_id: OWNER_USER_ID }]);

    const result = await getAccountOwnerUserId(mockSql, ACCOUNT_ID);

    expect(result).toBe(OWNER_USER_ID);
  });

  it('returns null when account does not exist', async () => {
    harness.sqlReturnQueue.push([]);

    const result = await getAccountOwnerUserId(mockSql, '00000000-0000-7f00-8000-000000000000');

    expect(result).toBeNull();
  });

  it('queries only the owner_user_id column', async () => {
    harness.sqlReturnQueue.push([{ owner_user_id: OWNER_USER_ID }]);

    await getAccountOwnerUserId(mockSql, ACCOUNT_ID);

    const call = harness.sqlCalls[0];
    expect(call).toBeDefined();
    expect(call!.text).toContain('owner_user_id');
    expect(call!.text).toContain('FROM accounts');
  });
});

describe('getAccountOwnerUser', () => {
  it('returns owner identity when account owner exists', async () => {
    harness.sqlReturnQueue.push([{
      id: OWNER_USER_ID,
      name: 'Test Owner',
      email: 'owner@test.com',
    }]);

    const result = await getAccountOwnerUser(mockSql, ACCOUNT_ID);

    expect(result).toEqual({
      id: OWNER_USER_ID,
      name: 'Test Owner',
      email: 'owner@test.com',
    });
  });

  it('returns null when account owner does not exist', async () => {
    harness.sqlReturnQueue.push([]);

    const result = await getAccountOwnerUser(mockSql, '00000000-0000-7f00-8000-000000000000');

    expect(result).toBeNull();
  });

  it('joins accounts to users by owner_user_id', async () => {
    harness.sqlReturnQueue.push([{ id: OWNER_USER_ID, name: 'Test Owner', email: 'owner@test.com' }]);

    await getAccountOwnerUser(mockSql, ACCOUNT_ID);

    const call = harness.sqlCalls[0];
    expect(call).toBeDefined();
    expect(call!.text).toContain('FROM accounts');
    expect(call!.text).toContain('JOIN users');
    expect(call!.text).toContain('owner_user_id');
  });
});
