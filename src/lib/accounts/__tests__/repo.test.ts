// src/lib/accounts/__tests__/repo.test.ts
//
// TDD assertions for src/lib/accounts/repo.ts.
// Tests: getAccountById, getAccountOwnerUserId.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock for sql ────────────────────────────────────────────────

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

import { getAccountById, getAccountOwnerUser, getAccountOwnerUserId } from '../repo';

// ── Helpers ─────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OWNER_USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';

function mkAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    owner_user_id: OWNER_USER_ID,
    display_name: 'Test Account',
    subscription_tier: 'standard',
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

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
});

// ── getAccountById ──────────────────────────────────────────────────────────

describe('getAccountById', () => {
  it('returns account when it exists', async () => {
    const accountRow = mkAccountRow();
    mockSql.mockResolvedValueOnce([accountRow]);

    const result = await getAccountById(ACCOUNT_ID);

    expect(result).toBeDefined();
    expect(result!.id).toBe(ACCOUNT_ID);
    expect(result!.owner_user_id).toBe(OWNER_USER_ID);
    expect(result!.subscription_tier).toBe('standard');
    expect(result!.subscription_status).toBe('active');
    expect(result!.locations_included).toBe(1);
    expect(result!.locations_paid).toBe(0);
    expect(result!.base_price_cents).toBe(7900);
  });

  it('returns null when account does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await getAccountById('00000000-0000-7f00-8000-000000000000');

    expect(result).toBeNull();
  });

  it('returns all account fields including flags', async () => {
    const accountRow = mkAccountRow({ flags: { some_flag: true } });
    mockSql.mockResolvedValueOnce([accountRow]);

    const result = await getAccountById(ACCOUNT_ID);

    expect(result!.flags).toEqual({ some_flag: true });
  });

  it('queries accounts table by id', async () => {
    mockSql.mockResolvedValueOnce([mkAccountRow()]);

    await getAccountById(ACCOUNT_ID);

    const call = mockSql.mock.calls[0];
    const template = (call![0] as TemplateStringsArray).join('?');
    expect(template).toContain('FROM accounts');
    expect(template).toContain('WHERE id =');
    expect(template).toContain('base_price_cents');
  });

  it('returns account with null stripe_customer_id', async () => {
    const accountRow = mkAccountRow({
      stripe_customer_id: null,
      stripe_subscription_id: null,
    });
    mockSql.mockResolvedValueOnce([accountRow]);

    const result = await getAccountById(ACCOUNT_ID);

    expect(result!.stripe_customer_id).toBeNull();
    expect(result!.stripe_subscription_id).toBeNull();
  });

  it('returns account with premium tier', async () => {
    const accountRow = mkAccountRow({
      subscription_tier: 'premium',
      locations_included: 5,
      locations_overage_price_cents: 2000,
    });
    mockSql.mockResolvedValueOnce([accountRow]);

    const result = await getAccountById(ACCOUNT_ID);

    expect(result!.subscription_tier).toBe('premium');
    expect(result!.locations_included).toBe(5);
    expect(result!.locations_overage_price_cents).toBe(2000);
  });
});

// ── getAccountOwnerUserId ───────────────────────────────────────────────────

describe('getAccountOwnerUserId', () => {
  it('returns owner_user_id when account exists', async () => {
    mockSql.mockResolvedValueOnce([{ owner_user_id: OWNER_USER_ID }]);

    const result = await getAccountOwnerUserId(ACCOUNT_ID);

    expect(result).toBe(OWNER_USER_ID);
  });

  it('returns null when account does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await getAccountOwnerUserId('00000000-0000-7f00-8000-000000000000');

    expect(result).toBeNull();
  });

  it('queries only the owner_user_id column', async () => {
    mockSql.mockResolvedValueOnce([{ owner_user_id: OWNER_USER_ID }]);

    await getAccountOwnerUserId(ACCOUNT_ID);

    const call = mockSql.mock.calls[0];
    const template = (call![0] as TemplateStringsArray).join('?');
    expect(template).toContain('owner_user_id');
    expect(template).toContain('FROM accounts');
  });
});

describe('getAccountOwnerUser', () => {
  it('returns owner identity when account owner exists', async () => {
    mockSql.mockResolvedValueOnce([{
      id: OWNER_USER_ID,
      name: 'Test Owner',
      email: 'owner@test.com',
    }]);

    const result = await getAccountOwnerUser(ACCOUNT_ID);

    expect(result).toEqual({
      id: OWNER_USER_ID,
      name: 'Test Owner',
      email: 'owner@test.com',
    });
  });

  it('returns null when account owner does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await getAccountOwnerUser('00000000-0000-7f00-8000-000000000000');

    expect(result).toBeNull();
  });

  it('joins accounts to users by owner_user_id', async () => {
    mockSql.mockResolvedValueOnce([{ id: OWNER_USER_ID, name: 'Test Owner', email: 'owner@test.com' }]);

    await getAccountOwnerUser(ACCOUNT_ID);

    const call = mockSql.mock.calls[0];
    const template = (call![0] as TemplateStringsArray).join('?');
    expect(template).toContain('FROM accounts');
    expect(template).toContain('JOIN users');
    expect(template).toContain('owner_user_id');
  });
});
