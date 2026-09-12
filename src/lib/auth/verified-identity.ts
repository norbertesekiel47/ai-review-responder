// The identity seam below the canonical Admin API gates (ADR 0025 D1).
// Ordinary routes accept only bearers after #1203. The permanent impersonation
// prefix retains its existing cookie behavior (ADR 0031 D6), chosen from the
// request path rather than a caller-supplied posture flag. The seam returns
// verified identity/AAL facts; role and strict AAL2 enforcement remain in the gate.
// Owner gates remain cookie-only and do not compose this seam.

import { NextRequest } from 'next/server';
import {
  createClient,
  isAuthApiError,
  isAuthError,
  isAuthRetryableFetchError,
} from '@supabase/supabase-js';
import { isAdminImpersonationApiRoute, normalizePath } from '@/lib/shared/protected-routes';
import { cookieBackedServerClient } from '@/lib/db/auth';
import { isBearerRequest, readBearerToken, type AdminTransport } from '@/lib/auth/admin-transport';

/**
 * A credential that has been proved authentic and live, reduced to the three facts
 * the gates decide on.
 *
 * `aal` is the assurance level as the transport reported it, or `null` when it
 * could not be read at all — the gate maps `null` to `mfa_check_failed` and a
 * readable non-`aal2` to `mfa_required`, which are different answers to the Admin
 * app (one says "run your MFA challenge", the other says "I could not tell").
 */
export interface VerifiedIdentity {
  authUserId: string;
  aal: string | null;
  // Cookie describes only the permanent impersonation exception, not Admin transport.
  transport: AdminTransport | 'cookie';
}

/**
 * A transport-level failure the caller can do nothing about — Supabase unreachable,
 * or something upstream answering 5xx. Thrown so it reaches the gate's existing
 * catch and becomes a 500 `internal_error` rather than a 401 that would make an
 * admin-wide outage look like a wall of bad credentials.
 *
 * What that 500 buys today, stated precisely because the first draft of this
 * comment overclaimed it: the gate's `internalError` writes a `console.error` line,
 * which is a queryable Vercel log and a distinguishable status — it is NOT a paged
 * alert. Nothing in `docs/runbooks/beta-launch-alerting.md` watches admin 5xx.
 * Routing this to an alert sink is real work and belongs to its own ticket (#1212);
 * the value here is that the signal is CORRECT and greppable, so that ticket has
 * something true to alert on.
 *
 * NOT exported, deliberately. The gate catches it as `unknown` and maps every
 * throw to the same 500, so an export would be a symbol with no consumer — which
 * `ci:fallow` correctly flagged. Its `name` still reaches the log through
 * `internalError`'s `console.error`, which is the whole point of the class. If a
 * caller ever needs to branch on it, export it in that change, not in advance.
 */
class IdentityTransportError extends Error {
  constructor(readonly cause: unknown) {
    super('Supabase identity transport failure');
    this.name = 'IdentityTransportError';
  }
}

/**
 * True for the RETURNED error shapes that mean "our infrastructure failed", never
 * "your credential is bad". Used by the BEARER arm only — see
 * `resolveCookieIdentity` for why the cookie arm deliberately has no equivalent.
 *
 * Measured against @supabase/auth-js 2.106.2, `lib/fetch.js` `handleError`, which
 * raises FIVE shapes. Three are faults and are matched here:
 *
 *   1. `AuthRetryableFetchError` — a transport failure, or a status in its list
 *      (502/503/504/520-524/530).
 *   2. `AuthUnknownError` — `await error.json()` THREW, so whatever answered was
 *      not GoTrue: an HTML 502 from a CDN, a WAF block page, a truncated body.
 *      Infrastructure by construction at any status, and it shares a name with
 *      neither of the others, so omitting it turns an outage into 401s. This arm
 *      was missing until the review wave; two independent reviewers found it.
 *   3. `AuthApiError(message, status || 500, code)` — the fallback, INCLUDING a
 *      plain HTTP 500 with a JSON body. So a GoTrue 500 is an ordinary
 *      `AuthApiError` and is caught by the status test, not by a name test.
 *
 * The other two are genuine CREDENTIAL refusals and correctly fall through to 401:
 * `AuthSessionMissingError` (the token's session is gone — sign-out or revoke, the
 * case `getUser` exists to catch) and `AuthWeakPasswordError` (a password-grant
 * response we never trigger on this path). An earlier draft of this comment said
 * "exactly three shapes", which was a second false enumeration where the first had
 * been; round 2 of the red team caught it. The ARM is complete either way — this
 * paragraph is why.
 *
 * The predicates compare `error.name` (`lib/errors.js`), so they keep working
 * across a duplicated module instance where `instanceof` would not. There is no
 * exported `isAuthUnknownError`, so its name is spelled here the same way.
 */
function isTransportFailure(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return true;
  if (isAuthError(error) && error.name === 'AuthUnknownError') return true;
  return isAuthApiError(error) && (error.status ?? 500) >= 500;
}

/** Zero-leeway expiry, mirroring auth-js `validateExp` (`lib/helpers.js:270-276`). */
function isExpired(exp: unknown): boolean {
  if (typeof exp !== 'number') return true;
  return exp <= Math.floor(Date.now() / 1000);
}

/**
 * Today's path, unchanged (ADR 0025 D4, ticket #1183 §2 "byte-for-byte… Do not
 * touch it"): the cookie-backed SSR client's `getUser()` for identity and liveness,
 * and `getAuthenticatorAssuranceLevel()` for the assurance level. Uniformity with
 * the bearer arm is not worth re-verifying a path that works.
 *
 * Returns `null` for "no live cookie session" — including a returned auth error
 * such as `AuthSessionMissingError`, which is a refusal (401) and not a fault.
 *
 * **`isTransportFailure` is deliberately NOT applied here**, and the omission is
 * the point rather than an oversight. Today `getCurrentUser` ignores `getUser`'s
 * `error` entirely and `requireCurrentAal2FromSupabase` answers `mfa_check_failed`
 * on any AAL error, so a Supabase fault on the cookie path is a 401/403. Adding the
 * bearer arm's fault classification here would silently move those to 500 — a third
 * and fourth undeclared cookie-path behaviour change, on the path this ticket is
 * told not to touch, and the one with real operational blast radius. The review
 * wave caught exactly that and it was reverted. The bearer arm is NEW behaviour and
 * may classify its own faults; this arm may not.
 */
export async function resolveCookieIdentity(
  request: NextRequest,
): Promise<VerifiedIdentity | null> {
  const supabase = cookieBackedServerClient(request);

  const { data } = await supabase.auth.getUser();
  const authUser = data?.user;
  if (!authUser) return null;

  const aalResult = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

  return {
    authUserId: authUser.id,
    // `error || !data` is the "unreadable" case today; a readable `currentLevel`
    // of null passes straight through as null and means the same thing.
    aal: aalResult.error || !aalResult.data ? null : aalResult.data.currentLevel,
    transport: 'cookie',
  };
}

/**
 * The bearer arm: `getClaims` for the verified signature and the `aal` claim, THEN
 * `getUser` for liveness (ADR 0025 D3, in that order).
 *
 * `getUser` is not an optimization to remove. `getClaims` verifies a signature
 * locally and is blind to revocation, so dropping the round-trip would leave a
 * signed-out or revoked admin working for up to `JWT_EXP` (3600s) — on the admin
 * control plane. It is the same round-trip the cookie path already pays, which is
 * why the permanent cookie exception and ordinary bearer calls retain equal trust.
 *
 * `getAuthenticatorAssuranceLevel(jwt)` is deliberately NOT used: research #1160
 * finding 2b measured that it decodes `aal` WITHOUT verifying the signature and
 * then makes a network call — worse than `getClaims` on both axes.
 */
async function resolveBearerIdentity(request: NextRequest): Promise<VerifiedIdentity | null> {
  const token = readBearerToken(request);
  if (token === null) return null;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // `allowExpired` and the explicit exp test below replace auth-js's own
  // `validateExp`, which throws a PLAIN Error('JWT has expired') that escapes
  // getClaims — leaving the caller to classify it by MESSAGE. The house rule
  // (src/lib/auth/reset-password-error.ts) is to match on code, never text, so the
  // exception channel is removed rather than pattern-matched. Expiry stays closed
  // twice over: here, and at the getUser round-trip below.
  //
  // THE CATCH IS SCOPED TO THIS AWAIT ON PURPOSE. getClaims does not funnel every
  // bad token through its AuthError channel: `decodeJWT` regex-checks the three
  // segments and then JSON.parses them, so an attacker-supplied `ew.e30.AA` (header
  // decodes to `{`) throws SyntaxError and `bnVsbA.e30.AA` (header decodes to
  // `null`) throws TypeError, both escaping raw. Those are malformed credentials —
  // 401 — and treating an escaping throw as a fault would let an unauthenticated
  // caller force 500s on the admin control plane with a two-character token.
  let claimsResult: Awaited<ReturnType<typeof supabase.auth.getClaims>>;
  try {
    claimsResult = await supabase.auth.getClaims(token, { allowExpired: true });
  } catch (err) {
    if (isTransportFailure(err)) throw new IdentityTransportError(err);
    return null;
  }
  if (isTransportFailure(claimsResult.error)) throw new IdentityTransportError(claimsResult.error);
  const claims = claimsResult.data?.claims;
  if (!claims) return null;
  if (isExpired(claims.exp)) return null;

  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.length === 0) return null;

  let userResult: Awaited<ReturnType<typeof supabase.auth.getUser>>;
  try {
    userResult = await supabase.auth.getUser(token);
  } catch (err) {
    if (isTransportFailure(err)) throw new IdentityTransportError(err);
    return null;
  }
  if (isTransportFailure(userResult.error)) throw new IdentityTransportError(userResult.error);
  if (!userResult.data?.user) return null;

  return {
    // `claims.sub` and not `user.id`: the locally VERIFIED source owns the identity,
    // and the two derive from the same token anyway.
    authUserId: sub,
    aal: typeof claims.aal === 'string' ? claims.aal : null,
    transport: 'bearer',
  };
}

/**
 * Bearer-only Admin API identity, with the permanent impersonation exception.
 * Both this seam and the proxy use the same segment-bounded path predicate.
 * Inside the exception, an Authorization header still suppresses cookies even
 * when malformed; no bearer refusal can fall back to an ambient session.
 */
export async function resolveAdminApiIdentity(
  request: NextRequest,
): Promise<VerifiedIdentity | null> {
  if (isAdminImpersonationApiRoute(normalizePath(request.nextUrl.pathname)) && !isBearerRequest(request)) {
    return resolveCookieIdentity(request);
  }
  return resolveBearerIdentity(request);
}
