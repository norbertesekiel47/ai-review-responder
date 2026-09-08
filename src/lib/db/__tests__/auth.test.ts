// src/lib/db/__tests__/auth.test.ts
//
// Unit coverage for cookieBackedServerClient — the single owner of the
// read-only cookie-backed Supabase SSR adapter (previously copy-pasted into
// getCurrentUser, the since-deleted `withSession` wrapper, and the admin MFA
// gate). Pins the security-relevant wiring: getAll() returns the request
// cookies; setAll() is a no-op.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: {} })),
}));

// db/auth imports sql at module load. cookieBackedServerClient never uses it, but
// loadAppUser does — and the recorder below is what lets the identity-mapping test
// read back the exact SQL fragments and bound values postgres.js would receive.
const { sqlCalls, sqlResult } = vi.hoisted(() => ({
  sqlCalls: [] as Array<{ strings: readonly string[]; values: unknown[] }>,
  sqlResult: { rows: [] as unknown[] },
}));

vi.mock('@/lib/db/server', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ strings: [...strings], values });
    return Promise.resolve(sqlResult.rows);
  },
}));

import { cookieBackedServerClient, loadAppUser } from '../auth';
import { createServerClient } from '@supabase/ssr';

beforeEach(() => {
  vi.clearAllMocks();
  sqlCalls.length = 0;
  sqlResult.rows = [];
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-test';
});

describe('cookieBackedServerClient', () => {
  it('builds the client with the public URL/anon key and the request cookies', () => {
    const mockCreate = vi.mocked(createServerClient);
    const req = new NextRequest('https://app.example.com/api/x', {
      method: 'POST',
      headers: { cookie: 'sb-access-token=tok123' },
    });

    cookieBackedServerClient(req);

    expect(mockCreate).toHaveBeenCalledOnce();
    const [url, key, opts] = mockCreate.mock.calls[0]!;
    expect(url).toBe('https://test.supabase.co');
    expect(key).toBe('anon-key-test');

    const cookies = (opts as any).cookies.getAll();
    expect(cookies).toContainEqual(
      expect.objectContaining({ name: 'sb-access-token', value: 'tok123' }),
    );
  });

  it('uses a no-op setAll (route handlers cannot mutate request cookies)', () => {
    const mockCreate = vi.mocked(createServerClient);
    cookieBackedServerClient(
      new NextRequest('https://app.example.com/api/x', { method: 'POST' }),
    );

    const [, , opts] = mockCreate.mock.calls[0]!;
    expect(() => (opts as any).cookies.setAll([{ name: 'x', value: 'y' }])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadAppUser — the Supabase-Auth-identity → users-row mapper (#1183)
// ---------------------------------------------------------------------------
//
// Extracted from getCurrentUser so the Admin transport seam can map a BEARER
// identity without importing @/lib/db/server (invariant #15): this file is the
// composition root that owns the singleton, and the seam takes the authUserId.
//
// The column this binds is invariant #8 in one line — users.auth_id maps to the
// Supabase Auth identity, and users.id does NOT. A transposition here would hand
// an attacker whichever users row happens to carry the auth id as its PRIMARY key,
// so the assertion below is deliberately about WHICH COLUMN the parameter lands
// against, not about the query text containing the right words somewhere.

/**
 * The SQL fragment sitting immediately before `values[i]` in the tagged template —
 * i.e. the text postgres.js would splice the i-th placeholder into.
 */
function fragmentBinding(call: { strings: readonly string[]; values: unknown[] }, index: number) {
  return call.strings[index] ?? '';
}

describe('loadAppUser', () => {
  const ROW = {
    id: 'user-1',
    name: 'Root',
    email: 'root@example.com',
    role: 'admin',
    account_id: null,
    primary_location_id: null,
  };

  it('identity mapping uses users.auth_id, never users.id', async () => {
    sqlResult.rows = [ROW];

    await loadAppUser('auth-abc');

    expect(sqlCalls).toHaveLength(1);
    const call = sqlCalls[0]!;
    const index = call.values.indexOf('auth-abc');

    // Exactly one bound value, and it is the auth id.
    expect(call.values).toEqual(['auth-abc']);
    expect(index).toBe(0);

    // The fragment the placeholder is spliced into must END with the auth_id
    // predicate. "contains u.auth_id" is NOT enough — see the counterexample below.
    expect(fragmentBinding(call, index).trimEnd()).toMatch(/\bu\.auth_id\s*=$/);

    // KNOWN LIMITATION, recorded so the next author is not left guessing: this
    // asserts SQL TEXT, so a behaviour-preserving reformat of the query (a line
    // break before `=`, an alias rename) turns it red even though nothing broke.
    // When that happens the ASSERTION needs updating, not the query. The stronger
    // proof — a live-DB row where one user's `id` equals another's `auth_id` —
    // was deliberately not taken: it flips this branch to `db_touching` and adds a
    // gate row that SKIPs loudly without `TEST_DATABASE_POOL_URL`, trading a
    // deterministic offline check for a usually-absent one.
    //
    // The counterexample, carried here so the assertion's own strength is pinned:
    // a query that SELECTs auth_id but FILTERS on id satisfies a "contains" check
    // while binding the wrong column, and must NOT satisfy the assertion above.
    const wrong = 'SELECT u.id, u.auth_id FROM users u WHERE u.id = ';
    expect(wrong).toContain('u.auth_id');
    expect(wrong.trimEnd()).not.toMatch(/\bu\.auth_id\s*=$/);
  });

  it('maps the row onto AppUser and returns null when there is none', async () => {
    sqlResult.rows = [ROW];
    await expect(loadAppUser('auth-abc')).resolves.toEqual({
      id: 'user-1',
      name: 'Root',
      email: 'root@example.com',
      role: 'admin',
      accountId: null,
      locationId: null,
    });

    sqlResult.rows = [];
    await expect(loadAppUser('auth-abc')).resolves.toBeNull();
  });
});
