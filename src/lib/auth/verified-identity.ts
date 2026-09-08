// src/lib/auth/verified-identity.ts
//
// The identity seam that sits BELOW the canonical admin gates (ADR 0025 D1). It
// turns a NextRequest into a verified `{ authUserId, aal, transport }` and DECIDES
// NOTHING: no role check, no AAL enforcement, no feature-flag read. The gate keeps
// deciding, which is what lets the bearer arm be added without widening the auth
// surface of `requireRole` — about 40 owner and mixed-role routes reach that
// through `requireRoleOr401`, and none of them asked to accept a bearer.
//
// TWO SIBLING RESOLVERS, never one with a posture parameter. This copies the
// **Channel actor** rule verbatim (src/app/api/_shared/channels/resolve-actor.ts):
// which transports a caller may present is a security boundary, and a boolean
// argument would turn a structural fact into a runtime branch.
//
// Their EXPORTS are deliberately asymmetric, which is not a contradiction of that:
// `resolveCookieIdentity` is named by the ticket and is the delegation target, so it
// is exported; `resolveBearerIdentity` is private, because exporting it would hand a
// caller a way to take the bearer arm WITHOUT the transport decision — the one thing
// the predicate exists to own. Siblings in structure, not in reachability.
//
// Terms: docs/context/core-accounts-channels-admin.md → **Admin transport**,
// **Verified admin**.

import { NextRequest } from 'next/server';
import {
  createClient,
  isAuthApiError,
  isAuthError,
  isAuthRetryableFetchError,
} from '@supabase/supabase-js';
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
  transport: AdminTransport;
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
 * Routing this to an alert sink is real work and belongs to its own ticket; the
 * value here is that the signal is CORRECT and greppable, so that ticket has
 * something true to alert on.
 */
export class IdentityTransportError extends Error {
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
 * raises exactly three shapes and each needs its own test:
 *
 *   1. `AuthRetryableFetchError` — a transport failure, or a status in its list
 *      (502/503/504/520-524/530).
 *   2. `AuthUnknownError` — `await error.json()` THREW, so whatever answered was
 *      not GoTrue: an HTML 502 from a CDN, a WAF block page, a truncated body.
 *      Infrastructure by construction at any status, and it is neither of the
 *      other two names, so omitting it turns an outage into 401s. This arm was
 *      missing until the review wave; two independent reviewers found it.
 *   3. `AuthApiError(message, status || 500, code)` — everything else, INCLUDING a
 *      plain HTTP 500 with a JSON body. So a GoTrue 500 is an ordinary
 *      `AuthApiError` and is caught by the status test, not by a name test.
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
 * what makes the two transports carry equal trust on the same routes.
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
 * The dual-mode entry point: the bearer when the request presents an
 * `Authorization` header, and otherwise a DELEGATION to `resolveCookieIdentity`, so
 * the cookie path keeps exactly one owner.
 *
 * Presence of the header — not its well-formedness — selects the bearer arm. That
 * is the glossary's "a bearer wins": a malformed `Authorization` beside a valid
 * session cookie is refused, never quietly authenticated by the cookie.
 */
export async function resolveDualModeIdentity(
  request: NextRequest,
): Promise<VerifiedIdentity | null> {
  return isBearerRequest(request)
    ? resolveBearerIdentity(request)
    : resolveCookieIdentity(request);
}
