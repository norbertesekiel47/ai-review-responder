// src/lib/auth/provision-auth-user.ts
//
// Born-injected domain module: provisions (or detects a duplicate of) the
// owner's Supabase Auth identity for the self-serve signup flow. Extracted
// from the fat POST /api/auth/signup route handler (A+ campaign, PR 2a) —
// the route is the composition root; it supplies `sql` + the Supabase server
// client and maps this module's result onto HTTP.
//
// Behavior-preserving extraction: every branch below is byte-identical to
// the pre-extraction route logic (decision-table tests in
// __tests__/provision-auth-user.test.ts pin each one).

import type { Sql } from 'postgres';
import type { AuthError, SupabaseClient, User } from '@supabase/supabase-js';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

export type ProvisionAuthUserResult =
  | { ok: true; authId: string }
  | { ok: false; reason: 'account_exists' }
  | { ok: false; reason: 'email_rate_limited' };

export interface ProvisionAuthUserInput {
  ownerEmail: string;
  password: string;
  emailRedirectTo: string;
}

/**
 * Provisions (or detects a duplicate of) the owner's Supabase Auth identity.
 *
 * Runs, in order: an advisory-locked pre-check against `users.email`
 * (serializes against the cleanup-poller's candidates only — simultaneous
 * signups for the same email are defeated by the `users.email` UNIQUE
 * constraint downstream, not by this lock); `supabase.auth.signUp`; a
 * hosted-Auth timestamp-based recovery query for the `{error:null,user:null}`
 * shape hosted Supabase Auth can return; an anti-enumeration disambiguation
 * of `identities:[]` responses via `admin.getUserById`; and error triage that
 * distinguishes an email-send rate limit from an account-exists conflict.
 *
 * `sql` + `supabase` are injected (the composition root supplies the
 * singletons) — this module never imports `@/lib/db/server`.
 */
export async function provisionAuthUser(
  sql: Sql,
  supabase: SupabaseClient,
  input: ProvisionAuthUserInput,
): Promise<ProvisionAuthUserResult> {
  const preCheck = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${input.ownerEmail + ':signup'}))`;
    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${input.ownerEmail} LIMIT 1
    `;
    return existing;
  });
  if (preCheck) {
    return { ok: false, reason: 'account_exists' };
  }

  const signUpStartedAt = new Date();
  const { data: authData, error: authError } = await supabase.auth.signUp({
    email: input.ownerEmail,
    password: input.password,
    options: { emailRedirectTo: input.emailRedirectTo },
  });
  let authUser = authData.user;

  // Hosted Supabase Auth can return `{ error: null, user: null }` while still
  // creating auth.users + sending the confirmation email. Recover the id from
  // the private auth schema so the app rows are linked to the real identity.
  if (!authError && !authUser) {
    const [createdAuthUser] = await sql<{ id: string }[]>`
      SELECT id::text
      FROM auth.users
      WHERE lower(email) = ${input.ownerEmail}
        AND created_at >= ${signUpStartedAt.toISOString()}::timestamptz - interval '5 seconds'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (createdAuthUser) {
      authUser = { id: createdAuthUser.id } as NonNullable<typeof authData.user>;
    }
  }

  // Anti-enumeration obfuscation guard — see disambiguateEmptyIdentities doc
  // comment for why the empty-identities response shape alone can't be
  // trusted as the duplicate signal.
  const identitiesCheck = await disambiguateEmptyIdentities(supabase, authUser, input.ownerEmail);
  if (identitiesCheck === 'account_exists') {
    return { ok: false, reason: 'account_exists' };
  }

  if (authError || !authUser) {
    return { ok: false, reason: classifyAuthError(authError, input.ownerEmail) };
  }

  return { ok: true, authId: authUser.id };
}

/**
 * Anti-enumeration obfuscation guard.
 *
 * Supabase can return `user.identities = []` for the anti-enumeration
 * duplicate-account response, but current hosted Auth can also return an
 * empty identities array for a real newly-created email signup while the
 * identity is already present in auth.identities. Do not use the response
 * shape alone as the duplicate signal. Confirm the returned id exists in
 * Auth before using it as users.auth_id; fake ids must still be rejected.
 *
 * A no-op ('ok') when `authUser` is absent or its identities array isn't the
 * empty-array shape this guard exists for.
 */
async function disambiguateEmptyIdentities(
  supabase: SupabaseClient,
  authUser: User | null,
  ownerEmail: string,
): Promise<'ok' | 'account_exists'> {
  if (!authUser || !Array.isArray(authUser.identities) || authUser.identities.length !== 0) {
    return 'ok';
  }
  const { data: lookupData, error: lookupError } =
    await supabase.auth.admin.getUserById(authUser.id);
  const lookupEmail = lookupData.user?.email?.trim().toLowerCase();
  if (lookupError || !lookupData.user || lookupEmail !== ownerEmail) {
    console.warn(
      `[api/auth/signup] Supabase returned unconfirmed/fake user (empty identities) for ${ownerEmail} — treating as account_exists`,
    );
    return 'account_exists';
  }
  console.warn(
    `[api/auth/signup] Supabase returned empty identities for real new user ${ownerEmail}; continuing signup`,
  );
  return 'ok';
}

/**
 * Disambiguates Supabase email-send rate limits (most common during dev)
 * from account-exists. Conflating them yields a confusing "account exists"
 * message when in fact the inbox is just hot. The auth.users row is NOT
 * created when the rate limit fires, so retrying after the cooldown is the
 * right path — not "go log in".
 *
 * Only called when `authError` is set or `authUser` came back empty — the
 * `'account_exists'` fallback covers both the true-duplicate case and
 * Supabase's "User already registered" (status 422) response, which fires
 * when the auth_id exists even though our app `users` row does not (most
 * commonly an admin-created business where the owner never confirmed).
 * Returning the same reason as the pre-check hit avoids an enumeration leak.
 */
function classifyAuthError(
  authError: AuthError | null,
  ownerEmail: string,
): 'email_rate_limited' | 'account_exists' {
  const code = authError?.code;
  const status = authError?.status;
  const isRateLimit =
    code === 'over_email_send_rate_limit' ||
    code === 'email_send_rate_limit' ||
    status === 429;
  if (isRateLimit) {
    console.warn(
      `[api/auth/signup] Supabase email rate limit hit for ${ownerEmail} (code=${code}, status=${status})`,
    );
    return 'email_rate_limited';
  }
  if (authError) {
    console.warn(
      `[api/auth/signup] Supabase signUp error for ${ownerEmail}: code=${code} status=${status} message=${authError.message}`,
    );
  }
  return 'account_exists';
}

/**
 * Compensating cleanup: deletes the just-created auth user when the follow-on
 * business-creation tx fails. Awaited by the caller so the in-flight delete
 * completes before the HTTP response returns. Delete failures are logged and
 * swallowed — the caller still surfaces the original error regardless.
 */
export async function deleteProvisionedAuthUser(
  supabase: SupabaseClient,
  authId: string,
): Promise<void> {
  try {
    await supabase.auth.admin.deleteUser(authId);
  } catch (delErr) {
    reportCaughtError('signup-cleanup', delErr, {
      reason: 'orphan_auth_user_delete_failed',
      authId,
    });
  }
}
