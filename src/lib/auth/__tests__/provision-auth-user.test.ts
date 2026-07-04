// Decision-table tests for provisionAuthUser + deleteProvisionedAuthUser
// (A+ campaign PR 2a extraction from the signup route). Each `it` pins one
// branch of the original route logic — see
// src/app/api/auth/signup/route.ts history / provision-auth-user.ts doc
// comment for the branch descriptions.
//
// provisionAuthUser is born-injected (sql + supabase are parameters), so no
// module mocking is needed — the fragment-aware `createMockSql` harness
// (shared with worker suites) stands in for `sql`, and a small typed stub
// stands in for the Supabase client.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import { provisionAuthUser, deleteProvisionedAuthUser } from '../provision-auth-user';

interface SupabaseAuthStub {
  auth: {
    signUp: ReturnType<typeof vi.fn>;
    admin: {
      getUserById: ReturnType<typeof vi.fn>;
      deleteUser: ReturnType<typeof vi.fn>;
    };
  };
}

function mkSupabaseStub(): SupabaseAuthStub {
  return {
    auth: {
      signUp: vi.fn(),
      admin: {
        getUserById: vi.fn(),
        deleteUser: vi.fn(),
      },
    },
  };
}

const asSupabase = (stub: SupabaseAuthStub): SupabaseClient =>
  stub as unknown as SupabaseClient;

const ownerEmail = 'owner@example.com';
const baseInput = { ownerEmail, password: 'password123', emailRedirectTo: 'https://app.example.com/cb' };

let harness: MockSqlHarness;
let mockSql: Sql;
let supabase: SupabaseAuthStub;

beforeEach(() => {
  harness = createMockSql();
  // The fragment-aware harness mocks the tagged-template + `.begin` shape of
  // Postgres.js's `Sql` without implementing its full type surface (CLOSE,
  // END, options, …) — cast, same convention as
  // src/lib/channels/__tests__/disable-enrollment.test.ts's `tx as unknown as
  // postgres.TransactionSql`.
  mockSql = harness.mockSql as unknown as Sql;
  supabase = mkSupabaseStub();
});

describe('provisionAuthUser', () => {
  it('returns account_exists (and never calls signUp) when the advisory-locked pre-check finds an existing row', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([])); // pg_advisory_xact_lock
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'existing-uid' }])); // SELECT id FROM users

    const result = await provisionAuthUser(mockSql, asSupabase(supabase), baseInput);

    expect(result).toEqual({ ok: false, reason: 'account_exists' });
    expect(supabase.auth.signUp).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(2);
  });

  it('returns ok with the authId when signUp returns a user directly', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([])); // advisory lock
    harness.sqlReturnQueue.push(mkTaggedResult([])); // no existing user
    supabase.auth.signUp.mockResolvedValueOnce({
      data: { user: { id: 'new-auth-uuid' } },
      error: null,
    });

    const result = await provisionAuthUser(mockSql, asSupabase(supabase), baseInput);

    expect(result).toEqual({ ok: true, authId: 'new-auth-uuid' });
    expect(supabase.auth.signUp).toHaveBeenCalledWith({
      email: baseInput.ownerEmail,
      password: baseInput.password,
      options: { emailRedirectTo: baseInput.emailRedirectTo },
    });
  });

  it('recovers the authId from auth.users when signUp returns {error:null,user:null}', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([])); // advisory lock
    harness.sqlReturnQueue.push(mkTaggedResult([])); // no existing user
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: 'recovered-auth-user' }])); // auth.users recovery
    supabase.auth.signUp.mockResolvedValueOnce({ data: { user: null, session: null }, error: null });

    const result = await provisionAuthUser(mockSql, asSupabase(supabase), baseInput);

    expect(result).toEqual({ ok: true, authId: 'recovered-auth-user' });
    expect(harness.sqlCalls).toHaveLength(3);
    expect(harness.sqlCalls[2]!.text).toContain('FROM auth.users');
  });

  it('returns account_exists when signUp returns {error:null,user:null} and the recovery query finds nothing', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([])); // advisory lock
    harness.sqlReturnQueue.push(mkTaggedResult([])); // no existing user
    harness.sqlReturnQueue.push(mkTaggedResult([])); // recovery finds nothing
    supabase.auth.signUp.mockResolvedValueOnce({ data: { user: null }, error: null });

    const result = await provisionAuthUser(mockSql, asSupabase(supabase), baseInput);

    expect(result).toEqual({ ok: false, reason: 'account_exists' });
  });

  it('returns account_exists when identities:[] and admin.getUserById cannot confirm a real user', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    supabase.auth.signUp.mockResolvedValueOnce({
      data: { user: { id: 'fake-auth-user', identities: [] } },
      error: null,
    });
    supabase.auth.admin.getUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'User not found' },
    });

    const result = await provisionAuthUser(mockSql, asSupabase(supabase), baseInput);

    expect(result).toEqual({ ok: false, reason: 'account_exists' });
    expect(supabase.auth.admin.getUserById).toHaveBeenCalledWith('fake-auth-user');
  });

  it('returns ok when identities:[] but admin.getUserById confirms a real matching user', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    supabase.auth.signUp.mockResolvedValueOnce({
      data: { user: { id: 'real-auth-user', identities: [] } },
      error: null,
    });
    supabase.auth.admin.getUserById.mockResolvedValueOnce({
      data: { user: { id: 'real-auth-user', email: ownerEmail } },
      error: null,
    });

    const result = await provisionAuthUser(mockSql, asSupabase(supabase), baseInput);

    expect(result).toEqual({ ok: true, authId: 'real-auth-user' });
  });

  it('returns email_rate_limited when authError.code is over_email_send_rate_limit', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    supabase.auth.signUp.mockResolvedValueOnce({
      data: { user: null },
      error: { code: 'over_email_send_rate_limit', status: 429, message: 'rate limit' },
    });

    const result = await provisionAuthUser(mockSql, asSupabase(supabase), baseInput);

    expect(result).toEqual({ ok: false, reason: 'email_rate_limited' });
    // The recovery query must NOT run when authError is set.
    expect(harness.sqlCalls).toHaveLength(2);
  });

  it('returns email_rate_limited when authError.status is 429 with an unrelated/absent code', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    supabase.auth.signUp.mockResolvedValueOnce({
      data: { user: null },
      error: { status: 429, message: 'too many requests' },
    });

    const result = await provisionAuthUser(mockSql, asSupabase(supabase), baseInput);

    expect(result).toEqual({ ok: false, reason: 'email_rate_limited' });
  });

  it('returns account_exists for an authError with an unrelated code/status', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    supabase.auth.signUp.mockResolvedValueOnce({
      data: { user: null },
      error: { code: 'unexpected_failure', status: 422, message: 'User already registered' },
    });

    const result = await provisionAuthUser(mockSql, asSupabase(supabase), baseInput);

    expect(result).toEqual({ ok: false, reason: 'account_exists' });
  });
});

describe('deleteProvisionedAuthUser', () => {
  it('deletes the provisioned auth user', async () => {
    supabase.auth.admin.deleteUser.mockResolvedValueOnce({ data: null, error: null });

    await deleteProvisionedAuthUser(asSupabase(supabase), 'orphan-1');

    expect(supabase.auth.admin.deleteUser).toHaveBeenCalledWith('orphan-1');
  });

  it('swallows and logs when the compensating delete itself fails', async () => {
    supabase.auth.admin.deleteUser.mockRejectedValueOnce(new Error('supabase admin api down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      deleteProvisionedAuthUser(asSupabase(supabase), 'orphan-2'),
    ).resolves.toBeUndefined();

    expect(supabase.auth.admin.deleteUser).toHaveBeenCalledWith('orphan-2');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
