import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { getSessionCookieSecret } from '@/lib/shared/session-cookie-secret';

/**
 * HMAC-signed cookie for the Zernio connect session.
 *
 * Format: `{sessionId}.{hmac}` where hmac = HMAC-SHA256(sessionId, SESSION_COOKIE_SECRET).
 * Mirrors the device cookie pattern in `src/lib/approval/cookies.ts` so the
 * verification surface in the codebase stays uniform.
 *
 * Cookie attributes (spec §3.2 round-2 fix):
 *   - HttpOnly       — JS must not read it
 *   - Secure         — production only (locked by NODE_ENV)
 *   - SameSite=Lax   — survives the OAuth top-level redirect from Zernio
 *   - Path=/         — must reach /api/zernio/connect/select-location and /cancel
 *   - Max-Age=900    — 15 min, matches connect_locations Redis TTL
 */

export const ZERNIO_CONNECT_COOKIE_NAME = 'zernio_connect_session';
const COOKIE_MAX_AGE_SECONDS = 900; // 15 min


function safeHexCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Sets the signed connect-session cookie on the given response.
 */
export function setConnectSessionCookie(
  response: NextResponse,
  sessionId: string,
): void {
  const hmac = createHmac('sha256', getSessionCookieSecret())
    .update(sessionId)
    .digest('hex');
  const signed = `${sessionId}.${hmac}`;

  response.cookies.set(ZERNIO_CONNECT_COOKIE_NAME, signed, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

/**
 * Reads + verifies the signed cookie. Returns the raw sessionId on success,
 * null on missing / malformed / tampered.
 */
export function readConnectSessionCookie(request: NextRequest): string | null {
  const cookie = request.cookies.get(ZERNIO_CONNECT_COOKIE_NAME);
  if (!cookie?.value) return null;
  return verifySignedConnectSessionValue(cookie.value);
}

/**
 * Server-component-friendly variant. Verifies a raw signed cookie string
 * (the same format produced by `setConnectSessionCookie`) and returns the
 * sessionId on success, or null on missing / malformed / tampered. Used by
 * `/dashboard/connect/select-location` which reads cookies via
 * `next/headers` rather than receiving a `NextRequest`.
 */
export function verifySignedConnectSessionValue(
  signedValue: string | undefined | null,
): string | null {
  if (!signedValue) return null;

  const parts = signedValue.split('.');
  if (parts.length !== 2) return null;

  const [sessionId, providedHmac] = parts;
  if (!sessionId || !providedHmac) return null;

  const expectedHmac = createHmac('sha256', getSessionCookieSecret())
    .update(sessionId)
    .digest('hex');

  if (!safeHexCompare(providedHmac, expectedHmac)) return null;
  return sessionId;
}

/**
 * Clears the connect-session cookie (used on cancel + after select-location
 * succeeds). Path/secure/sameSite must match the set call so browsers actually
 * remove the cookie.
 */
export function clearConnectSessionCookie(response: NextResponse): void {
  response.cookies.set(ZERNIO_CONNECT_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
