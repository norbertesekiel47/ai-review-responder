// src/lib/shared/signed-value.ts
//
// Single owner of two HMAC-signed-value primitives that had drifted into seven
// separate `timingSafeEqual` call sites across six files (#1370; audit LOW-2):
// `src/lib/approval/cookies.ts` (x2), `src/lib/zernio/connect-session-cookie.ts`,
// `src/lib/admin/impersonation/cookie.ts`, `src/lib/shared/feedback-hmac.ts`,
// `src/lib/solicitation/unsubscribe.ts`, `src/lib/account-offboarding/destructive-auth.ts`.
// Not a vulnerability at the time (every compare was already constant-time) —
// this is the drift risk of one primitive re-implemented seven times.
//
// `constantTimeEqual` is the general-purpose compare; `signValue`/`verifySignedValue`
// are the `<value>.<mac>` cookie/token convention layered on top of it. A site
// whose wire format does not fit that convention (a bare externally-supplied
// signature, or a rollover-aware multi-key verify) delegates only to
// `constantTimeEqual` — forcing every HMAC user through `signValue` would have
// widened this module past what #1370 asked for.
//
// WIRE COMPATIBILITY IS THE POINT: every option below defaults to the most
// common shape in the codebase (HMAC-SHA256, hex digest, hex compare, `.`
// separator, message = the value itself) so the four sites that already used
// exactly that shape are a drop-in swap. The two deliberate outliers —
// `admin/impersonation/cookie.ts` compares the hex digest as UTF-8 TEXT rather
// than decoding it, and `account-offboarding/destructive-auth.ts` signs a
// message that embeds more than the wire value — are reproduced via
// `compareEncoding` and `message`, never "fixed", because either change would
// invalidate every cookie/token already issued under the old code.

import { createHmac, timingSafeEqual, type BinaryToTextEncoding } from 'node:crypto';

const DEFAULT_ALGORITHM = 'sha256';
const DEFAULT_DIGEST_ENCODING: BinaryToTextEncoding = 'hex';
const DEFAULT_COMPARE_ENCODING: BufferEncoding = 'hex';
const DEFAULT_SEPARATOR = '.';

function identity(value: string): string {
  return value;
}

/**
 * Constant-time string compare. TWO length checks, deliberately, not one:
 *
 * 1. STRING length first (`a.length !== b.length`, the guard four of the seven
 *    original call sites already carried) — REQUIRED, not redundant. With a
 *    hex `encoding`, `Buffer.from(str, 'hex')` silently drops a trailing
 *    partial byte or any invalid tail rather than throwing:
 *    `Buffer.from('deadbeef', 'hex')` and `Buffer.from('deadbeef0', 'hex')`
 *    (odd nibble appended) and `Buffer.from('deadbeefzz', 'hex')` (invalid
 *    trailing chars) all decode to the identical 4 bytes. Without this check,
 *    a genuine 64-char MAC with ANY garbage appended after it would decode to
 *    the same bytes as the real MAC and wrongly compare equal — accepting a
 *    string that is not the one that was issued. Caught here, before any
 *    decode: a length mismatch this cheap does not need constant time.
 * 2. BYTE length second, after decoding under `encoding` (default `utf8`) —
 *    still needed because it catches what the string check cannot: a
 *    multi-byte UTF-8 character can make two EQUAL-`.length` JS strings decode
 *    to different byte counts (e.g. `'é'` vs `'a'`, both length 1), and this
 *    is also what makes decoding never throw — `timingSafeEqual` throws on a
 *    byte-length mismatch, so this check subsumes the try/catch three of the
 *    seven originals wrapped around it for the malformed-hex case above.
 *
 * Both length checks return `false` (not a match — correct), never throw. What
 * a mismatch reveals (lengths differ) is already observable pre-comparison,
 * same as before.
 */
export function constantTimeEqual(
  a: string,
  b: string,
  encoding: BufferEncoding = 'utf8',
): boolean {
  if (a.length !== b.length) return false;
  const aBytes = Buffer.from(a, encoding);
  const bBytes = Buffer.from(b, encoding);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

export interface SignedValueOptions {
  /** HMAC algorithm. Default `'sha256'`. */
  algorithm?: string;
  /** Encoding `.digest()` is asked for. Default `'hex'`. */
  digestEncoding?: BinaryToTextEncoding;
  /**
   * Encoding the two MAC strings are decoded under before the constant-time
   * compare. Default `'hex'` (decode-and-compare-as-bytes). Set to `'utf8'` to
   * reproduce a site that compares the digest string itself as text — the
   * `admin/impersonation/cookie.ts` deviation the module intentionally
   * preserves rather than normalizes.
   */
  compareEncoding?: BufferEncoding;
  /** Joins `value` and the MAC. Default `'.'`. */
  separator?: string;
  /**
   * Derives the bytes actually signed from the wire value. Default: the value
   * itself. Set this when the wire value is only part of the signed message —
   * `account-offboarding/destructive-auth.ts` signs
   * `${context}:${userId}:${accountId}:${issuedAtMs}` but only `issuedAtMs`
   * travels in the cookie.
   */
  message?: (value: string) => string;
}

/**
 * Signs `value` and returns `<value><separator><mac>` (default `<value>.<hex-mac>`).
 */
export function signValue(
  value: string,
  secret: string,
  options: SignedValueOptions = {},
): string {
  const {
    algorithm = DEFAULT_ALGORITHM,
    digestEncoding = DEFAULT_DIGEST_ENCODING,
    separator = DEFAULT_SEPARATOR,
    message = identity,
  } = options;
  const mac = createHmac(algorithm, secret).update(message(value)).digest(digestEncoding);
  return `${value}${separator}${mac}`;
}

/**
 * Verifies a `signValue`-shaped string and returns the embedded value, or
 * `null` on anything missing, malformed, or tampered (never throws on bad
 * input — the caller's secret being unconfigured is the one thing this still
 * lets propagate, matching every original call site).
 */
export function verifySignedValue(
  signed: string | undefined | null,
  secret: string,
  options: SignedValueOptions = {},
): string | null {
  if (!signed) return null;

  const {
    algorithm = DEFAULT_ALGORITHM,
    digestEncoding = DEFAULT_DIGEST_ENCODING,
    compareEncoding = DEFAULT_COMPARE_ENCODING,
    separator = DEFAULT_SEPARATOR,
    message = identity,
  } = options;

  const parts = signed.split(separator);
  if (parts.length !== 2) return null;

  const [value, providedMac] = parts;
  if (!value || !providedMac) return null;

  const expectedMac = createHmac(algorithm, secret).update(message(value)).digest(digestEncoding);
  return constantTimeEqual(providedMac, expectedMac, compareEncoding) ? value : null;
}
