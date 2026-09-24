import { NextRequest, NextResponse } from 'next/server';
import { requireAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { requireOwnerWithAccount } from '@/lib/auth/route-helpers';
import { cookieBackedServerClient, type AppUser } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { getSessionCookieSecret } from '@/lib/shared/session-cookie-secret';
import { signValue, verifySignedValue } from '@/lib/shared/signed-value';

export const FRESH_AUTH_COOKIE_NAME = 'rw_delete_data_fresh_auth';
export const FRESH_AUTH_WINDOW_MS = 10 * 60 * 1000;

const FRESH_AUTH_MAX_AGE_SECONDS = FRESH_AUTH_WINDOW_MS / 1000;
const SIGNING_CONTEXT = 'repworth:delete-data-fresh-auth:v1';

export type DeleteDataDestructiveAuthResult =
  | { ok: true; user: AppUser; accountId: string }
  | { ok: false; response: NextResponse };

interface FreshAuthStampInput {
  userId: string;
  accountId: string;
  issuedAt?: Date;
}

interface VerifyFreshAuthInput {
  request: NextRequest;
  userId: string;
  accountId: string;
  now?: Date;
}

export function signFreshAuthStamp(input: FreshAuthStampInput): string {
  const issuedAtMs = (input.issuedAt ?? new Date()).getTime();
  const payload = String(issuedAtMs);
  return signValue(payload, getSessionCookieSecret(), {
    message: (issuedAtValue) =>
      freshAuthMessage({ userId: input.userId, accountId: input.accountId, issuedAtValue }),
  });
}

export function setFreshAuthCookie(
  response: NextResponse,
  input: FreshAuthStampInput,
): void {
  response.cookies.set(FRESH_AUTH_COOKIE_NAME, signFreshAuthStamp(input), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: FRESH_AUTH_MAX_AGE_SECONDS,
  });
}

export function clearFreshAuthCookie(response: NextResponse): void {
  response.cookies.set(FRESH_AUTH_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
}

export async function requireDeleteDataDestructiveAuth(
  request: NextRequest,
  options: { now?: Date } = {},
): Promise<DeleteDataDestructiveAuthResult> {
  try {
    assertSameOrigin(request);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return { ok: false, response: jsonError('forbidden', 403) };
    }
    throw err;
  }

  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner;

  const freshAuth = verifyFreshAuthStamp({
    request,
    userId: owner.user.id,
    accountId: owner.accountId,
    now: options.now,
  });
  if (!freshAuth.ok) {
    return { ok: false, response: jsonError('fresh_auth_required', 403) };
  }

  let aal: Awaited<ReturnType<typeof requireAal2FromSupabase>>;
  try {
    aal = await requireAal2FromSupabase(
      cookieBackedServerClient(request) as SupabaseMfaAalClient,
    );
  } catch (err) {
    console.error('[account-offboarding/destructive-auth] AAL check failed:', err);
    return { ok: false, response: jsonError('mfa_check_failed', 403) };
  }
  if (!aal.ok) {
    return { ok: false, response: jsonError(aal.reason, 403) };
  }

  return { ok: true, user: owner.user, accountId: owner.accountId };
}

function verifyFreshAuthStamp(
  input: VerifyFreshAuthInput,
): { ok: true; issuedAt: Date } | { ok: false } {
  const raw = input.request.cookies.get(FRESH_AUTH_COOKIE_NAME)?.value;
  if (!raw) return { ok: false };

  const issuedAtValue = verifySignedValue(raw, getSessionCookieSecret(), {
    message: (value) =>
      freshAuthMessage({ userId: input.userId, accountId: input.accountId, issuedAtValue: value }),
  });
  if (issuedAtValue === null) return { ok: false };

  const issuedAtMs = Number(issuedAtValue);
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs <= 0) return { ok: false };

  const nowMs = (input.now ?? new Date()).getTime();
  const ageMs = nowMs - issuedAtMs;
  if (ageMs < 0 || ageMs > FRESH_AUTH_WINDOW_MS) return { ok: false };

  return { ok: true, issuedAt: new Date(issuedAtMs) };
}

// The wire value is only the timestamp — userId/accountId never travel in the
// cookie — but the signed MESSAGE binds all three, so a stolen stamp cannot be
// replayed against a different owner or account. Kept as a message() builder
// for `signValue`/`verifySignedValue` (#1370) rather than folded into a raw
// `${value}` embed, so sign and verify can never spell the message differently.
function freshAuthMessage(input: {
  userId: string;
  accountId: string;
  issuedAtValue: string;
}): string {
  return `${SIGNING_CONTEXT}:${input.userId}:${input.accountId}:${input.issuedAtValue}`;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE_HEADERS });
}
