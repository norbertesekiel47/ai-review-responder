import type { Sql } from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LocationId } from '@/lib/shared/ids';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import {
  AdminOnboardingError,
  buildInviteRedirectTo,
  redactEmail,
} from './admin-onboarding-service';

/**
 * Admin "resend invite" (plan step 9 / T7).
 *
 * Why the eligibility check cannot be local: `onboardBusinessAsAdmin` patches
 * `users.auth_id` immediately after `inviteUserByEmail` returns — BEFORE the
 * owner ever clicks the link. So `auth_id IS NOT NULL` proves only that we
 * invited them, never that they accepted. The authoritative "has this owner
 * ever actually arrived" signal lives with the provider:
 * `auth.admin.getUserById(auth_id).last_sign_in_at`.
 *
 * No account lock / serialization — deliberately (review log round 1, finding
 * 6, REJECTED). The only race is an owner accepting while an admin resends;
 * its worst case is one duplicate email whose link is dead or reusable. There
 * is no state corruption for a lock to prevent, and a lock here would be
 * machinery guarding no failure mode.
 *
 * `sql` + `supabase` are injected (invariant #15) — this module never imports
 * `@/lib/db/server`.
 */

// ---------------------------------------------------------------------------
// Error vocabulary
// ---------------------------------------------------------------------------

/**
 * Discriminated error codes for the route layer to map to HTTP statuses —
 * same shape (and same reasoning) as `AdminOnboardingError` on the creation
 * path: one class, exhaustive catch-site, status carried on the error so the
 * route stays an orchestrator (invariant #12).
 */
export type ResendInviteErrorCode =
  /** No business row with this id. */
  | 'BUSINESS_NOT_FOUND'
  /** The Account is past the invite stage (active / trialing / past_due / cancelled). */
  | 'NOT_PENDING_PAYMENT'
  /** users.auth_id is NULL — no provider identity to interrogate. */
  | 'OWNER_NOT_LINKED'
  /** Provider says the owner has signed in at least once — invite already used. */
  | 'OWNER_ALREADY_SIGNED_IN'
  /** auth_id points at an auth user the provider no longer has. */
  | 'PROVIDER_USER_MISSING'
  /** getUserById failed — NOT the same as "never signed in". */
  | 'PROVIDER_UNAVAILABLE'
  /** NEXT_PUBLIC_APP_URL missing/malformed/disallowed — cannot build redirectTo. */
  | 'APP_URL_MISCONFIGURED'
  /** Provider refuses the invite because the address is already registered. */
  | 'INVITE_ALREADY_REGISTERED'
  /** Provider email-send budget exhausted. */
  | 'INVITE_RATE_LIMITED'
  /** Provider rejected the request (validation, address, email provider off). */
  | 'INVITE_REJECTED'
  /** Unrecognised provider error — conservative 502, never retried. */
  | 'INVITE_FAILED_UNKNOWN';

export class ResendInviteError extends Error {
  readonly code: ResendInviteErrorCode;
  readonly status: number;

  constructor(code: ResendInviteErrorCode, message: string, status: number) {
    super(message);
    this.name = 'ResendInviteError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Provider-error mapping
// ---------------------------------------------------------------------------

/**
 * CONTRACT VERIFIED against the staging Supabase project on 2026-08-14
 * (@supabase/supabase-js 2.106.2). Evidence:
 * `docs/runbooks/evidence/2026-08-14-admin-invite-funnel-staging.md` → "D-13".
 *
 * This header used to say CONTRACT NOT YET VERIFIED and describe the three
 * entries below as assumptions. They were probed directly — invite, re-invite
 * while pending, real sign-in, re-invite once accepted — and the observations
 * are:
 *
 *   1. Re-inviting a still-unaccepted invitee **SUCCEEDS** (HTTP 200) and
 *      re-sends the mail. This is the whole feature, and it works.
 *   2. Re-inviting an accepted user fails as
 *      `AuthApiError { code: 'email_exists', status: 422 }`. `code` is a
 *      STRING, which is what makes the table below reachable at all — the raw
 *      wire body also carries a NUMERIC `code: 422` alongside
 *      `error_code: 'email_exists'`, and had the client surfaced that number,
 *      every branch here would be dead and everything would fall to the 502
 *      fallback. So `email_exists` → 409 is confirmed end to end.
 *   3. `last_sign_in_at` is null until a REAL sign-in — an admin
 *      `updateUserById({ password, email_confirm })` does not populate it. The
 *      eligibility premise holds, so the accepted-user branch above is
 *      normally unreachable in production: the gate refuses first, and this
 *      table is the safety net behind it.
 *
 * STILL UNVERIFIED, deliberately: the exact rate-limit code
 * (`over_email_send_rate_limit` vs `over_request_rate_limit`) and the four
 * `INVITE_REJECTED` codes. Probing them means deliberately exhausting a mail
 * budget or misconfiguring SMTP, and it would change nothing — the
 * `providerStatus === 429` secondary key below catches ANY rate-limit error
 * regardless of its code, which makes those two entries redundant-but-harmless
 * rather than load-bearing. The `INVITE_REJECTED` four are likewise strictly
 * better-than-fallback message text on paths that cannot occur without an
 * operator misconfiguring the project.
 *
 * KEYED ON `code`/`status`, NEVER ON MESSAGE TEXT (review log round 1, finding
 * 7): a provider copy change must not silently re-route a branch.
 *
 * FALLBACK IS DELIBERATE: an unrecognised error maps to HTTP 502, logs the raw
 * provider code + status, and is NEVER retried. A blind retry can re-send a
 * real email to a real customer; that is the failure mode this rule prevents.
 */
const INVITE_ERROR_CODE_MAP: Readonly<
  Record<string, { code: ResendInviteErrorCode; status: number; message: string }>
> = {
  email_exists: {
    code: 'INVITE_ALREADY_REGISTERED',
    status: 409,
    message:
      'Supabase says this email is already registered — the owner has likely already accepted the invite. Ask them to sign in or use password reset.',
  },
  user_already_exists: {
    code: 'INVITE_ALREADY_REGISTERED',
    status: 409,
    message:
      'Supabase says this user already exists — the owner has likely already accepted the invite. Ask them to sign in or use password reset.',
  },
  identity_already_exists: {
    code: 'INVITE_ALREADY_REGISTERED',
    status: 409,
    message:
      'Supabase says this identity already exists — the owner has likely already accepted the invite. Ask them to sign in or use password reset.',
  },
  over_email_send_rate_limit: {
    code: 'INVITE_RATE_LIMITED',
    status: 429,
    message: 'Supabase email send limit reached. Wait a few minutes and try again.',
  },
  over_request_rate_limit: {
    code: 'INVITE_RATE_LIMITED',
    status: 429,
    message: 'Supabase request limit reached. Wait a few minutes and try again.',
  },
  validation_failed: {
    code: 'INVITE_REJECTED',
    status: 422,
    message: 'Supabase rejected the invite request as invalid. Check the owner email on this business.',
  },
  email_address_invalid: {
    code: 'INVITE_REJECTED',
    status: 422,
    message: 'Supabase rejected the owner email address as invalid.',
  },
  email_address_not_authorized: {
    code: 'INVITE_REJECTED',
    status: 422,
    message: 'Supabase is not authorized to email this address (SMTP allowlist).',
  },
  email_provider_disabled: {
    code: 'INVITE_REJECTED',
    status: 422,
    message: 'Supabase email provider is disabled — no invite can be sent until it is re-enabled.',
  },
};

/** The subset of an `AuthError` this mapping is allowed to read. */
export interface ProviderErrorLike {
  code?: string | null;
  status?: number | null;
}

/**
 * Map a provider error from `inviteUserByEmail` to a mappable domain error.
 * See INVITE_ERROR_CODE_MAP's header for the contract and its 2026-08-14
 * staging verification.
 */
export function mapInviteProviderError(
  error: ProviderErrorLike | null | undefined,
): ResendInviteError {
  const providerCode = error?.code ?? null;
  const providerStatus = error?.status ?? null;

  const known = providerCode ? INVITE_ERROR_CODE_MAP[providerCode] : undefined;
  if (known) {
    return new ResendInviteError(known.code, known.message, known.status);
  }

  // Secondary key: an unrecognised code carrying HTTP 429 is still
  // unambiguously "slow down". Safe because both branches are terminal — this
  // never chooses to retry, it only chooses the message the admin reads.
  if (providerStatus === 429) {
    return new ResendInviteError(
      'INVITE_RATE_LIMITED',
      'Supabase rate limit reached. Wait a few minutes and try again.',
      429,
    );
  }

  return new ResendInviteError(
    'INVITE_FAILED_UNKNOWN',
    'Supabase returned an unrecognised error for this invite. Nothing was retried — check the Supabase Auth logs before trying again.',
    502,
  );
}

/**
 * Map a provider error from `getUserById`. Deliberately separate from the
 * invite mapping: a failure to READ provider state must never be collapsed
 * into "never signed in" (that would resend to an owner who is already using
 * the product), and "this auth user is gone" is a different, actionable fact
 * from "the provider is down".
 */
function mapGetUserProviderError(
  error: ProviderErrorLike | null | undefined,
): ResendInviteError {
  if (error?.code === 'user_not_found' || error?.status === 404) {
    return new ResendInviteError(
      'PROVIDER_USER_MISSING',
      'The owner’s Supabase auth user no longer exists. This account needs manual repair — a resend cannot fix it.',
      409,
    );
  }
  return new ResendInviteError(
    'PROVIDER_UNAVAILABLE',
    'Could not read the owner’s sign-in state from Supabase, so eligibility could not be confirmed. No invite was sent.',
    502,
  );
}

// ---------------------------------------------------------------------------
// The action
// ---------------------------------------------------------------------------

export interface ResendInviteResult {
  businessId: string;
  accountId: string;
  /** Redacted for display/logging — the raw owner email never leaves this module. */
  ownerEmailRedacted: string;
  /** ISO timestamp of the successful provider call. */
  resentAt: string;
}

interface OwnerInviteRow {
  business_id: string;
  account_id: string;
  subscription_status: string;
  owner_user_id: string;
  owner_email: string;
  owner_auth_id: string | null;
}

/**
 * Re-send the owner invite for an admin-created business.
 *
 * @param sql Postgres.js client (the composition root supplies the singleton).
 * @param supabase Service-role Supabase client (same).
 * @param businessId The Business (= one Google Business Profile location).
 * @throws ResendInviteError — every failure mode is mappable by the route.
 */
export async function resendOwnerInvite(
  sql: Sql,
  supabase: SupabaseClient,
  businessId: LocationId,
): Promise<ResendInviteResult> {
  // Config first, as on the creation path: fail fast before spending a
  // provider round-trip on a request that could never have sent a link.
  let inviteRedirectTo: string;
  try {
    inviteRedirectTo = buildInviteRedirectTo();
  } catch (err) {
    if (err instanceof AdminOnboardingError) {
      // The three config codes (missing / malformed / disallowed scheme) all
      // mean the same thing to an admin and already carry distinct messages.
      console.error(
        `[resend-invite] cannot build invite redirectTo (${err.code}) for business ${businessId}`,
      );
      throw new ResendInviteError('APP_URL_MISCONFIGURED', err.message, 500);
    }
    throw err;
  }

  const rows = await sql<OwnerInviteRow[]>`
    SELECT
      b.id             AS business_id,
      a.id             AS account_id,
      a.subscription_status,
      u.id             AS owner_user_id,
      u.email          AS owner_email,
      u.auth_id        AS owner_auth_id
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    JOIN users u ON u.id = a.owner_user_id
    WHERE b.id = ${businessId}::uuid
  `;

  const row = rows[0];
  if (!row) {
    throw new ResendInviteError('BUSINESS_NOT_FOUND', 'Business not found', 404);
  }

  if (row.subscription_status !== SubscriptionStatus.PENDING_PAYMENT) {
    throw new ResendInviteError(
      'NOT_PENDING_PAYMENT',
      `This account is ${row.subscription_status.replace(/_/g, ' ')}, not awaiting payment — the invite stage is over.`,
      409,
    );
  }

  if (!row.owner_auth_id) {
    // Admin onboarding hard-fails (and rolls back) when the auth_id patch
    // misses, so this should be unreachable — but a NULL here means we have no
    // provider identity to check, and resending blind would be exactly the
    // "silently wrong for a never-accepted invite" bug this gate exists for.
    throw new ResendInviteError(
      'OWNER_NOT_LINKED',
      'This owner has no linked Supabase identity, so their invite state cannot be verified. Manual repair required.',
      409,
    );
  }

  const { data: providerUser, error: lookupError } =
    await supabase.auth.admin.getUserById(row.owner_auth_id);

  if (lookupError || !providerUser?.user) {
    console.error(
      `[resend-invite] getUserById failed for business ${businessId} owner ${redactEmail(row.owner_email)}:`,
      { code: lookupError?.code ?? null, status: lookupError?.status ?? null },
    );
    throw mapGetUserProviderError(lookupError);
  }

  // THE eligibility signal. `auth_id IS NOT NULL` is patched at creation time
  // and proves nothing about acceptance; `last_sign_in_at` is the provider's
  // own record of the owner having arrived.
  if (providerUser.user.last_sign_in_at) {
    throw new ResendInviteError(
      'OWNER_ALREADY_SIGNED_IN',
      'This owner has already signed in, so the invite was accepted. Send them a password reset instead.',
      409,
    );
  }

  const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(
    row.owner_email,
    { redirectTo: inviteRedirectTo },
  );

  if (inviteError) {
    // Deliberately NO retry — a blind retry can re-send a real email.
    console.error(
      `[resend-invite] inviteUserByEmail failed for business ${businessId} owner ${redactEmail(row.owner_email)}:`,
      { code: inviteError.code ?? null, status: inviteError.status ?? null },
    );
    throw mapInviteProviderError(inviteError);
  }

  const ownerEmailRedacted = redactEmail(row.owner_email);
  console.info(
    `[resend-invite] re-sent owner invite for business ${businessId} to ${ownerEmailRedacted}`,
  );

  return {
    businessId: row.business_id,
    accountId: row.account_id,
    ownerEmailRedacted,
    resentAt: new Date().toISOString(),
  };
}
