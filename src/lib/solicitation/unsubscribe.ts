import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getSessionCookieSecret } from '@/lib/shared/session-cookie-secret';

/**
 * Unsubscribe token primitives (#644; plan §1.4a + §1.8). Pure and stateless —
 * no database work lives here, deliberately: the admission gate below is what
 * lets both opt-out surfaces stay unrate-limited (spec §9.2 forbids throttling a
 * statutory opt-out) without leaving an unbounded public path to Postgres.
 *
 * HMAC precedent: src/lib/account-offboarding/tokens.ts — same secret, same
 * versioned-context-string convention, same "only the SHA-256 hash is ever
 * persisted" posture (invariant #5). Node's own crypto throughout (invariant #10).
 *
 * Rotating SESSION_COOKIE_SECRET invalidates every already-delivered unsubscribe
 * link. That is an accepted document-only constraint, not an oversight — see
 * docs/superpowers/plans/feat-644-unsubscribe-opt-out-deviations.md D1. Do not
 * add a previous-secret fallback, and do not make the gate fail open.
 */

// Distinct from the receipt context so a MAC minted for one domain can never
// verify in the other.
const UNSUBSCRIBE_TOKEN_CONTEXT = 'repworth:solicitation-unsubscribe-token:v1';
const UNSUBSCRIBE_RECEIPT_CONTEXT = 'repworth:unsubscribe-receipt:v1';

// 16 bytes = 128 bits. The nonce only has to be unique — the MAC, not the nonce,
// is what makes a token unforgeable — and 128 bits makes a collision across
// every token this system will ever mint negligible.
const NONCE_BYTES = 16;

const RECEIPT_TTL_MS = 10 * 60 * 1000;

// Minted shapes are 66 chars (22-char nonce + '.' + 43-char MAC) and 57 chars
// (13-digit epoch ms + '.' + 43-char MAC). Bounding the input first means a
// megabyte of junk costs one length compare instead of an HMAC over it.
const MAX_SIGNED_INPUT_LENGTH = 128;

// Both halves are base64url so the whole token is URL-safe without escaping.
// `.` is outside the class, so exactly one separator can match.
const TOKEN_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Invariant #5/#10. Exported for #630's minting so one function owns the digest. */
export function hashUnsubscribeToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Mints `<nonce>.<HMAC-SHA256(secret, nonce)>`. #630 MUST call this rather than
 * rolling its own random string, or every delivered link fails the gate below.
 * Exporting the minter — not just a description of the format — is what makes
 * that constraint unbreakable.
 */
export function mintUnsubscribeRawToken(): string {
  const nonce = randomBytes(NONCE_BYTES).toString('base64url');
  return `${nonce}.${signNonce(nonce)}`;
}

/**
 * The admission gate. Constant-time, stateless, ZERO database work — every entry
 * point calls this FIRST, so a forged or random string is rejected by one HMAC
 * compare without a connection ever being opened.
 *
 * Total over hostile input: any string returns a boolean. It does throw when
 * SESSION_COOKIE_SECRET is unset, and that is intentional — a misconfiguration
 * that silently reclassified every real opt-out as malformed would be a silent
 * statutory failure, so it has to surface.
 */
export function isWellFormedUnsubscribeToken(rawToken: string): boolean {
  if (rawToken.length > MAX_SIGNED_INPUT_LENGTH) return false;
  if (!TOKEN_SHAPE_RE.test(rawToken)) return false;

  const separator = rawToken.indexOf('.');
  const nonce = rawToken.slice(0, separator);
  return macMatches(signNonce(nonce), rawToken.slice(separator + 1));
}

/**
 * Server-minted evidence that a suppression existed when the redemption
 * committed, carried through the POST→redirect→GET hop without a cookie.
 *
 * NOT an authorisation token: it authorises nothing and grants no access. It
 * gates only whether the success view MAY be shown (plan §1.8); whether the
 * claim is actually true comes from a live ledger read at render time.
 */
export function mintUnsubscribeReceipt(tokenHash: string, issuedAtMs: number): string {
  return `${issuedAtMs}.${signReceipt(tokenHash, issuedAtMs)}`;
}

/** Total over hostile input, same contract as the token gate above. */
export function verifyUnsubscribeReceipt(tokenHash: string, receipt: string): boolean {
  if (receipt.length > MAX_SIGNED_INPUT_LENGTH) return false;

  const separator = receipt.indexOf('.');
  if (separator === -1) return false;

  const issuedAtRaw = receipt.slice(0, separator);
  // Digits only: Number() would otherwise accept '', ' 12', '1e3' and '0x10'.
  if (!/^\d+$/.test(issuedAtRaw)) return false;

  const issuedAtMs = Number(issuedAtRaw);
  if (!Number.isSafeInteger(issuedAtMs)) return false;
  // Only the upper bound is enforced. A future-dated receipt can only come from
  // our own mint under a fast clock, and rejecting one would break the common
  // case — verifying moments after minting, on a different host.
  if (Date.now() - issuedAtMs > RECEIPT_TTL_MS) return false;

  return macMatches(signReceipt(tokenHash, issuedAtMs), receipt.slice(separator + 1));
}

function signNonce(nonce: string): string {
  return createHmac('sha256', getSessionCookieSecret())
    .update(`${UNSUBSCRIBE_TOKEN_CONTEXT}:${nonce}`)
    .digest('base64url');
}

function signReceipt(tokenHash: string, issuedAtMs: number): string {
  return createHmac('sha256', getSessionCookieSecret())
    .update(`${UNSUBSCRIBE_RECEIPT_CONTEXT}:${tokenHash}:${issuedAtMs}`)
    .digest('base64url');
}

function macMatches(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  // timingSafeEqual throws on unequal lengths. Comparing them first leaks
  // nothing secret: the MAC width is fixed and public.
  if (expectedBytes.length !== candidateBytes.length) return false;
  return timingSafeEqual(expectedBytes, candidateBytes);
}
