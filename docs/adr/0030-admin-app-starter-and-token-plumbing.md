# ADR 0030 — The Admin app starter: two gates, hybrid token plumbing, no runtime secret

## Status

Accepted — 2026-09-07. Resolves wayfinder decision ticket #1168 on map #1159
(the admin split). It graduates the map's "what the Admin app's own server
components do with the token" fog patch, and it is the last decision the
second developer needs before they can start.

Depends on ADR 0024 (the split), ADR 0025 (the dual-mode gate), ADR 0026
(CORS) and ADR 0027 (the read gaps). It amends nothing.

Owner amendment — 2026-09-11, port #1224: D4 permits the optional public
`NEXT_PUBLIC_DOCS_BASE_URL` required by ADR 0027 D3. This resolves the
three-variable limit's conflict with the runbook's configurable documentation
links; the no-runtime-secret boundary is unchanged.

Owner amendment — 2026-09-11, port #1227: D4 also permits the optional public
`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` and Google Maps browser loader solely for
the Demos place picker. All Admin API data still crosses the fetch seam.

Terms: `docs/context/core-accounts-channels-admin.md` → **Admin app fetch
seam** (coined here), **Admin app**, **Admin API**, **Admin transport**,
**Verified admin**, **Admin origin allowlist**, **Legacy admin portal**.

## Context

#1166 provisioned the **Admin app**'s home. #1167 exported the component kit
into it. The repo now holds 33 files and no application. The ticket asked who
builds the starter, what the app does with the token, which variables it holds,
and what "the first page works" means.

Facts measured at 2026-09-07, on `main` at `d363eff4` and on
`RepWorth/admin-app` at `main`. **Every `ui-kit/...` path below is in
`RepWorth/admin-app`, not this repo**, so a citation checker run here will not
resolve it:

- **The handshake cannot be proven today, in any part.**
  `GET /api/admin/overview` gates on `requireRoleOr401(request, 'admin')`
  (`src/app/api/admin/overview/route.ts:14`) — cookie-only and role-only, one
  of the nine role-only admin GETs ADR 0025 folds. `src/proxy.ts:139` returns
  `401` for any `/api/admin*` request carrying no session cookie, before the
  route module loads. No `Authorization` header is read anywhere under
  `src/app/api/admin/**` or `src/lib/auth/**`. No `Access-Control-*` header is
  written anywhere. The proof therefore waits on #1184, #1185 and #1186.
- **The repo is not empty, so "starter versus empty repo" was never the
  choice.** `RepWorth/admin-app` holds `ui-kit/` (9 components, 8 test files,
  4 `lib/` modules, 4 `shell/` files) plus four docs. It has no
  `package.json`.
- **A server-side call needs neither CORS nor a CSRF exemption.** ADR 0026 D4:
  "A request with no `Origin` header is untouched." `assertSameOrigin` throws
  on a missing `Origin` (`src/lib/shared/csrf.ts:19`), but a bearer request
  never reaches it — ADR 0025 D8's `withSameOriginUnlessBearer` returns first.
- **The exported kit assumes same-origin cookie auth in two files.**
  `ui-kit/shell/nav-counts-query.ts` polls `fetch('/api/admin/nav-counts')`
  every 60 s with a relative URL and no `Authorization` header;
  `ui-kit/shell/AdminEnrollmentWidget.tsx:47-50` names four more relative
  `/api/admin/...` paths. In the Admin app those resolve to the Admin app's own
  origin, which serves no such route.
- **`ui-kit/lib/mfa-path.ts` carries a comment proposing a design that cannot
  work**: "Until this app hosts its own challenge screen, point it at the main
  app's origin."
- **An admin can read their own `users` row with the publishable key.**
  `users_self_select` (`supabase/migrations/006_users_rls_policy.sql:10-13`)
  grants `SELECT` on `users` to `authenticated` where
  `auth_id = auth.uid()::text`.
- **`ui-kit/lib/supabase-browser.ts:18-19` already reads
  `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`** — the
  publishable key, not this repo's legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  (`src/proxy.ts:51-52`).
- **The MFA pieces were deliberately not exported.** `useMfaEnrollment`
  (`src/components/auth/useMfaEnrollment.ts`, 293 lines) is imported by the
  `/admin/security` page rather than by the kit, so #1167 left it behind
  (`docs/EXPORT-MANIFEST.md` § Corrections 1). `AdminEnrollmentWidget` and
  `enrollment-contract.ts` are the **mobile-channel** enrollment widget, not
  MFA. `src/app/mfa/challenge/MfaChallengeForm.tsx` is 387 lines and stays
  here for impersonation.
- **Environment origins**: the **Admin API** is `https://staging.repworth.net`
  and `https://repworth.net`; the **Admin app** is
  `https://admin.staging.repworth.net` and `https://admin.repworth.net`
  (#1166 § item 6).

## Decisions

1. **The founder's side builds the starter, in TWO gates, and hand-over
   happens after the first.**

   **Gate A (#1196) — no blocking edge.** A Next.js 16 + pnpm application in
   `RepWorth/admin-app` carrying: the `@supabase/ssr` browser and server
   clients; the session-refresh middleware (D2's trap); a `/login` screen; the
   Admin app's OWN MFA challenge (D5); the shell wired to the exported
   `ui-kit/`; the **Admin app fetch seam** (D3); and a deploy to the staging
   Vercel Custom Environment on `admin.staging.repworth.net`.

   **Gate B (#1197) — blocked by #1184, #1185 and #1186 reaching staging.** The
   handshake proof: `/overview` renders real staging data through a bearer, a
   CSRF-wrapped `POST` succeeds, and an `aal1` session is refused. D8 is its
   checklist.

   The developer takes the repo after Gate A and builds pages during Gate B.

   Rejected: hand over the kit plus the contract and let the developer
   scaffold. The **Admin API contract** does not exist yet — #1190 is blocked
   by #1184 — so the developer would inherit only `docs/pages/page-inventory.md`,
   and they cannot read this repo to diagnose a refusal that originates in it.

   Rejected: one gate, hand-over after the proof. It is the cleaner hand-over
   and it idles the developer for the entire gate build.

2. **Token plumbing is HYBRID. Server components forward the bearer; client
   components call the Admin API cross-origin.**

   A server component reads the access token from the session cookie and
   `fetch`es the **Admin API** with `Authorization: Bearer`. That request
   carries no `Origin`, so the **Admin origin allowlist** never fires and no
   preflight is paid. A client component calls the **Admin API** directly,
   cross-origin, with the same bearer — the exact path ADR 0026's preflight
   contract and ADR 0025 D8 were built for.

   The rule the developer applies without asking: **what renders on first
   paint is a server fetch; what a user action triggers in the browser is a
   client fetch.** Both are `bearer` **Admin transport**.

   This is the closest port of the 21 **Legacy admin portal** pages, which are
   server components today.

   **Trap — a server component cannot write cookies.** Supabase rotates the
   access token, and only middleware or a route handler can persist the new
   one. Without `@supabase/ssr` middleware the Admin app forwards an expired
   token and every server-rendered page 401s once `JWT_EXP` (3600 s) elapses.
   The middleware is part of Gate A, not a later hardening step.

   Rejected: client-fetch only. One mental model and CORS proven by every
   page, but it turns each server-component page into a client component with
   its own loading state — a rewrite rather than a port — and pays a preflight
   on every mutation.

   Rejected: server-forward only, with Admin app route handlers proxying
   mutations same-origin. No CORS anywhere, at the cost of making ADR 0026's
   whole build dead weight, doubling the route surface, and putting a second
   undocumented contract between the developer and the **Admin API**.

3. **One module owns every Admin API call: the Admin app fetch seam.**

   It owns `NEXT_PUBLIC_ADMIN_API_URL` and attaches the bearer. It exposes two
   entry points — one for the server path, one for the browser path — and
   nothing else in the Admin app calls `fetch` on an `/api/admin/...` path.

   The two exported kit files that hardcode relative paths are rewritten onto
   the seam at scaffold time, in Gate A:
   `ui-kit/shell/nav-counts-query.ts` and
   `ui-kit/shell/AdminEnrollmentWidget.tsx:47-50`.

   Rejected: leave the kit files alone and set a Next.js `basePath` or a
   rewrite. A relative path with no `Authorization` header is not a base-path
   problem; it is an auth problem wearing one.

4. **The Admin app holds three required variables and two named optional settings,
   all public, and NO secret at runtime.**

   | Variable | Staging | Production |
   |---|---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | staging project URL | production project URL |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | staging publishable key | production publishable key |
   | `NEXT_PUBLIC_ADMIN_API_URL` | `https://staging.repworth.net` | `https://repworth.net` |
   | `NEXT_PUBLIC_DOCS_BASE_URL` (optional) | operator-configured documentation base URL | operator-configured documentation base URL |
   | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (optional) | browser key restricted to approved staging Admin origins and the required Maps/Places APIs | separately authorized production configuration; not enabled by this amendment |

   **Owner exception — 2026-09-11 (#1224).** The optional docs URL moves with
   `/admin/runbook` as required by ADR 0027 D3. Preserve the existing behavior:
   an HTTP(S) base URL makes document references clickable; an unset or invalid
   value renders the filename as code. Register this fourth name in the Admin
   app's environment inventory and audit allowlist. This is a named exception,
   not permission to add other variables or runtime secrets.

   **Owner exception — 2026-09-11 (#1227).** Demos may use the public Maps
   browser key and `@googlemaps/js-api-loader` for its existing place picker.
   This named browser-provider exception is limited to that UI; it adds no
   server provider call, runtime secret, or alternate Admin API transport.
   Preserve the existing Essentials fields `id`, `formattedAddress`, and
   `location`; never request `displayName`. An unset, invalid, or rejected key
   retains the existing load-error message and Google Maps URL input fallback.
   Register the optional name, its sole Demos loader reader, and the exact
   public-key exception in the Admin app's inventory/audit. Restrict a staging
   key to the exact approved Admin staging/preview referrers and the required
   Maps JavaScript/Places APIs; do not use an unrestricted key or broaden a
   production key. Production environment changes still require owner go-live
   authorization. D3 continues to own every `/api/admin/**` read and write.

   **The publishable key, never the legacy anon key.** It rotates
   independently of the JWT signing secret, and
   `ui-kit/lib/supabase-browser.ts:19` already reads that name. This repo keeps
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`; the two repos are allowed to differ here
   and this ADR is the record of why.

   **The rule, not just the list: any proposed Admin app variable that must be
   secret is a design error**, and it is raised on map #1159 rather than added
   to the app. ADR 0024 D1 says the Admin app holds no `SUPABASE_SERVICE_KEY`
   and no database URL; this decision makes that checkable — the Admin app's
   whole environment can be printed in a PR.

   Rejected: a server-only `ADMIN_API_URL` plus a `NEXT_PUBLIC_` companion for
   the client path. It honours invariant #13's shape, at the cost of two names
   for one value whose drift is silent. Invariant #13 governs feature flags in
   THIS repo; an API base URL is neither a flag nor a secret.

5. **The Admin app hosts its own MFA challenge, and `mfaChallengePath` becomes
   a local path.**

   The exported comment proposing the main app's origin cannot work. AAL is
   session-bound (#1160): a challenge completed on `staging.repworth.net`
   raises THAT session to `aal2` and leaves the Admin app's own Supabase
   session at `aal1` forever. The **Verified admin** gate reads the Admin app's
   token, so the app would be permanently refused.

   `/mfa/challenge` in this repo keeps working for impersonation, on the same
   `auth.users` row (ADR 0027 D3). The Admin app's challenge is new code, not a
   port: `MfaChallengeForm.tsx` is 387 lines and carries recovery-code step-up
   this app does not need.

6. **The Admin app reads its own `users.role`, for chrome only. It is never a
   boundary.**

   `users_self_select` permits exactly this read with the publishable key. The
   Admin app uses it to decide what is DRAWN — the sidebar, the identity
   footer, the `AdminShellIdentity` shape the kit already exports — and never
   what is PERMITTED. Every **Admin API** request re-checks role and `aal2`
   server-side; that gate is the only authority.

   The benefit is Gate A's: role-gated chrome is provable end to end with no
   **Admin API**, no CORS and no bearer.

   Rejected: no database read at all, render for any session and surface the
   API's 403. One authority and no second role concept, at the cost of showing
   a full admin shell to a non-admin who signs in, and of leaving Gate A with
   nothing to prove beyond "a session exists".

7. **Mobile-channel and MFA enrollment are the DEVELOPER's first pages, not the
   starter's.**

   `/admin/security` moves per ADR 0027 D3. It is pure Supabase MFA
   enrollment, needs no **Admin API** call, and is therefore buildable and
   acceptance-provable while Gate B is still blocked.

   The developer writes `useMfaEnrollment` themselves against Supabase's own
   MFA API. #1167 did not export it, deliberately: it is imported by the page,
   not by the kit. The same holds for the mobile-channel enrollment engine —
   `ui-kit/lib/enrollment-contract.ts` is a stated contract with a `throw`, and
   implementing it is the developer's work.

8. **"The first page works" is nine checks: five positive, four negative.**

   | # | Check | Gate |
   |---|---|---|
   | 1 | An admin signs in to the Admin app with Supabase Auth | A |
   | 2 | The Admin app's OWN MFA challenge raises that session to `aal2` | A |
   | 3 | A page still renders after the access token expires (proves the refresh middleware, D2) | A |
   | 4 | A non-admin account sees no admin chrome (proves D6's read) | A |
   | 5 | The repo and its Vercel environment hold no `service_role` key and no database URL | A |
   | 6 | `/overview` renders real staging data through a bearer | B |
   | 7 | `POST /api/admin/suppressions/lookup` succeeds through a bearer | B |
   | 8 | An `aal1` session is refused `403 mfa_required` | B |
   | 9 | A non-allowlisted `Origin` is refused `403 {error:'origin'}` | B |

   **Check 7 names that route deliberately.** It is `requireAdminWithAal2` plus
   `withSameOrigin()` today — `withSameOriginUnlessBearer()` once #1185 lands,
   which Gate B is blocked on —
   (`src/app/api/admin/suppressions/lookup/route.ts:20-21`) and it is a READ
   that is a `POST` by design. It exercises the AAL2 gate and the CSRF wrapper
   with zero staging state change. Send an address that matches nothing.

   **Checks 4, 5, 8 and 9 are the point.** A happy-path-only checklist ships an
   app whose origin allowlist never refuses and whose sessions die silently an
   hour in. Check 9 is why the refusal is a `403` with a body rather than a
   bare CORS failure (ADR 0026 D3).

## Consequences

- The developer is unblocked roughly one gate-build earlier than a single
  hand-over would allow, and their first two pages need no **Admin API**.
- ADR 0026's CORS build stays load-bearing: client mutations are cross-origin.
  It is NOT on the read path, so a CORS regression degrades mutations rather
  than blanking every page.
- The Admin app's environment is auditable by inspection. There is no secret to
  rotate, revoke or leak from it.
- Two exported kit files must change before the shell renders. Whoever runs
  Gate A does that, not the developer.
- Gate B cannot start until #1184, #1185 and #1186 are deployed to staging.
  That edge is on #1197, not a note in this ADR.

## Alternatives rejected

- **Prove the handshake against a mock Admin API in Gate A.** It removes the
  blocking edge and proves nothing about the gate, the allowlist or the AAL
  refusal — the three things that can actually be wrong.
- **Give the Admin app a service-role key so it can read `users` broadly.**
  Forbidden by ADR 0024 D1, and D6's self-read needs no such key.
- **Track Gate A in the `admin-app` tracker.** Each ticket next to its own
  code, at the cost of the map losing sight of half the starter and the
  developer inheriting a tracker with one ticket and no context.
