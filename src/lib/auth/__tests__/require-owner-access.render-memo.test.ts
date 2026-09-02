// src/lib/auth/__tests__/require-owner-access.render-memo.test.ts
//
// Pins the render-scoped memo contract: the authenticated layout and the page
// it wraps must share ONE Supabase getUser(), ONE `users` read and ONE request
// scope resolution per render.
//
// React's `cache()` only memoises inside an RSC render (the react-server build
// keys on the request's cache dispatcher; the default node build used by
// vitest is a pass-through). So this file swaps `react.cache` for a small
// args-keyed memo that models one request scope. What the test then proves is
// the structural property that matters: BOTH callers (layout shape and page
// shape) reach the provider through the same cached functions with the same
// keys. Bypass the memo in either caller and the call counts double.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

const { mockGetUser, mockGetRequestScope } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockGetRequestScope: vi.fn(),
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  // One memo table per cached fn, keyed on the argument identities — the same
  // rule React.cache applies within a request (Object.is per argument).
  function cache<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    const table: { args: A; value: R }[] = [];
    return (...args: A) => {
      const hit = table.find(
        (e) => e.args.length === args.length && e.args.every((a, i) => Object.is(a, args[i])),
      );
      if (hit) return hit.value;
      const value = fn(...args);
      table.push({ args, value });
      return value;
    };
  }
  return { ...actual, cache };
});

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    getAll: vi.fn(() => []),
    get: vi.fn(() => undefined),
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

import {
  getRenderAuthUser,
  getRenderOwnerRow,
  getRenderRequestScope,
  requireOwnerAccess,
} from '../require-owner-access';
import type { AccountId, LocationId } from '@/lib/shared/ids';

const AUTH_ID = 'auth-123';
const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001' as AccountId;
const LOCATION_ID = 'b0000000-0000-0000-0000-000000000001' as LocationId;

let harness: MockSqlHarness;
let mockSql: Sql;

describe('render-scoped auth memo (layout + page share one fetch each)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;
    mockGetUser.mockResolvedValue({ data: { user: { id: AUTH_ID, email: 'o@x.test' } }, error: null });
    mockGetRequestScope.mockResolvedValue({
      accountId: ACCOUNT_ID,
      currentLocationId: LOCATION_ID,
      activeLocations: [],
    });
    harness.sqlReturnQueue.push([
      {
        id: 'u-1',
        role: 'owner',
        account_id: ACCOUNT_ID,
        name: 'Owner',
        email: 'o@x.test',
        subscription_status: 'active',
        has_account: true,
      },
    ]);
  });

  it('layout-shape then page-shape (requireOwnerAccess) → 1 getUser, 1 users SELECT, 1 scope', async () => {
    // What src/app/(authenticated)/layout.tsx does:
    const authUser = await getRenderAuthUser();
    const row = await getRenderOwnerRow(mockSql, authUser!.id);
    await getRenderRequestScope(mockSql, ACCOUNT_ID, null);
    expect(row?.role).toBe('owner');

    // What the page under it does:
    const access = await requireOwnerAccess(mockSql);
    expect(access.accountId).toBe(ACCOUNT_ID);

    expect(mockGetUser).toHaveBeenCalledTimes(1);
    expect(harness.sqlCalls).toHaveLength(1);
    expect(mockGetRequestScope).toHaveBeenCalledTimes(1);
  });

  it('a different auth id or cookie scope is a different key (no cross-user reuse)', async () => {
    harness.sqlReturnQueue.push([
      {
        id: 'u-2',
        role: 'owner',
        account_id: ACCOUNT_ID,
        name: 'Other',
        email: 'p@x.test',
        subscription_status: 'active',
        has_account: true,
      },
    ]);
    await getRenderOwnerRow(mockSql, AUTH_ID);
    await getRenderOwnerRow(mockSql, 'auth-456');
    await getRenderRequestScope(mockSql, ACCOUNT_ID, null);
    await getRenderRequestScope(mockSql, ACCOUNT_ID, LOCATION_ID);

    expect(harness.sqlCalls).toHaveLength(2);
    expect(mockGetRequestScope).toHaveBeenCalledTimes(2);
  });
});
