// Edge-safe header parsing: no SDK, database or environment access.
// Cookie mode survives only for permanent impersonation. There, header presence
// still suppresses the cookie so malformed Authorization never falls back.

/** The Admin app's sole credential transport after #1203 (ADR 0031 D6). */
export type AdminTransport = 'bearer';

/**
 * TRUE when the caller presented an `Authorization` header AT ALL — well-formed or
 * not, empty or not.
 *
 * Within the permanent impersonation exception, presence alone suppresses cookies.
 * The **Admin transport** precedence rule is "when the header is present the cookie
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
