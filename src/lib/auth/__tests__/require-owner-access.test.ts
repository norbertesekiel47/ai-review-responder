// src/lib/auth/__tests__/require-owner-access.test.ts
//
// TDD assertions for the refactored requireOwnerAccess() function.
// Validation contract: VAL-AUTH-023.
//
// requireOwnerAccess() returns { accountId, currentLocationId, role } instead
// of the old { authId, businessId, email }. It reads users.account_id (not
// users.business_id, which was dropped in migration 034).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock state ───────────────────────────────────────────────────────

const { mockGetUser } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
}));

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
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

vi.mock('@/lib/db/server', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      return mockSql(strings, values);
    },
    { unsafe: vi.fn() },
  ),
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('requireOwnerAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: auth user is authenticated
    mockGetUser.mockResolvedValue({
      data: { user: { id: AUTH_ID, email: EMAIL } },
      error: null,
    });

    // Default: user is an active owner
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join('?');
      // First query: resolve user role + account_id + subscription_status
      if (query.includes('u.role') || query.includes('account_id')) {
        return Promise.resolve([
          { role: 'owner', account_id: ACCOUNT_ID, subscription_status: 'active', email: EMAIL },
        ]);
      }
      return Promise.resolve([]);
    });

    // Default: getRequestScope returns the primary location
    mockGetRequestScope.mockResolvedValue({
      accountId: ACCOUNT_ID,
      currentLocationId: LOCATION_ID,
    });
  });

  it('returns { accountId, currentLocationId, role } — not old { authId, businessId, email }', async () => {
    const result = await requireOwnerAccess();

    expect(result).toHaveProperty('accountId');
    expect(result).toHaveProperty('currentLocationId');
    expect(result).toHaveProperty('role');
    expect(result).not.toHaveProperty('businessId');
    expect(result).not.toHaveProperty('authId');
  });

  it('accountId is typed as AccountId brand', async () => {
    const result = await requireOwnerAccess();
    // Runtime it's a string; the brand is compile-time only
    expect(typeof result.accountId).toBe('string');
    expect(result.accountId).toBe(ACCOUNT_ID);
  });

  it('currentLocationId is typed as LocationId brand', async () => {
    const result = await requireOwnerAccess();
    expect(typeof result.currentLocationId).toBe('string');
    expect(result.currentLocationId).toBe(LOCATION_ID);
  });

  it('role is "owner" for authenticated owner users', async () => {
    const result = await requireOwnerAccess();
    expect(result.role).toBe('owner');
  });

  it('delegates to getRequestScope for location resolution', async () => {
    await requireOwnerAccess();

    expect(mockGetRequestScope).toHaveBeenCalledWith(ACCOUNT_ID, null);
  });

  it('redirects when no auth session exists', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const { redirect } = await import('next/navigation');
    await expect(requireOwnerAccess()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/admin/login');
  });

  it('redirects when no users row matches auth_id', async () => {
    mockSql.mockImplementation(() => Promise.resolve([]));

    const { redirect } = await import('next/navigation');
    await expect(requireOwnerAccess()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/admin/login');
  });

  it('redirects when role is not owner', async () => {
    mockSql.mockImplementation(() =>
      Promise.resolve([{ role: 'admin', account_id: ACCOUNT_ID, subscription_status: 'active', email: EMAIL }]),
    );

    const { redirect } = await import('next/navigation');
    await expect(requireOwnerAccess()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/admin/overview');
  });

  it('redirects sales_partner to owner login instead of admin overview', async () => {
    mockSql.mockImplementation(() =>
      Promise.resolve([
        { role: 'sales_partner', account_id: ACCOUNT_ID, subscription_status: 'active', email: EMAIL },
      ]),
    );

    const { redirect } = await import('next/navigation');
    await expect(requireOwnerAccess()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/login');
  });

  it('redirects when subscription_status is not active', async () => {
    mockSql.mockImplementation(() =>
      Promise.resolve([{ role: 'owner', account_id: ACCOUNT_ID, subscription_status: 'pending_payment', email: EMAIL }]),
    );

    const { redirect } = await import('next/navigation');
    await expect(requireOwnerAccess()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith('/onboarding/pay');
  });

  it('reads users.account_id instead of users.business_id', async () => {
    await requireOwnerAccess();

    // The SQL query should reference account_id, not business_id
    const sqlCall = mockSql.mock.calls[0]!;
    const queryString = sqlCall[0].join('');
    expect(queryString).toContain('account_id');
    expect(queryString).not.toContain('u.business_id');
  });
});
