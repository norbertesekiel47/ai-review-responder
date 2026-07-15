// src/lib/db/__tests__/account-guard.test.ts
//
// TDD assertions for isAccountActive, getLocationContext, and
// getLocationContextForAccount (cross-account validation).
// Validation contract: VAL-BILLING-033 through VAL-BILLING-037,
// VAL-LOC-033, VAL-LOC-034, VAL-LOC-060, VAL-LOC-076, VAL-LOC-077.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';

// ── Hoisted mocks ─────────────────────────────────────────────────────────
//
// account-guard is injected (A+ campaign 2i-T6): the 3 exports take `sql` as
// their leading parameter, so the tests pass `mockSql` explicitly. The
// `vi.mock('@/lib/db/server')` below is a retained shield — the module no
// longer imports the singleton at runtime, but the mock stays as a guard
// against an accidental transitive import reconstructing the real pool.

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

import { isAccountActive, getLocationContext, getLocationContextForAccount } from '../account-guard';

// Cast the mock to the injected `sql` parameter type at each call site.
const sqlArg = mockSql as unknown as Sql;

const TEST_ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
const TEST_LOCATION_ID = '019dc366-29ce-7000-b000-000000000002';

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
});

// ── isAccountActive ─────────────────────────────────────────────────────────

describe('isAccountActive', () => {
  // VAL-BILLING-037 — active returns true
  it('returns { active: true } for active subscription', async () => {
    mockSql.mockResolvedValueOnce([
      { subscription_status: 'active' },
    ]);

    const result = await isAccountActive(sqlArg, TEST_ACCOUNT_ID);

    expect(result).toEqual({ active: true });
  });

  // VAL-BILLING-034 — pending_payment returns false
  it('returns { active: false, reason: "pending_payment" } for pending_payment', async () => {
    mockSql.mockResolvedValueOnce([
      { subscription_status: 'pending_payment' },
    ]);

    const result = await isAccountActive(sqlArg, TEST_ACCOUNT_ID);

    expect(result).toEqual({ active: false, reason: 'pending_payment' });
  });

  // VAL-BILLING-035 — past_due returns false
  it('returns { active: false, reason: "past_due" } for past_due', async () => {
    mockSql.mockResolvedValueOnce([
      { subscription_status: 'past_due' },
    ]);

    const result = await isAccountActive(sqlArg, TEST_ACCOUNT_ID);

    expect(result).toEqual({ active: false, reason: 'past_due' });
  });

  // VAL-BILLING-036 — cancelled returns false
  it('returns { active: false, reason: "cancelled" } for cancelled', async () => {
    mockSql.mockResolvedValueOnce([
      { subscription_status: 'cancelled' },
    ]);

    const result = await isAccountActive(sqlArg, TEST_ACCOUNT_ID);

    expect(result).toEqual({ active: false, reason: 'cancelled' });
  });

  // VAL-BILLING-033 — queries accounts.subscription_status
  it('queries accounts.subscription_status (not businesses)', async () => {
    mockSql.mockResolvedValueOnce([{ subscription_status: 'active' }]);

    await isAccountActive(sqlArg, TEST_ACCOUNT_ID);

    // Verify the SQL template references accounts table
    const call = mockSql.mock.calls[0]!;
    const template = call[0] as TemplateStringsArray;
    const sqlText = template.join('?');
    expect(sqlText).toMatch(/FROM\s+accounts/i);
    expect(sqlText).toMatch(/subscription_status/);
    expect(sqlText).not.toMatch(/FROM\s+businesses/i);
  });

  it('returns { active: false, reason: "not_found" } when account not found', async () => {
    mockSql.mockResolvedValueOnce([]); // no rows

    const result = await isAccountActive(sqlArg, TEST_ACCOUNT_ID);

    expect(result).toEqual({ active: false, reason: 'not_found' });
  });
});

// ── getLocationContext ──────────────────────────────────────────────────────

describe('getLocationContext', () => {
  // VAL-LOC-033: Returns { account, location } with correct shape
  it('returns { account, location } with both rows', async () => {
    const archivedAt = null;
    mockSql.mockResolvedValueOnce([{
      account_id: TEST_ACCOUNT_ID,
      subscription_tier: 'copilot',
      subscription_status: 'active',
      stripe_customer_id: 'cus_test',
      stripe_subscription_id: 'sub_test',
      locations_included: 1,
      locations_paid: 2,
      location_id: TEST_LOCATION_ID,
      is_primary: true,
      display_label: 'Downtown Cafe',
      name: 'Downtown Cafe LLC',
      archived_at: archivedAt,
    }]);

    const result = await getLocationContext(sqlArg, TEST_LOCATION_ID);

    expect(result).not.toBeNull();
    expect(result!.account).toEqual({
      id: TEST_ACCOUNT_ID,
      subscriptionTier: 'copilot',
      subscriptionStatus: 'active',
      stripeCustomerId: 'cus_test',
      stripeSubscriptionId: 'sub_test',
      locationsIncluded: 1,
      locationsPaid: 2,
    });
    expect(result!.location).toEqual({
      id: TEST_LOCATION_ID,
      isPrimary: true,
      displayLabel: 'Downtown Cafe',
      name: 'Downtown Cafe LLC',
      archivedAt: null,
    });
  });

  // VAL-LOC-034: Returns null for archived locations
  it('returns null when location is archived (archived_at IS NOT NULL)', async () => {
    // The SQL now filters with AND b.archived_at IS NULL,
    // so archived locations return 0 rows → null
    mockSql.mockResolvedValueOnce([]);

    const result = await getLocationContext(sqlArg, TEST_LOCATION_ID);

    expect(result).toBeNull();
  });

  // VAL-LOC-076: JOIN returns the account that OWNS the location
  it('returns the account that owns the location (from the JOIN)', async () => {
    mockSql.mockResolvedValueOnce([{
      account_id: TEST_ACCOUNT_ID,
      subscription_tier: 'autopilot',
      subscription_status: 'active',
      stripe_customer_id: 'cus_owner',
      stripe_subscription_id: 'sub_owner',
      locations_included: 5,
      locations_paid: 0,
      location_id: TEST_LOCATION_ID,
      is_primary: true,
      display_label: null,
      name: 'Test Location',
      archived_at: null,
    }]);

    const result = await getLocationContext(sqlArg, TEST_LOCATION_ID);

    expect(result).not.toBeNull();
    // The account returned is the one from the JOIN (b.account_id = a.id),
    // i.e., the account that OWNS the location — not a caller's account.
    expect(result!.account.id).toBe(TEST_ACCOUNT_ID);
  });

  it('returns null when location does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await getLocationContext(sqlArg, '00000000-0000-0000-0000-000000000000');

    expect(result).toBeNull();
  });

  it('SQL query filters with archived_at IS NULL', async () => {
    mockSql.mockResolvedValueOnce([]);

    await getLocationContext(sqlArg, TEST_LOCATION_ID);

    const call = mockSql.mock.calls[0]!;
    const template = call[0] as TemplateStringsArray;
    const sqlText = template.join('?');
    // Verify the WHERE clause includes archived_at IS NULL
    expect(sqlText).toMatch(/archived_at\s+IS\s+NULL/i);
    // Verify it JOINs businesses to accounts
    expect(sqlText).toMatch(/FROM\s+businesses/i);
    expect(sqlText).toMatch(/JOIN\s+accounts/i);
  });

  it('handles display_label = NULL — falls back to name in result', async () => {
    mockSql.mockResolvedValueOnce([{
      account_id: TEST_ACCOUNT_ID,
      subscription_tier: 'copilot',
      subscription_status: 'active',
      stripe_customer_id: null,
      stripe_subscription_id: null,
      locations_included: 1,
      locations_paid: 0,
      location_id: TEST_LOCATION_ID,
      is_primary: false,
      display_label: null,
      name: 'Fallback Name',
      archived_at: null,
    }]);

    const result = await getLocationContext(sqlArg, TEST_LOCATION_ID);

    expect(result).not.toBeNull();
    expect(result!.location.displayLabel).toBeNull();
    expect(result!.location.name).toBe('Fallback Name');
  });

  it('fails closed when the joined account has an unsupported tier', async () => {
    mockSql.mockResolvedValueOnce([{
      account_id: TEST_ACCOUNT_ID,
      subscription_tier: 'retired_tier',
      subscription_status: 'active',
      stripe_customer_id: null,
      stripe_subscription_id: null,
      locations_included: 1,
      locations_paid: 0,
      location_id: TEST_LOCATION_ID,
      is_primary: true,
      display_label: null,
      name: 'Invalid Tier Location',
      archived_at: null,
    }]);

    await expect(getLocationContext(sqlArg, TEST_LOCATION_ID)).rejects.toThrow(
      'invalid_ws8_subscription_tier:retired_tier',
    );
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});

// ── getLocationContextForAccount ────────────────────────────────────────────
//
// Cross-account validation: VAL-LOC-077
// Workers that receive a job with both accountId and locationId must
// validate that the location belongs to the account. A mismatch indicates
// a stale or misrouted job and must be rejected.

describe('getLocationContextForAccount', () => {
  const OTHER_ACCOUNT_ID = '019dc366-29ce-7000-c000-000000000003';

  // Happy path: matching account + location
  it('returns context when location belongs to the given account', async () => {
    mockSql.mockResolvedValueOnce([{
      account_id: TEST_ACCOUNT_ID,
      subscription_tier: 'copilot',
      subscription_status: 'active',
      stripe_customer_id: 'cus_test',
      stripe_subscription_id: 'sub_test',
      locations_included: 1,
      locations_paid: 0,
      location_id: TEST_LOCATION_ID,
      is_primary: true,
      display_label: 'Downtown Cafe',
      name: 'Downtown Cafe LLC',
      archived_at: null,
    }]);

    const result = await getLocationContextForAccount(sqlArg, TEST_LOCATION_ID, TEST_ACCOUNT_ID);

    expect(result).not.toBeNull();
    expect(result).not.toEqual(expect.objectContaining({ kind: 'account_mismatch' }));
    // Narrow the type after asserting it's not a mismatch
    if (result && 'account' in result) {
      expect(result.account.id).toBe(TEST_ACCOUNT_ID);
      expect(result.location.id).toBe(TEST_LOCATION_ID);
    }
  });

  // VAL-LOC-077: Cross-account mismatch returns specific error
  it('returns { kind: "account_mismatch" } when location belongs to a different account', async () => {
    mockSql.mockResolvedValueOnce([{
      account_id: OTHER_ACCOUNT_ID,
      subscription_tier: 'autopilot',
      subscription_status: 'active',
      stripe_customer_id: 'cus_other',
      stripe_subscription_id: 'sub_other',
      locations_included: 5,
      locations_paid: 0,
      location_id: TEST_LOCATION_ID,
      is_primary: true,
      display_label: 'Other Location',
      name: 'Other Location LLC',
      archived_at: null,
    }]);

    const result = await getLocationContextForAccount(sqlArg, TEST_LOCATION_ID, TEST_ACCOUNT_ID);

    // The location exists (SQL returned a row) but its account_id doesn't
    // match the requested accountId → specific mismatch error
    expect(result).toEqual({ kind: 'account_mismatch', owningAccountId: OTHER_ACCOUNT_ID });
  });

  // VAL-LOC-060: Returns null for non-existent location
  it('returns null when location does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await getLocationContextForAccount(sqlArg, '00000000-0000-0000-0000-000000000000', TEST_ACCOUNT_ID);

    expect(result).toBeNull();
  });

  // Archived location returns null (same as getLocationContext)
  it('returns null for archived location', async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await getLocationContextForAccount(sqlArg, TEST_LOCATION_ID, TEST_ACCOUNT_ID);

    expect(result).toBeNull();
  });

  it('fails closed for a matching account whose stored tier is unsupported', async () => {
    mockSql.mockResolvedValueOnce([{
      account_id: TEST_ACCOUNT_ID,
      subscription_tier: 'retired_tier',
      subscription_status: 'active',
      stripe_customer_id: null,
      stripe_subscription_id: null,
      locations_included: 1,
      locations_paid: 0,
      location_id: TEST_LOCATION_ID,
      is_primary: true,
      display_label: null,
      name: 'Invalid Tier Location',
      archived_at: null,
    }]);

    await expect(getLocationContextForAccount(
      sqlArg,
      TEST_LOCATION_ID,
      TEST_ACCOUNT_ID,
    )).rejects.toThrow('invalid_ws8_subscription_tier:retired_tier');
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // SQL query validates both location_id and account_id in WHERE clause
  it('SQL query reads location with account data, validates account_id in application code', async () => {
    mockSql.mockResolvedValueOnce([]);

    await getLocationContextForAccount(sqlArg, TEST_LOCATION_ID, TEST_ACCOUNT_ID);

    const call = mockSql.mock.calls[0]!;
    const template = call[0] as TemplateStringsArray;
    const sqlText = template.join('?');
    // The SQL query joins businesses to accounts and filters by location ID
    expect(sqlText).toMatch(/b\.id/);
    expect(sqlText).toMatch(/archived_at\s+IS\s+NULL/i);
    // Account ownership is validated in application code after the query
    // (comparing row.account_id against the requested accountId)
  });
});
