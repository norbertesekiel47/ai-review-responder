// Domain-level suite for the admin "resend invite" action (plan step 9 / T7).
//
// The subtle rule this pins: eligibility CANNOT be decided locally.
// `onboardBusinessAsAdmin` patches `users.auth_id` immediately at creation, so
// `auth_id IS NOT NULL` is true for every never-accepted invite. The only
// authoritative signal is the provider's `last_sign_in_at` — and a FAILURE to
// read it must never be collapsed into "never signed in".
//
// `resendOwnerInvite` is born-injected (sql + supabase are parameters), so no
// module mocking is needed: the fragment-aware `createMockSql` harness stands
// in for `sql`, and a hand-rolled admin client stands in for Supabase. No
// network calls.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import { asLocationId } from '@/lib/shared/ids';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import {
  createMockSql,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import {
  mapInviteProviderError,
  resendOwnerInvite,
  ResendInviteError,
} from '../resend-invite';

const APP_URL = 'https://app.example.com';
const EXPECTED_REDIRECT = `${APP_URL}/api/auth/callback?flow=owner&next=/reset-password`;

const BUSINESS_ID = asLocationId('00000000-0000-0000-0000-0000000000b1');
const ACCOUNT_ID = '00000000-0000-0000-0000-0000000000a1';
const OWNER_USER_ID = '00000000-0000-0000-0000-0000000000c1';
const OWNER_AUTH_ID = '00000000-0000-0000-0000-0000000000d1';
const OWNER_EMAIL = 'alice@example.com';
const REDACTED_OWNER_EMAIL = 'a***@example.com';

interface ProviderStub {
  supabase: SupabaseClient;
  getUserById: ReturnType<typeof vi.fn>;
  inviteUserByEmail: ReturnType<typeof vi.fn>;
}

function ownerRow(overrides: Record<string, unknown> = {}) {
  return {
    business_id: BUSINESS_ID,
    account_id: ACCOUNT_ID,
    subscription_status: SubscriptionStatus.PENDING_PAYMENT,
    owner_user_id: OWNER_USER_ID,
    owner_email: OWNER_EMAIL,
    owner_auth_id: OWNER_AUTH_ID,
    ...overrides,
  };
}

function makeProvider(
  options: {
    lastSignInAt?: string | null;
    lookupError?: { code?: string; status?: number; message?: string } | null;
    lookupUserMissing?: boolean;
    inviteError?: { code?: string; status?: number; message?: string } | null;
  } = {},
): ProviderStub {
  const getUserById = vi.fn(async () => ({
    data: options.lookupUserMissing
      ? { user: null }
      : {
          user: {
            id: OWNER_AUTH_ID,
            email: OWNER_EMAIL,
            last_sign_in_at: options.lastSignInAt ?? null,
          },
        },
    error: options.lookupError ?? null,
  }));

  const inviteUserByEmail = vi.fn(async () => ({
    data: { user: { id: OWNER_AUTH_ID, email: OWNER_EMAIL } },
    error: options.inviteError ?? null,
  }));

  return {
    supabase: {
      auth: { admin: { getUserById, inviteUserByEmail } },
    } as unknown as SupabaseClient,
    getUserById,
    inviteUserByEmail,
  };
}

let harness: MockSqlHarness;
let mockSql: Sql;
let errorSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  infoSpy.mockRestore();
});

describe('resendOwnerInvite', () => {
  it('resend-invite resends for an owner who has never signed in', async () => {
    harness.sqlReturnQueue.push([ownerRow()]);
    const provider = makeProvider({ lastSignInAt: null });

    const result = await resendOwnerInvite(mockSql, provider.supabase, BUSINESS_ID);

    expect(provider.getUserById).toHaveBeenCalledWith(OWNER_AUTH_ID);
    expect(provider.inviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(provider.inviteUserByEmail).toHaveBeenCalledWith(OWNER_EMAIL, {
      redirectTo: EXPECTED_REDIRECT,
    });
    expect(result).toMatchObject({
      businessId: BUSINESS_ID,
      accountId: ACCOUNT_ID,
      ownerEmailRedacted: REDACTED_OWNER_EMAIL,
    });
    expect(Date.parse(result.resentAt)).not.toBeNaN();
  });

  it('resend-invite rejects an owner who has already signed in', async () => {
    harness.sqlReturnQueue.push([ownerRow()]);
    const provider = makeProvider({ lastSignInAt: '2026-08-13T09:00:00.000Z' });

    await expect(
      resendOwnerInvite(mockSql, provider.supabase, BUSINESS_ID),
    ).rejects.toMatchObject({
      code: 'OWNER_ALREADY_SIGNED_IN',
      status: 409,
    });

    // The whole point: the invite must not go out.
    expect(provider.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it('resend-invite maps an unknown provider error to 502', async () => {
    harness.sqlReturnQueue.push([ownerRow()]);
    const provider = makeProvider({
      inviteError: { code: 'some_future_code', status: 400, message: 'nope' },
    });

    const error = await resendOwnerInvite(
      mockSql,
      provider.supabase,
      BUSINESS_ID,
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ResendInviteError);
    expect(error).toMatchObject({ code: 'INVITE_FAILED_UNKNOWN', status: 502 });
    // Conservative fallback: never retry — a blind retry can re-send a real email.
    expect(provider.inviteUserByEmail).toHaveBeenCalledTimes(1);
  });

  it('rejects an account that is not pending_payment without touching the provider', async () => {
    harness.sqlReturnQueue.push([
      ownerRow({ subscription_status: SubscriptionStatus.ACTIVE }),
    ]);
    const provider = makeProvider();

    await expect(
      resendOwnerInvite(mockSql, provider.supabase, BUSINESS_ID),
    ).rejects.toMatchObject({ code: 'NOT_PENDING_PAYMENT', status: 409 });

    expect(provider.getUserById).not.toHaveBeenCalled();
    expect(provider.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it('treats a getUserById failure as provider-unavailable, NOT as "never signed in"', async () => {
    harness.sqlReturnQueue.push([ownerRow()]);
    const provider = makeProvider({
      lookupError: { code: 'unexpected_failure', status: 500, message: 'boom' },
    });

    await expect(
      resendOwnerInvite(mockSql, provider.supabase, BUSINESS_ID),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 502 });

    expect(provider.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it('treats a missing provider user (no error, no user) as provider-unavailable', async () => {
    harness.sqlReturnQueue.push([ownerRow()]);
    const provider = makeProvider({ lookupUserMissing: true });

    await expect(
      resendOwnerInvite(mockSql, provider.supabase, BUSINESS_ID),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', status: 502 });

    expect(provider.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it('maps a deleted auth user (user_not_found) to PROVIDER_USER_MISSING', async () => {
    harness.sqlReturnQueue.push([ownerRow()]);
    const provider = makeProvider({
      lookupError: { code: 'user_not_found', status: 404, message: 'gone' },
    });

    await expect(
      resendOwnerInvite(mockSql, provider.supabase, BUSINESS_ID),
    ).rejects.toMatchObject({ code: 'PROVIDER_USER_MISSING', status: 409 });
  });

  it('404s an unknown business and never reaches the provider', async () => {
    harness.sqlReturnQueue.push([]);
    const provider = makeProvider();

    await expect(
      resendOwnerInvite(mockSql, provider.supabase, BUSINESS_ID),
    ).rejects.toMatchObject({ code: 'BUSINESS_NOT_FOUND', status: 404 });

    expect(provider.getUserById).not.toHaveBeenCalled();
  });

  it('rejects an owner with no linked auth identity (auth_id NULL)', async () => {
    harness.sqlReturnQueue.push([ownerRow({ owner_auth_id: null })]);
    const provider = makeProvider();

    await expect(
      resendOwnerInvite(mockSql, provider.supabase, BUSINESS_ID),
    ).rejects.toMatchObject({ code: 'OWNER_NOT_LINKED', status: 409 });

    expect(provider.getUserById).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the requested business and reads owner state through the account', async () => {
    harness.sqlReturnQueue.push([ownerRow()]);
    const provider = makeProvider();

    await resendOwnerInvite(mockSql, provider.supabase, BUSINESS_ID);

    expect(harness.sqlCalls).toHaveLength(1);
    const call = harness.sqlCalls[0]!;
    expect(call.text).toContain('FROM businesses b');
    expect(call.text).toContain('JOIN accounts a ON a.id = b.account_id');
    expect(call.text).toContain('JOIN users u ON u.id = a.owner_user_id');
    expect(call.text).toContain('WHERE b.id = ?::uuid');
    expect(call.values).toEqual([BUSINESS_ID]);
  });

  it('fails fast with APP_URL_MISCONFIGURED before any DB or provider work', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const provider = makeProvider();

    await expect(
      resendOwnerInvite(mockSql, provider.supabase, BUSINESS_ID),
    ).rejects.toMatchObject({ code: 'APP_URL_MISCONFIGURED', status: 500 });

    expect(harness.sqlCalls).toHaveLength(0);
    expect(provider.getUserById).not.toHaveBeenCalled();
  });

  it('never logs the raw owner email on a provider failure', async () => {
    harness.sqlReturnQueue.push([ownerRow()]);
    const provider = makeProvider({
      inviteError: { code: 'some_future_code', status: 400, message: 'nope' },
    });

    await resendOwnerInvite(mockSql, provider.supabase, BUSINESS_ID).catch(() => {});

    const logged = errorSpy.mock.calls
      .map((args: unknown[]) => JSON.stringify(args))
      .join('\n');
    expect(logged).toContain(REDACTED_OWNER_EMAIL);
    expect(logged).not.toContain(OWNER_EMAIL);
  });
});

describe('mapInviteProviderError', () => {
  it('maps the VERIFIED accepted-user error shape observed on staging', () => {
    // Recorded against the staging Supabase project on 2026-08-14 with
    // @supabase/supabase-js 2.106.2, by inviting, signing in for real, then
    // re-inviting. Verbatim:
    //   AuthApiError { code: 'email_exists', status: 422,
    //                  message: 'A user with this email address has already been registered' }
    // This is the shape D-13's header called unverified; it is now evidence.
    expect(
      mapInviteProviderError({ code: 'email_exists', status: 422 }),
    ).toMatchObject({ code: 'INVITE_ALREADY_REGISTERED', status: 409 });
  });

  it('falls back to 502 when the provider reports a NUMERIC code', () => {
    // The trap that would silently kill every branch of INVITE_ERROR_CODE_MAP.
    // The raw GoTrue body carries BOTH `code: 422` (number) and
    // `error_code: 'email_exists'`. supabase-js 2.106.2 surfaces the STRING on
    // `error.code`, which is the only reason the table is reachable — but if a
    // future client version passed the number through instead, every lookup
    // would miss. Pinning the miss as an explicit, loud 502 (never a retry)
    // documents that dependency instead of leaving it implicit.
    expect(
      mapInviteProviderError({ code: 422 as unknown as string, status: 422 }),
    ).toMatchObject({ code: 'INVITE_FAILED_UNKNOWN', status: 502 });
  });

  it('keys on the provider error code, never on message text', () => {
    // Same message text, different codes → different outcomes.
    const alreadyRegistered = mapInviteProviderError({
      code: 'email_exists',
      status: 422,
    });
    const unknown = mapInviteProviderError({
      code: 'email_exists_renamed_in_v3',
      status: 422,
    });

    expect(alreadyRegistered).toMatchObject({
      code: 'INVITE_ALREADY_REGISTERED',
      status: 409,
    });
    expect(unknown).toMatchObject({ code: 'INVITE_FAILED_UNKNOWN', status: 502 });
  });

  it.each([
    ['user_already_exists', 'INVITE_ALREADY_REGISTERED', 409],
    ['identity_already_exists', 'INVITE_ALREADY_REGISTERED', 409],
    ['over_email_send_rate_limit', 'INVITE_RATE_LIMITED', 429],
    ['over_request_rate_limit', 'INVITE_RATE_LIMITED', 429],
    ['validation_failed', 'INVITE_REJECTED', 422],
    ['email_address_invalid', 'INVITE_REJECTED', 422],
    ['email_address_not_authorized', 'INVITE_REJECTED', 422],
    ['email_provider_disabled', 'INVITE_REJECTED', 422],
  ])('maps %s to %s', (providerCode, expectedCode, expectedStatus) => {
    expect(mapInviteProviderError({ code: providerCode, status: 400 })).toMatchObject({
      code: expectedCode,
      status: expectedStatus,
    });
  });

  it('falls back to rate-limited on an unrecognised code carrying HTTP 429', () => {
    expect(mapInviteProviderError({ code: 'brand_new_code', status: 429 })).toMatchObject({
      code: 'INVITE_RATE_LIMITED',
      status: 429,
    });
  });

  it('maps a codeless / statusless provider error to 502', () => {
    expect(mapInviteProviderError(null)).toMatchObject({
      code: 'INVITE_FAILED_UNKNOWN',
      status: 502,
    });
    expect(mapInviteProviderError({})).toMatchObject({
      code: 'INVITE_FAILED_UNKNOWN',
      status: 502,
    });
  });
});
