// src/lib/db/__tests__/account-guard.test.ts
//
// TDD assertions for isAccountActive and getLocationContext.
// Validation contract: VAL-BILLING-033 through VAL-BILLING-037, VAL-BILLING-044.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

import { isAccountActive } from '../account-guard';

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
});

// ── isAccountActive ─────────────────────────────────────────────────────────

describe('isAccountActive', () => {
  // VAL-BILLING-037 — active returns true
  it('returns { active: true } for active subscription', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([
      { subscription_status: 'active' },
    ]);

    const result = await isAccountActive(accountId);

    expect(result).toEqual({ active: true });
  });

  // VAL-BILLING-034 — pending_payment returns false
  it('returns { active: false, reason: "pending_payment" } for pending_payment', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([
      { subscription_status: 'pending_payment' },
    ]);

    const result = await isAccountActive(accountId);

    expect(result).toEqual({ active: false, reason: 'pending_payment' });
  });

  // VAL-BILLING-035 — past_due returns false
  it('returns { active: false, reason: "past_due" } for past_due', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([
      { subscription_status: 'past_due' },
    ]);

    const result = await isAccountActive(accountId);

    expect(result).toEqual({ active: false, reason: 'past_due' });
  });

  // VAL-BILLING-036 — cancelled returns false
  it('returns { active: false, reason: "cancelled" } for cancelled', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([
      { subscription_status: 'cancelled' },
    ]);

    const result = await isAccountActive(accountId);

    expect(result).toEqual({ active: false, reason: 'cancelled' });
  });

  // VAL-BILLING-033 — queries accounts.subscription_status
  it('queries accounts.subscription_status (not businesses)', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([{ subscription_status: 'active' }]);

    await isAccountActive(accountId);

    // Verify the SQL template references accounts table
    const call = mockSql.mock.calls[0]!;
    const template = call[0] as TemplateStringsArray;
    const sqlText = template.join('?');
    expect(sqlText).toMatch(/FROM\s+accounts/i);
    expect(sqlText).toMatch(/subscription_status/);
    expect(sqlText).not.toMatch(/FROM\s+businesses/i);
  });

  it('returns { active: false, reason: "not_found" } when account not found', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([]); // no rows

    const result = await isAccountActive(accountId);

    expect(result).toEqual({ active: false, reason: 'not_found' });
  });
});
