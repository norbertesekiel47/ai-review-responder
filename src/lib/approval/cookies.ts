import { randomUUID, createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookieSecret } from '@/lib/shared/session-cookie-secret';
import { constantTimeEqual, signValue, verifySignedValue } from '@/lib/shared/signed-value';

const DEVICE_COOKIE_NAME = '__device';
const CSRF_COOKIE_NAME = '__csrf';
const DEVICE_COOKIE_MAX_AGE = 172800; // 48 hours in seconds


// ── Device Cookie (HMAC-signed, HttpOnly) ─────────────────────────────

/**
 * Generates a signed device cookie and sets it on the response.
 * Format: `{uuid}.{hmac}` — the HMAC signs the UUID with SESSION_COOKIE_SECRET.
 * Returns the full cookie value (uuid.hmac).
 */
export function setDeviceCookie(response: NextResponse): string {
  const value = randomUUID();
  const signed = signValue(value, getSessionCookieSecret());

  response.cookies.set(DEVICE_COOKIE_NAME, signed, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: DEVICE_COOKIE_MAX_AGE,
  });

  return signed;
}

/**
 * Reads the device cookie and returns SHA-256(cookieValue) for DB comparison.
 * Returns null if the cookie is missing or has an invalid HMAC signature.
 */
export function getDeviceCookieHash(request: NextRequest): string | null {
  const cookie = request.cookies.get(DEVICE_COOKIE_NAME);
  if (!cookie?.value) return null;

  if (!verifyDeviceCookie(request)) return null;

  return createHash('sha256').update(cookie.value).digest('hex');
}

/**
 * Verifies the HMAC signature of the device cookie.
 * Returns false if cookie is missing, malformed, or tampered.
 */
export function verifyDeviceCookie(request: NextRequest): boolean {
  const cookie = request.cookies.get(DEVICE_COOKIE_NAME);
  if (!cookie?.value) return false;

  return verifySignedValue(cookie.value, getSessionCookieSecret()) !== null;
}

// ── CSRF Cookie (double-submit pattern, NOT HttpOnly) ─────────────────

/**
 * Generates a CSRF token and sets it as a cookie.
 * NOT HttpOnly — JavaScript needs to read it and send as a header.
 * Returns the token value.
 */
export function setCsrfCookie(response: NextResponse): string {
  const token = randomUUID();

  response.cookies.set(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // JS must read this
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: DEVICE_COOKIE_MAX_AGE,
  });

  return token;
}

/**
 * Validates the CSRF token by comparing the x-csrf-token header
 * with the __csrf cookie value (double-submit pattern).
 */
export function validateCsrf(request: NextRequest): boolean {
  const headerToken = request.headers.get('x-csrf-token');
  const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value;

  if (!headerToken || !cookieToken) return false;
  return constantTimeEqual(headerToken, cookieToken);
}
