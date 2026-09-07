# ADR 0025 — The dual-mode admin gate: a transport seam below the canonical gates

## Status

Accepted — 2026-09-07. Resolves wayfinder decision ticket #1161 on map #1159
(the admin split), consuming the bearer research in #1160. Refines ADR 0024 D4,
which locked *that* the gates go dual-mode; this ADR locks *how*.

Terms: `docs/context/core-accounts-channels-admin.md` → **Verified admin**,
**Admin transport** (coined here), **Admin app**, **Admin API**, **Legacy admin
portal**, **Channel actor**.

## Context

ADR 0024 D4 committed the **Admin API** to dual-mode auth on the same paths: the
canonical admin gates accept EITHER the session cookie (same-origin, the
**Legacy admin portal**) OR a Supabase access token as a bearer (cross-origin,
the **Admin app**). Nothing said where the transport branch lives, and four
mechanisms constrain it.

Facts measured at 2026-09-07, on `main` at 85b31e15:

- **Identity is cookie-only, everywhere.** `cookieBackedServerClient`
  (`src/lib/db/auth.ts:27-43`) builds an `@supabase/ssr` client from
  `request.cookies`; `getCurrentUser` (`:56-100`) calls `getUser()` on it and
  maps the auth identity to a `users` row; `requireRole` (`:116-125`) adds the
  role check. No route or gate reads an `Authorization` header.
- **`requireRole` is not an admin function.** About 40 owner, mixed-role and
  channel routes reach it through `requireRoleOr401`
  (`src/lib/auth/route-helpers.ts:86-99`).
- **The admin gate makes a SECOND Supabase call for AAL.**
  `requireAdminWithAal2` (`src/lib/auth/admin-mfa-gate.ts:55-90`) runs
  `requireRole(request,'admin')`, then `requireCurrentAal2FromSupabase`
  (`src/lib/auth/mfa.ts:29-40`) on a fresh cookie-backed client. The check is
  strict: `currentLevel === 'aal2'`.
- **`ci:admin-aal2` credits exactly three gate shapes**, and only when the local
  name is bound by an import that RESOLVES to the canonical module:
  `requireAdminWithAal2`, `requireAdminJson`, `resolveAdminActor`
  (`scripts/ci/admin-aal2-audit.ts:184,186,202-207`). Its ROUTES contract binds
  **mutation verbs only** (`:156`).
- **Nine admin GET handlers are outside that contract by design.** `costs` uses
  bare `requireRole`; `businesses`, `businesses/[id]`, `businesses/[id]/channels`,
  `demos`, `jobs`, `nav-counts`, `notifications` and `overview` use
  `requireRoleOr401`. All are role-only; none require AAL2.
- **`MFA_ENFORCEMENT_ENABLED` is OFF** (`.claude/reference/env-vars.md:652`), so
  the proxy's `getAalGate` (`src/proxy.ts:92-103`) returns `ok` without asking.
  An `aal1` admin can therefore read all nine GET routes today, while the
  AAL2-gated routes refuse the same admin.
- **`src/proxy.ts` branch 4 (`:138-151`) is the backstop.** It 401/403s
  `/api/admin*` from the cookie before any route runs, and its AAL step is the
  lenient form (`nextLevel === 'aal2' && currentLevel !== 'aal2'`), unlike the
  gate's strict one.
- **CSRF is applied at the export**, `export const POST = withSameOrigin()(handler)`
  (`src/lib/auth/route-helpers.ts:25-39` → `src/lib/shared/csrf.ts:8-38`). The
  gate deliberately does not handle it; a previous `{ sameOrigin: true }` opt-in
  flag was reverted for being forgettable (`admin-mfa-gate.ts:38-46`).

Facts inherited from research #1160, not re-derived here:

- Both Supabase projects sign `ES256`, so `auth.getClaims(jwt)` verifies the
  signature locally (JWKS cached ~10 min per warm process) and exposes the `aal`
  claim. It is blind to revocation until `exp` (default `JWT_EXP` 3600 s).
- `auth.getUser(jwt)` is the revocation-aware round-trip; it does not return the
  AAL.
- `getAuthenticatorAssuranceLevel(jwt)` decodes `aal` **without** verifying the
  signature and then makes a network call. It is worse than `getClaims` on both
  axes. With no argument on a bearer-only client it returns nulls, which the
  strict helper reports as `mfa_required` — closed, but for the wrong reason.
- AAL is session-bound. The **Admin app**'s own sign-in starts at `aal1` and must
  run its own MFA challenge; factors are per user, so an admin enrolled from the
  Legacy admin portal is already enrolled there.

## Decisions

1. **The transport branch lives in a new seam BELOW the gates, not inside
   `requireRole`.** The seam turns a `NextRequest` into a verified
   `{ authUserId, aal, transport }`. It performs no role check and no AAL
   enforcement — it returns facts, and the gates keep deciding. `requireRole`
   stays cookie-only, so the owner API's auth surface does not widen.

   The gates' exported names and result shapes are unchanged, so
   `ci:admin-aal2`'s allowlist is untouched. The bearer path is added INSIDE
   `requireAdminWithAal2`, exactly as ADR 0024's consequences require, and
   `requireAdminJson` and `resolveAdminActor` inherit it by composition.

2. **Two resolvers, not one with a posture parameter.** `resolveCookieIdentity`
   is today's path. `resolveDualModeIdentity` takes the bearer when an
   `Authorization: Bearer <token>` header is present and otherwise DELEGATES to
   the cookie resolver, so the cookie path keeps a single owner.

   This copies the **Channel actor** rule verbatim: `resolveAdminActor` reads
   `businessId` from the request body, `resolveOwnerActor` reads `locationId`
   from the session, and they are separate functions precisely because a
   boolean would make a tenant-isolation boundary a runtime branch. Which
   transports a caller may present is the same kind of boundary.

3. **`getClaims(jwt)` then `getUser(jwt)`.** `getClaims` supplies the verified
   signature and the `aal` claim; `getUser` supplies liveness. One network
   round-trip — exactly what the cookie path already pays on every request
   (`src/lib/db/auth.ts:20-26`) — so the two transports carry the same trust on
   the same routes.

   Rejected: `getClaims` alone. It is faster than cookie mode, and that is the
   problem: a signed, unexpired token would keep working for up to an hour after
   sign-out or after an admin is revoked, on the admin control plane. Also
   rejected: a kill switch over the `getUser` step, which is a flag whose only
   function is to silently weaken revocation.

4. **The cookie path's AAL read does not change.** Cookie mode keeps
   `getAuthenticatorAssuranceLevel()`; bearer mode reads `claims.aal`. The seam
   normalizes both. Uniformity is not worth re-verifying a path that works.

5. **All nine role-only GET handlers fold onto `requireAdminWithAal2`, and
   `ci:admin-aal2`'s ROUTES contract widens from mutation verbs to every
   exported handler under `src/app/api/admin/**`.** After this, "every Admin API
   handler calls a gate this audit has vetted" is a CI-enforced fact rather than
   a convention.

   This is the compensating control D6 spends. It is also what ADR 0024 D3
   already promised: the Admin API re-checks role and AAL2 on *every* request.

6. **`src/proxy.ts` branch 4 passes through when the request carries a
   well-formed bearer, and the route gate decides.** The proxy is not taught to
   verify tokens: that duplicates verification on the Edge, and the two copies
   drift — the lenient/strict AAL disagreement already in the tree is the worked
   example.

   The defense-in-depth consequence is stated, not hidden: **for a bearer, the
   route gate is the only admin check.** D5's widened audit is what makes that
   acceptable, and the two must land in that order.

   One predicate owns "is this bearer mode", and both `src/proxy.ts` and the
   seam import it. Two copies of that test can disagree, and a disagreement
   means either a bypass or a dead route.

7. **An `Authorization` header wins.** When it is present the cookie is ignored
   and the CSRF check is skipped. A cross-site page cannot add that header
   without a CORS preflight, and no CORS exists on this app
   (`next.config.mjs:24-63`), so the precedence rule is not a CSRF hole.

   > **Amended by ADR 0026 D7 (2026-09-07).** CORS now exists. The premise
   > "no CORS exists on this app" is stale; the operative control is the
   > **Admin origin allowlist** — only an allowlisted origin receives a
   > preflight that permits `Authorization`. The conclusion is unchanged.
   > Read `docs/adr/0026-admin-api-cors.md` D7 before relying on this decision.

8. **CSRF gets a second wrapper, `withSameOriginUnlessBearer()`, applied to admin
   mutation routes at the export.** `withSameOrigin()` keeps its meaning and
   owner routes are untouched.

   Rejected: exempting bearers inside `assertSameOrigin`. Every call site would
   inherit it, so an owner mutation authenticated by COOKIE would skip CSRF
   merely because the request also carried an `Authorization` header. Not
   reachable from a browser today, but it outlives the migration.

   Rejected: an unconditional same-origin check inside the gate. It cannot be
   forgotten, and it touches the gate twice rather than ~20 export lines twice
   across a migration window that is explicitly temporary — but it rewrites the
   convention a documented revert established, and leaves the repo with two CSRF
   mechanisms.

9. **A bearer refusal reuses the vocabulary the proxy and the gate already
   share.** No redirects: a cross-origin API must not redirect.

   | Case | Response |
   |---|---|
   | No token, bad signature, expired, or revoked | 401 `{ error: 'Unauthorized' }` |
   | Verified token, no `users` row or role is not `admin` | 403 `{ error: 'Forbidden' }` |
   | Verified token, `aal` is not `aal2` | 403 `{ error: 'mfa_required' }` |
   | `aal` claim missing or unreadable | 403 `{ error: 'mfa_check_failed' }` |

   All carry `NO_STORE_HEADERS`. The **Admin app** reads `mfa_required`, runs its
   own MFA challenge, and retries with the resulting `aal2` token.

10. **`MFA_ENFORCEMENT_ENABLED` never reaches the gate.** It gates the proxy's
    AAL step only (`src/proxy.ts:92-103`); `requireAdminWithAal2` is
    unconditional today and stays unconditional. Research #1160 open risk 4 names
    this exact trap.

## Consequences

- **Folding the nine GETs is a behaviour change for `aal1` admins, and it has a
  hard prerequisite.** With `MFA_ENFORCEMENT_ENABLED` off, the proxy does not
  redirect an `aal1` admin to `/mfa/challenge`, so a Legacy admin portal page
  would render (its server component reads the DB directly) while every client
  fetch returned 403, with no path to step up. Every admin must be enrolled and
  the flag flipped on BEFORE the fold ships. That flip is its own ticket, under
  the `flag-flip` skill.
- **The flag flip also affects owners**, but benignly: the proxy's lenient form
  passes an unenrolled user (`nextLevel` is `aal1`). Only enrolled-but-not-
  challenged users are redirected.
- **The Admin app still cannot call anything until CORS lands.** That is a
  separate map ticket; this ADR settles auth, not reachability.
- **`ci:admin-aal2`'s ROUTES contract grows**, so its own unit tests and
  fixtures grow with it (`scripts/ci/__tests__/admin-aal2-audit.test.ts`).
- **New files under `src/lib/` ship with their `docs/directory/` rows** in the
  same PR (`ci:directory-map`).
- **Revocation is closed, latency is not free.** Every bearer admin request pays
  one `getUser` round-trip plus a local JWKS verification. A JWKS rotation is a
  `kid` miss and one extra fetch per warm instance; a revoked OLD signing key
  still verifies for up to the 10-minute cache TTL (research #1160 open risk 5).
- **`aal2 → aal1` stale tokens remain open** (research #1160 open risk 2):
  removing an admin's factor does not invalidate outstanding `aal2` tokens.
  `getUser` closes sign-out and session revoke, not factor removal.
- **When cookie mode is removed** (ADR 0024 D4 end state), three things retire
  together: `resolveCookieIdentity` from the admin path,
  `withSameOriginUnlessBearer` from every admin export line, and the pass-through
  branch in `src/proxy.ts`.

## Alternatives rejected

- **Deepen `requireRole` with a bearer branch.** One function, no new module —
  but it puts the branch on the path about 40 owner and mixed-role routes take,
  widening an auth surface no ticket asked to widen.
- **A fourth gate shape for admin reads** (a bearer-aware, role-only read gate).
  It avoids the flag flip and changes no legacy behaviour, but it leaves admin
  reads below the bar ADR 0024 D3 sets, adds a second admin-gate concept, and
  keeps `src/proxy.ts` load-bearing because CI cannot credit the new shape.
- **Teach `src/proxy.ts` to verify bearers.** Full defense in depth, at the cost
  of a second verification implementation on the Edge that must be kept in step
  with the gate forever.
