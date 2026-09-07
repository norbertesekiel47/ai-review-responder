# ADR 0024 — The admin UI moves to its own repo; the Admin API stays here

## Status

Accepted — 2026-09-07. Locked by the owner at wayfinder charting time, before
any ticket existed. Records the decisions that fix the shape of the split; the
open design questions live on the wayfinder map's tickets, not here.

Terms: `docs/context/core-accounts-channels-admin.md` → **Admin app**,
**Admin API**, **Legacy admin portal**. Existing terms this ADR leans on:
**Channel actor** (the admin/owner actor seam), **Business summary**,
**At-risk list**.

## Context

RepWorth's admin portal (`src/app/admin/**`, 91 files; `src/app/api/admin/**`,
65 files; `src/lib/admin/**`, 50 files) is to be built and maintained by a
second developer who must NOT have read access to the core codebase. GitHub
repo permissions are all-or-nothing, so the boundary has to be a repository
boundary, not a directory boundary.

Facts measured at charting time (2026-09-07) that constrain the design:

- Every one of the 21 admin pages is a server component that calls
  `src/lib/admin/*` or `sql` directly (`src/lib/auth/page-gate.ts:41`). 17 of
  them have a matching `GET /api/admin/…` route; 5 have none (business-detail
  batch summary, suppressions list, security, runbook, businesses/new coupon).
- Every admin guard is cookie-only. `src/lib/db/auth.ts:27-37` builds a
  `@supabase/ssr` client from `request.cookies`; no route or gate reads an
  `Authorization` header. `src/proxy.ts:137-150` returns 401/403 on
  `/api/admin*` from the cookie before any route runs. JSON mutations also pass
  `withSameOrigin` (`src/lib/auth/route-helpers.ts:25`), which a cross-origin
  caller cannot satisfy.
- `ci:admin-aal2` (`scripts/ci/admin-aal2-audit.ts`) credits exactly three gate
  shapes — `requireAdminWithAal2`, `requireAdminJson`, `resolveAdminActor` —
  and only when imported from the canonical module.
- No CORS exists anywhere; `next.config.mjs:24-63` sets
  `Cross-Origin-Resource-Policy: same-origin` on every response.
- The impersonation cookie `rw_impersonation` is host-only, `SameSite=Strict`,
  set by `POST /api/admin/impersonation/start`
  (`src/app/api/admin/impersonation/start/route.ts:101-107`) and read by the
  owner app (`src/app/(authenticated)/settings/auto-approval/page.tsx:16`,
  `src/app/api/settings/auto-approval/route.ts:117`). A cross-site response
  cannot set it.
- Only two non-admin files import anything from `src/lib/admin`, and both
  import only `IMPERSONATION_COOKIE_NAME`. The dependency points one way:
  admin → core.

## Decisions

1. **The admin UI becomes the Admin app: a separate repo under the RepWorth
   GitHub org, deployed as its own Vercel project on the founder's team.** The
   second developer gets write access to that repo and nothing else. The
   founder keeps every secret; the Admin app holds the Supabase URL and anon
   key only — never `SUPABASE_SERVICE_KEY`, never a database URL.

2. **The Admin API stays in this repo, as the existing Next.js routes under
   `src/app/api/admin/**` on the main Vercel app.** Invariant #1 allows it:
   these routes do short DB work and outbox enqueues, nothing long-running.
   `src/lib/admin/**` stays too — it holds the subscription guard, the audit
   log and the outbox writes that must not be copied into a repo the founder
   does not control. Rejected: a Fastify admin plugin on the Railway worker
   (every route rewritten; the worker becomes internet-facing for admin
   traffic).

3. **Admins sign in to the Admin app with Supabase Auth directly, against the
   same Supabase project, and the Admin app sends the Supabase access token as
   a bearer.** The Admin app runs login and the MFA challenge itself. Admin
   identity remains `users.role = 'admin'` in this repo's database; the Admin
   API re-checks role and AAL2 on every request. Rejected: a token hand-off
   from the main app's login (more code here, and a second session model).

4. **Dual-mode auth on the same paths, then cookie mode is removed.** The
   canonical admin gates accept EITHER the session cookie (same-origin, the
   Legacy admin portal) OR a bearer (cross-origin, the Admin app). The
   same-origin CSRF check applies to cookie mode only — a bearer carries no
   ambient credential. When the last legacy page is deleted, cookie mode on
   `/api/admin/**` is removed. Rejected: a second bearer-only prefix
   (`/api/admin-v1/`), which duplicates every route for the migration window.

5. **Impersonation stays in this repo, entirely.** Start, view, end, the
   `rw_impersonation` cookie and the pages under `/admin/impersonate/**`
   remain on the main app. The Admin app LINKS OUT to the main app's
   impersonation page; an admin keeps a cookie session on the main app for
   that. `/admin/login`, `/admin/forgot-password`, `/admin/reset-password`,
   `/mfa/challenge` and `src/app/admin/layout.tsx` therefore survive the
   split.

6. **The Legacy admin portal is frozen at charting time and retired page by
   page.** No new admin feature lands under `src/app/admin/**`. A page is
   deleted from this repo when the Admin app reaches parity for it, together
   with every CI test that pins that page's path (`console-admin-palette`,
   `admin-aal2-audit` fixtures, `docs/directory/app-admin.md`). Rejected: a
   big-bang cutover (two copies diverge for longer) and keeping both
   indefinitely (two admin UIs to maintain).

7. **The second developer works against the STAGING Admin API only, never a
   local full stack.** They receive a staging admin account enrolled in MFA,
   and later a production admin account. The staging CORS allowlist admits
   `http://localhost:*`; production admits the Admin app's domain only.

8. **The Console visual system is exported once — tokens, the admin
   component kit under `src/components/admin/ui/`, and a curated set of docs
   (the Console style reference, the admin runbooks) — as the Admin app's
   starting point.** No shared package, no publish pipeline. The two drift,
   and that is acceptable because the legacy portal is frozen.

## Consequences

- `ci:admin-aal2`'s allowlist of gate shapes must keep crediting the dual-mode
  gate. The bearer path is added INSIDE the canonical gates, never as a fourth
  shape the audit does not know.
- `src/proxy.ts` must let a bearer through `/api/admin*` (or defer the gate to
  the route) — today it 401s from the cookie alone.
- CORS, preflight `OPTIONS`, `Vary: Origin` and the interaction with the global
  `Cross-Origin-Resource-Policy` header are new surface, owned by one place.
- Five admin reads have no route today and need one, or the page is dropped.
- Every `redirect('/admin/overview')` for an admin landing on an owner route
  (`src/app/(authenticated)/layout.tsx:92`, the four onboarding pages) and the
  worker alert text naming `/admin/flagged` must learn the Admin app's origin.
- The Admin API's request/response shapes become a contract consumed from
  another repo. How that contract is delivered and how a breaking change is
  caught is an open ticket.

## Alternatives rejected

- **A full admin microservice with its own database access.** Hands the
  service key to a repo the founder does not control and copies the
  subscription guard, audit log and outbox rules there.
- **A git submodule for the admin folders.** The admin code imports core
  modules; the developer cannot run or test it without the core.
- **An NDA plus `CODEOWNERS`.** Cheapest, but does not meet the "no read
  access" requirement.
