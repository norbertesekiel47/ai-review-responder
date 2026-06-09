import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { requireOwnerWithAccount } from '@/lib/auth/route-helpers';
import { cookieBackedServerClient, type AppUser } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';

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
  return `${payload}.${freshAuthSignature({
    userId: input.userId,
    accountId: input.accountId,
    issuedAtMs,
  })}`;
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

  const parts = raw.split('.');
  if (parts.length !== 2) return { ok: false };

  const [issuedAtValue, providedSignature] = parts;
  if (!issuedAtValue || !providedSignature) return { ok: false };

  const issuedAtMs = Number(issuedAtValue);
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs <= 0) return { ok: false };

  const expectedSignature = freshAuthSignature({
    userId: input.userId,
    accountId: input.accountId,
    issuedAtMs,
  });
  if (!safeHexCompare(providedSignature, expectedSignature)) return { ok: false };

  const nowMs = (input.now ?? new Date()).getTime();
  const ageMs = nowMs - issuedAtMs;
  if (ageMs < 0 || ageMs > FRESH_AUTH_WINDOW_MS) return { ok: false };

  return { ok: true, issuedAt: new Date(issuedAtMs) };
}

function freshAuthSignature(input: {
  userId: string;
  accountId: string;
  issuedAtMs: number;
}): string {
  return createHmac('sha256', getSessionSecret())
    .update(`${SIGNING_CONTEXT}:${input.userId}:${input.accountId}:${input.issuedAtMs}`)
    .digest('hex');
}

function getSessionSecret(): string {
  const secret = process.env.SESSION_COOKIE_SECRET;
  if (!secret) throw new Error('SESSION_COOKIE_SECRET is not set');
  return secret;
}

function safeHexCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE_HEADERS });
}
