// src/lib/auth/admin-transport.ts
//
// The **Admin transport** predicate (docs/context/core-accounts-channels-admin.md;
// ADR 0025 D6/D7). ONE owner for "is this request presenting a bearer", because
// this module and `src/proxy.ts` both consume it (#1185) and two copies of that
// test can disagree — a disagreement is either a bypass or a dead route.
//
// EDGE-SAFE, and that is a hard constraint rather than a nicety: `src/proxy.ts`
// runs on the Edge runtime, so nothing here may import `node:*`, touch the
// database, construct a Supabase client, or read `process.env`. Header parsing
// only.

/** Which credential a request to the Admin API is presenting. */
export type AdminTransport = 'cookie' | 'bearer';

/**
 * TRUE when the caller presented an `Authorization` header AT ALL — well-formed or
 * not, empty or not.
 *
 * Presence alone is the transport choice, and that is deliberate. The glossary's
 * **Admin transport** rule is "a bearer wins: when the header is present the cookie
 * is ignored entirely", so a request carrying `Authorization: Basic …` beside a
 * perfectly good admin session cookie is refused rather than silently authenticated
 * by the cookie. A "non-empty" or "well-formed" reading here would reopen exactly
 * that fallback: send a malformed header, get the cookie's authority.
 *
 * `readBearerToken` is the separate well-formedness question. Both refuse the same
 * requests — a malformed header selects the bearer arm and then yields no token —
 * so the two readings can only ever converge on a refusal, never on an acceptance.
 */
export function isBearerRequest(request: { headers: Headers }): boolean {
  return request.headers.has('authorization');
}

/**
 * The token from `Authorization: Bearer <token>`, or `null` when the header is
 * absent or malformed.
 *
 * The scheme is matched case-insensitively (RFC 7235 §2.1: the scheme is a
 * case-insensitive token), and the credential is a single RFC 6750 `token68` — it
 * contains no internal whitespace, so `Bearer t extra` is malformed rather than a
 * token of `t`. Returning the first word there would let a caller smuggle a valid
 * token past a naive log or filter that reads the whole header value.
 */
export function readBearerToken(request: { headers: Headers }): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;

  const match = /^Bearer[ \t]+([^\s]+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}
