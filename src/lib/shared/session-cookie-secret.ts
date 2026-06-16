/**
 * Single authoritative reader for SESSION_COOKIE_SECRET — used by every HMAC
 * consumer (approval device cookies, Zernio connect cookies, account-offboarding
 * keep-my-data tokens + destructive fresh-auth). Throws if unset or weaker than a
 * 256-bit (32-byte) HMAC-SHA256 key. (F-16)
 */
export function getSessionCookieSecret(): string {
  const secret = process.env.SESSION_COOKIE_SECRET;
  if (!secret) throw new Error('SESSION_COOKIE_SECRET is not set');
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('SESSION_COOKIE_SECRET must be at least 32 bytes (256-bit HMAC key)');
  }
  return secret;
}
