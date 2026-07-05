import type { z } from 'zod';
import type { Sql } from 'postgres';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isPlaceId, extractPlaceId } from '@/lib/reviews/url-parser';
import type { OnboardBusinessSchema } from '@/lib/shared/schemas';
import {
  createBusinessTx,
  DuplicateEmailError,
  type AdminBusinessTxInput,
  type PlaceIdInput,
} from './create-business';

/**
 * Parsed Zod payload as the admin route currently feeds in. Aliasing the
 * schema's inferred output keeps the service in lockstep with the route
 * without re-declaring every field by hand.
 */
export type AdminOnboardingInput = z.infer<typeof OnboardBusinessSchema> & {
  /** Authenticated admin/sales-partner user id (becomes `onboarded_by`). */
  onboardedBy: string;
};

export interface AdminOnboardingResult {
  businessId: string;
  paymentUrl: string | null;
}

/**
 * Discriminated error codes for the route layer to map to HTTP statuses.
 * Single class keeps the throw-sites simple and the catch-site exhaustive.
 */
export type AdminOnboardingErrorCode =
  | 'INVALID_PLACE_ID'
  | 'PLACE_REQUIRED'
  | 'MISSING_APP_URL'
  | 'MALFORMED_APP_URL'
  | 'DISALLOWED_APP_URL_SCHEME'
  | 'DUPLICATE_EMAIL'
  | 'CREATE_BUSINESS_FAILED'
  | 'INVITE_FAILED'
  | 'LINK_AUTH_ID_FAILED';

/**
 * Optional rollback diagnostics for LINK_AUTH_ID_FAILED. When the auth_id
 * link UPDATE matches 0 rows, the service attempts to delete the auth user
 * and the business+users rows. Either of those cleanup steps can fail
 * independently, leaving orphan records that need manual cleanup. Surfacing
 * the IDs lets the admin UI tell the operator exactly what's left over
 * instead of failing silently with a generic 500.
 */
export interface AdminOnboardingRollbackDetails {
  /** Set if the auth user (Supabase auth.users) may still exist. */
  orphanAuthUserId?: string;
  /** Set if the public.businesses row may still exist. */
  orphanBusinessId?: string;
  /** Set if the public.users row may still exist. */
  orphanUserId?: string;
}

export class AdminOnboardingError extends Error {
  readonly code: AdminOnboardingErrorCode;
  readonly status: number;
  readonly rollback?: AdminOnboardingRollbackDetails;

  constructor(
    code: AdminOnboardingErrorCode,
    message: string,
    status: number,
    rollback?: AdminOnboardingRollbackDetails,
  ) {
    super(message);
    this.name = 'AdminOnboardingError';
    this.code = code;
    this.status = status;
    this.rollback = rollback;
  }
}

/**
 * Redact an email for logs: keep the first character of the local part and
 * the full domain, mask the rest. `norbertesekiel@gmail.com` → `n***@gmail.com`.
 * Never emit raw owner emails to logs (PII; also helps when ops pastes a log
 * line into a ticket).
 */
function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local[0]}***${domain}`;
}

function splitCommaOrNewline(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text.split(/\n|,/).flatMap((s) => {
    const trimmed = s.trim();
    return trimmed ? [trimmed] : [];
  });
}

function splitParagraphs(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text.split(/\n\n+/).flatMap((s) => {
    const trimmed = s.trim();
    return trimmed ? [trimmed] : [];
  });
}

/**
 * Build a normalized invite redirect URL from NEXT_PUBLIC_APP_URL.
 *
 * The invite step depends on this env var to construct the redirectTo; if
 * it's missing or malformed, returning 500 after createBusinessTx already
 * committed leaves a half-provisioned business + auth-less users row that
 * the admin can't easily clean up (the cleanup poller doesn't touch
 * admin-onboarded rows because their `onboarded_by` is non-null). Fail-fast
 * here, BEFORE writing any DB rows.
 *
 * Normalize the env value before building the redirect:
 *   - Trim whitespace (leading/trailing — common copy-paste mistake)
 *   - Parse via URL constructor (rejects missing scheme, illegal chars)
 *   - Enforce scheme allowlist: https://, OR http://localhost for dev
 *   - Use parsed.origin so any path/query/fragment in the env is dropped
 */
function buildInviteRedirectTo(): string {
  const rawAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!rawAppUrl || !rawAppUrl.trim()) {
    console.error(
      '[admin-onboarding-service] NEXT_PUBLIC_APP_URL not set — cannot build invite redirectTo',
    );
    throw new AdminOnboardingError(
      'MISSING_APP_URL',
      'Server misconfigured (missing APP_URL)',
      500,
    );
  }
  let normalizedAppUrl: URL;
  try {
    normalizedAppUrl = new URL(rawAppUrl.trim());
  } catch {
    console.error(
      `[admin-onboarding-service] NEXT_PUBLIC_APP_URL is malformed (${rawAppUrl.trim()}) — cannot build invite redirectTo`,
    );
    throw new AdminOnboardingError(
      'MALFORMED_APP_URL',
      'Server misconfigured (malformed APP_URL)',
      500,
    );
  }
  const isHttps = normalizedAppUrl.protocol === 'https:';
  const isLocalHttp =
    normalizedAppUrl.protocol === 'http:' &&
    (normalizedAppUrl.hostname === 'localhost' ||
      normalizedAppUrl.hostname === '127.0.0.1');
  if (!isHttps && !isLocalHttp) {
    console.error(
      `[admin-onboarding-service] NEXT_PUBLIC_APP_URL has disallowed scheme (${normalizedAppUrl.protocol}) — only https:// or http://localhost permitted`,
    );
    throw new AdminOnboardingError(
      'DISALLOWED_APP_URL_SCHEME',
      'Server misconfigured (disallowed APP_URL scheme)',
      500,
    );
  }
  return `${normalizedAppUrl.origin}/api/auth/callback?flow=owner&next=/reset-password`;
}

function resolvePlaceIdInput(data: AdminOnboardingInput): PlaceIdInput {
  if (data.googlePlaceId) {
    // Autocomplete path — validate format server-side.
    if (!isPlaceId(data.googlePlaceId)) {
      throw new AdminOnboardingError(
        'INVALID_PLACE_ID',
        'Invalid Place ID format',
        400,
      );
    }
    return {
      placeIdVerified: true,
      placeId: data.googlePlaceId,
      googleMapsUrl: data.googleMapsUrl ?? null,
    };
  }
  if (data.googleMapsUrl) {
    // URL fallback — extract what we can, validation happens in worker.
    const placeId = extractPlaceId(data.googleMapsUrl);
    // placeId may be hex CID or null — that's OK, worker will resolve it.
    return {
      placeIdVerified: false,
      placeId: placeId ?? null,
      googleMapsUrl: data.googleMapsUrl,
    };
  }
  throw new AdminOnboardingError(
    'PLACE_REQUIRED',
    'Place ID or Google Maps URL required',
    400,
  );
}

function buildTxInput(
  data: AdminOnboardingInput,
  placeIdInput: PlaceIdInput,
): AdminBusinessTxInput {
  return {
    ownerEmail: data.ownerEmail,
    ownerName: data.ownerName,
    ownerPhone: data.ownerPhone ?? null,
    businessName: data.name,
    category: data.category ?? null,
    tone: data.tone,
    productsServices: data.productsServices ?? null,
    staffNames: splitCommaOrNewline(data.staffNames),
    highlightFacts: splitCommaOrNewline(data.highlightFacts),
    avoidFacts: splitCommaOrNewline(data.avoidFacts),
    sampleResponses: splitParagraphs(data.sampleResponses),
    subscriptionTier: data.subscriptionTier,
    website: data.website ?? null,
    placeId: placeIdInput,
  };
}

/**
 * Compensating rollback for a provisioning failure after createBusinessTx has
 * already committed (invite-send failure, or auth_id link failure). Runs the
 * 4 deletes atomically, in FK-cascade-significant order:
 *   1. job_outbox first — no FK CASCADE from businesses to job_outbox
 *      (aggregate_id is just a UUID, not a foreign key — see migration
 *      001 line 301), so leaving these rows in place would orphan
 *      pending jobs that the OutboxPoller would then dispatch into
 *      a void (no business_id to look up).
 *   2. users next — users.account_id is a FK to accounts.id without
 *      CASCADE so users must be deleted before accounts.
 *   3. accounts — the accounts row links everything together.
 *   4. businesses last — channel_enrollments cascade-deletes via
 *      businesses.id ON DELETE CASCADE.
 *
 * @param sql Postgres.js client (composition root supplies the singleton).
 */
export async function rollbackProvisionedBusiness(
  sql: Sql,
  createdResult: { businessId: string; userId: string; accountId: string },
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM job_outbox WHERE aggregate_id = ${createdResult.businessId}::uuid`;
    await tx`DELETE FROM users WHERE id = ${createdResult.userId}::uuid`;
    await tx`DELETE FROM accounts WHERE id = ${createdResult.accountId}::uuid`;
    await tx`DELETE FROM businesses WHERE id = ${createdResult.businessId}::uuid`;
  });
}

/**
 * Admin onboarding orchestration. Runs (in order):
 *   1. Place ID input resolution (autocomplete vs Google Maps URL)
 *   2. NEXT_PUBLIC_APP_URL validation (fail-fast before any DB write)
 *   3. createBusinessTx in admin mode
 *   4. supabase.auth.admin.inviteUserByEmail
 *      - on failure: compensating delete of job_outbox + users + businesses
 *   5. users.auth_id patch
 *      - on failure: compensating delete of auth user + DB rows
 *
 * The compensating-delete steps preserve the lab-note 2026-04-24 behavior:
 * admin-created users.auth_id must NEVER stay NULL because that locks the
 * owner out (no Supabase Auth identity → no login, reset, or signup
 * recourse via the email-collision pre-check).
 *
 * `sql` + `supabase` are injected (the composition root supplies the
 * singletons) — this module never imports `@/lib/db/server`.
 */
export async function onboardBusinessAsAdmin(
  sql: Sql,
  supabase: SupabaseClient,
  input: AdminOnboardingInput,
): Promise<AdminOnboardingResult> {
  const placeIdInput = resolvePlaceIdInput(input);
  const txInput = buildTxInput(input, placeIdInput);
  const ownerEmailLower = input.ownerEmail.trim().toLowerCase();

  // Validate config BEFORE writing any DB rows. See buildInviteRedirectTo
  // doc comment for the rationale.
  const inviteRedirectTo = buildInviteRedirectTo();

  let createdResult: Awaited<ReturnType<typeof createBusinessTx>>;
  try {
    createdResult = await createBusinessTx(sql, txInput, {
      mode: 'admin',
      onboardedBy: input.onboardedBy,
    });
  } catch (err) {
    if (err instanceof DuplicateEmailError) {
      throw new AdminOnboardingError(
        'DUPLICATE_EMAIL',
        'A user with this email already exists',
        409,
      );
    }
    console.error('[admin-onboarding-service] createBusinessTx failed:', err);
    throw new AdminOnboardingError(
      'CREATE_BUSINESS_FAILED',
      'Failed to onboard business',
      500,
    );
  }

  // Owner provisioning. Without this step the admin-created users row has
  // auth_id = NULL → no Supabase Auth identity → owner can't log in, can't
  // reset password (Supabase silently no-ops on missing auth.users row),
  // and can't sign up either (our /api/auth/signup pre-check finds the
  // existing public.users row by email and returns 409 account_exists).
  //
  // inviteUserByEmail creates the auth.users row WITHOUT a password, marks
  // the email confirmed, and emails the owner an invite link. The link
  // routes through /api/auth/callback?next=/reset-password so the owner
  // sets their initial password on arrival, lands at /dashboard with a
  // valid session. Supabase's "Invite user" email template controls the
  // copy — make sure it points at:
  //   {{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&type=invite&flow=owner&next=/reset-password
  const { data: invited, error: inviteErr } =
    await supabase.auth.admin.inviteUserByEmail(ownerEmailLower, {
      redirectTo: inviteRedirectTo,
    });

  if (inviteErr || !invited?.user) {
    // Compensating cleanup — the owner can never log in without an auth
    // user, so a half-provisioned business is worse than nothing.
    // FK-aware delete order: users first (no cascade from businesses),
    // then businesses + dependents via CASCADE on the businesses row.
    console.error(
      `[admin-onboarding-service] inviteUserByEmail failed for ${redactEmail(ownerEmailLower)}:`,
      inviteErr?.message ?? 'no user returned',
    );

    // Track whether the rollback DB deletes actually completed. Mirror
    // the LINK_AUTH_ID_FAILED path: if rollback fails, surface the
    // orphan IDs so the admin operator knows what to clean up. Without
    // this, the next admin retry on the same email 422s with no
    // breadcrumb (createBusinessTx finds the still-existing public.users
    // row and throws DuplicateEmailError).
    const rollback: AdminOnboardingRollbackDetails = {
      orphanBusinessId: createdResult.businessId,
      orphanUserId: createdResult.userId,
    };

    try {
      await rollbackProvisionedBusiness(sql, createdResult);
      delete rollback.orphanBusinessId;
      delete rollback.orphanUserId;
    } catch (rollbackErr) {
      console.error(
        '[admin-onboarding-service] Compensating rollback failed:',
        rollbackErr,
      );
    }

    const hasOrphans =
      rollback.orphanBusinessId !== undefined ||
      rollback.orphanUserId !== undefined;
    throw new AdminOnboardingError(
      'INVITE_FAILED',
      hasOrphans
        ? 'Could not send owner invite email and the cleanup rollback partially failed. Manual cleanup required — see the response details.'
        : 'Could not send owner invite email. Business was not created — check Supabase Auth settings (SMTP, rate limits) and try again.',
      500,
      hasOrphans ? rollback : undefined,
    );
  }

  // Link the auth identity to our users row. The createBusinessTx admin
  // contract still writes auth_id=NULL on insert; we patch it here so the
  // /api/auth/callback role lookup (which keys on auth_id) finds the row
  // when the owner clicks the invite link.
  //
  // Hard-fail if either the UPDATE throws OR matches 0 rows. Soft-warning
  // is too lenient: the caller (admin/businesses/new client) used to ignore
  // the warning and redirect to Stripe anyway, leaving the admin under the
  // impression onboarding worked while the owner is invisibly locked out.
  // Rollback the business + invite atomically so the admin can retry from
  // a clean slate.
  let linked = false;
  try {
    const updated = await sql<{ id: string }[]>`
      UPDATE users
      SET auth_id = ${invited.user.id}, updated_at = NOW()
      WHERE id = ${createdResult.userId}::uuid
        AND auth_id IS NULL
      RETURNING id
    `;
    linked = updated.length > 0;
  } catch (linkErr) {
    console.error(
      `[admin-onboarding-service] Failed to link auth_id ${invited.user.id} to users.${createdResult.userId}:`,
      linkErr,
    );
  }
  if (!linked) {
    console.error(
      `[admin-onboarding-service] auth_id link UPDATE matched 0 rows for users.${createdResult.userId} — rolling back business + invited auth user`,
    );
    // Track which rollback steps actually completed so the route can tell
    // the admin operator what (if anything) needs manual cleanup. Each ID
    // starts as "may still exist" and is cleared once we confirm deletion.
    const rollback: AdminOnboardingRollbackDetails = {
      orphanAuthUserId: invited.user.id,
      orphanBusinessId: createdResult.businessId,
      orphanUserId: createdResult.userId,
    };

    // Best-effort rollback: delete the auth user we just invited, then the
    // DB rows.
    //
    // Supabase v2 admin returns `{ data, error }` instead of throwing on
    // API-level failures (404 user-not-found, 422 invalid, RLS denial,
    // etc.). The outer try/catch handles transport-layer throws (network
    // down, JSON parse fail); the inner `if (error)` handles structured
    // failures the SDK surfaces in the response. Without both, a real
    // failure to delete the orphan auth user would silently succeed and
    // the next admin retry on the same email would 422 from Supabase
    // (email collision) without any log breadcrumb.
    try {
      const { error: deleteErr } =
        await supabase.auth.admin.deleteUser(invited.user.id);
      if (deleteErr) {
        console.error(
          `[admin-onboarding-service] Supabase deleteUser returned error for invited auth user ${invited.user.id} during link-failure rollback:`,
          deleteErr.message ?? deleteErr,
        );
      } else {
        delete rollback.orphanAuthUserId;
      }
    } catch (thrownErr) {
      console.error(
        `[admin-onboarding-service] Supabase deleteUser threw for invited auth user ${invited.user.id} during link-failure rollback:`,
        thrownErr,
      );
    }
    try {
      await rollbackProvisionedBusiness(sql, createdResult);
      delete rollback.orphanBusinessId;
      delete rollback.orphanUserId;
    } catch (rollbackErr) {
      console.error(
        '[admin-onboarding-service] DB rollback after auth_id link failure threw:',
        rollbackErr,
      );
    }
    const hasOrphans =
      rollback.orphanAuthUserId !== undefined ||
      rollback.orphanBusinessId !== undefined ||
      rollback.orphanUserId !== undefined;
    throw new AdminOnboardingError(
      'LINK_AUTH_ID_FAILED',
      hasOrphans
        ? 'Could not link the invited owner to the business record, and the cleanup rollback partially failed. Manual cleanup required — see the response details.'
        : 'Could not link the invited owner to the business record. The business was rolled back — try again, and if this persists check users.auth_id constraints.',
      500,
      hasOrphans ? rollback : undefined,
    );
  }

  return {
    businessId: createdResult.businessId,
    paymentUrl: createdResult.paymentUrl,
  };
}
