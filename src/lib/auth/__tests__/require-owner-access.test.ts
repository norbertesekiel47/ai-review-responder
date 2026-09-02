// src/lib/auth/__tests__/require-owner-access.test.ts
//
// TDD assertions for the refactored requireOwnerAccess() function.
// Validation contract: VAL-AUTH-023.
//
// requireOwnerAccess() returns { accountId, currentLocationId, role } instead
// of the old { authId, businessId, email }. It reads users.account_id (not
// users.business_id, which was dropped in migration 034).
//
// requireOwnerAccess is born-injected (sql is a parameter, A+ campaign PR 2a),
// so @/lib/db/server no longer needs mocking here — the fragment-aware
// createMockSql harness stands in for `sql` directly.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

// ── Hoisted mock state ───────────────────────────────────────────────────────

const { mockGetUser } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
}));

const { mockGetRequestScope } = vi.hoisted(() => ({
  mockGetRequestScope: vi.fn(),
}));

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => ({
    getAll: vi.fn(() => []),
    get: vi.fn(() => undefined), // No rw_location_scope cookie by default
  })),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));

vi.mock('@/lib/auth/get-request-scope', () => ({
  getRequestScope: mockGetRequestScope,
}));

// ── Import AFTER mocks ───────────────────────────────────────────────────────

import { requireOwnerAccess } from '../require-owner-access';
import type { AccountId, LocationId } from '@/lib/shared/ids';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AUTH_ID = 'auth-123';
const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001' as AccountId;
const LOCATION_ID = 'b0000000-0000-0000-0000-000000000001' as LocationId;
const EMAIL = 'owner@example.com';

function defaultOwnerRow() {
  return [ownerRow({})];
}

// The LEFT JOIN row shape (RenderOwnerRow). `has_account: true` is the join hit;
// the pre-memo inner JOIN expressed a miss as "no row", which is now
// `has_account: false` — see the dedicated test below.
function ownerRow(overrides: Record<string, unknown>) {
  return {
    id: 'u-1',
    role: 'owner',
    account_id: ACCOUNT_ID,
    name: 'Owner',
    email: EMAIL,
    subscription_status: 'active',
    has_account: true,
    ...overrides,
  };
}

let harness: MockSqlHarness;
let mockSql: Sql;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('requireOwnerAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;

    // Default: auth user is authenticated
    mockGetUser.mockResolvedValue({
      data: { user: { id: AUTH_ID, email: EMAIL } },
      error: null,
    });

    // Default: getRequestScope returns the primary location
    mockGetRequestScope.mockResolvedValue({
      accountId: ACCOUNT_ID,
      currentLocationId: LOCATION_ID,
    });
  });

  it('returns { accountId, currentLocationId, role } — not old { authId, businessId, email }', async () => {
    harness.sqlReturnQueue.push(defaultOwnerRow());
    const result = await requireOwnerAccess(mockSql);

    expect(result).toHaveProperty('accountId');
    expect(result).toHaveProperty('currentLocationId');
    expect(result).toHaveProperty('role');
    expect(result).not.toHaveProperty('businessId');
    expect(result).not.toHaveProperty('authId');
  });

  it('accountId is typed as AccountId brand', async () => {
    harness.sqlReturnQueue.push(defaultOwnerRow());
    const result = await requireOwnerAccess(mockSql);
    // Runtime it's a string; the brand is compile-time only
    expect(typeof result.accountId).toBe('string');
    expect(result.accountId).toBe(ACCOUNT_ID);
  });

  it('currentLocationId is typed as LocationId brand', async () => {
    harness.sqlReturnQueue.push(defaultOwnerRow());
    const result = await requireOwnerAccess(mockSql);
    expect(typeof result.currentLocationId).toBe('string');
    expect(result.currentLocationId).toBe(LOCATION_ID);
  });

  it('role is "owner" for authenticated owner users', async () => {
    harness.sqlReturnQueue.push(defaultOwnerRow());
    const result = await requireOwnerAccess(mockSql);
    expect(result.role).toBe('owner');
  });

  it('delegates to getRequestScope for location resolution', async () => {
    harness.sqlReturnQueue.push(defaultOwnerRow());
    await requireOwnerAccess(mockSql);

    expect(mockGetRequestScope).toHaveBeenCalledWith(mockSql, ACCOUNT_ID, null);
  });

  it('redirects when no auth session exists', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const { redirect } = await import('next/navigation');
    await expect(requireOwnerAccess(mockSql)).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/admin/login');
  });

  it('redirects when no users row matches auth_id', async () => {
    harness.sqlReturnQueue.push([]);

    const { redirect } = await import('next/navigation');
    await expect(requireOwnerAccess(mockSql)).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/admin/login');
  });

  it('redirects when the users row has no matching account (former inner-JOIN miss)', async () => {
    harness.sqlReturnQueue.push([ownerRow({ account_id: null, subscription_status: null, has_account: false })]);

    const { redirect } = await import('next/navigation');
    await expect(requireOwnerAccess(mockSql)).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/admin/login');
  });

  it('redirects when role is not owner', async () => {
    harness.sqlReturnQueue.push([
      ownerRow({ role: 'admin', subscription_status: 'active' }),
    ]);

    const { redirect } = await import('next/navigation');
    await expect(requireOwnerAccess(mockSql)).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/admin/overview');
  });

  it('redirects sales_partner to owner login instead of admin overview', async () => {
    harness.sqlReturnQueue.push([
      ownerRow({ role: 'sales_partner', subscription_status: 'active' }),
    ]);

    const { redirect } = await import('next/navigation');
    await expect(requireOwnerAccess(mockSql)).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/login');
  });

  it('allows past_due owners to view read-only pages', async () => {
    harness.sqlReturnQueue.push([
      ownerRow({ role: 'owner', subscription_status: 'past_due' }),
    ]);

    const result = await requireOwnerAccess(mockSql);

    expect(result.accountId).toBe(ACCOUNT_ID);
    expect(mockGetRequestScope).toHaveBeenCalledWith(mockSql, ACCOUNT_ID, null);
  });

  it('allows trialing owners (treated like active)', async () => {
    harness.sqlReturnQueue.push([
      ownerRow({ role: 'owner', subscription_status: 'trialing' }),
    ]);

    const result = await requireOwnerAccess(mockSql);

    expect(result.accountId).toBe(ACCOUNT_ID);
    expect(mockGetRequestScope).toHaveBeenCalledWith(mockSql, ACCOUNT_ID, null);
  });

  it('redirects when subscription_status is neither active nor past_due', async () => {
    harness.sqlReturnQueue.push([
      ownerRow({ role: 'owner', subscription_status: 'pending_payment' }),
    ]);

    const { redirect } = await import('next/navigation');
    await expect(requireOwnerAccess(mockSql)).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/onboarding/pay');
  });

  it('reads users.account_id instead of users.business_id', async () => {
    harness.sqlReturnQueue.push(defaultOwnerRow());
    await requireOwnerAccess(mockSql);

    // The SQL query should reference account_id, not business_id
    const queryString = harness.sqlCalls[0]!.text;
    expect(queryString).toContain('account_id');
    expect(queryString).not.toContain('u.business_id');
    // LEFT JOIN + has_account: the layout needs the row even when it is about
    // to redirect on role, so a dangling account must not drop the row.
    expect(queryString).toContain('LEFT JOIN accounts');
    expect(queryString).toContain('has_account');
  });
});
