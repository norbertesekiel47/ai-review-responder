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
 * Constant-time string compare. Decodes both inputs under `encoding` (default
 * `utf8`) and compares the resulting BYTE lengths before calling
 * `timingSafeEqual` — never the input strings' `.length` — so a mismatch never
 * throws, regardless of encoding:
 *
 * - Malformed/truncated hex (`Buffer.from(str, 'hex')` silently drops the tail
 *   at the first invalid character rather than throwing) produces a shorter
 *   buffer, caught by the byte-length check instead of surfacing as an
 *   uncaught `timingSafeEqual` "Input buffers must have the same byte length".
 * - A multi-byte UTF-8 character can make two equal-`.length` JS strings decode
 *   to different byte counts; the same byte-length check catches that too.
 *
 * Both cases return `false` (not a match — correct) instead of throwing. This
 * generalizes the `a.length !== b.length` guard four of the seven original call
 * sites already carried (three of them additionally wrapped the decode+compare
 * in a try/catch for exactly the malformed-hex case above); no site loses
 * protection, and the two that only had a JS-length check gain byte-length
 * safety they lacked. The comparison itself, and what a mismatch reveals
 * (lengths differ — already observable pre-comparison, same as before), is
 * unchanged.
 */
export function constantTimeEqual(
  a: string,
  b: string,
  encoding: BufferEncoding = 'utf8',
): boolean {
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
