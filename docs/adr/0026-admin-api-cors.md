# ADR 0026 — CORS for the Admin API: one owner in `src/proxy.ts`

## Status

Accepted — 2026-09-07. Resolves wayfinder decision ticket #1162 on map #1159
(the admin split). Refines ADR 0024 D7, which promised a per-environment CORS
allowlist without saying where it lives.

**It also amends ADR 0025 D7.** That decision's safety argument rested on "no
CORS exists on this app". This ADR removes that premise and names its
replacement (D7 below). Read the two together; ADR 0025 D7's sentence is no
longer true on its own terms.

Terms: `docs/context/core-accounts-channels-admin.md` → **Admin origin
allowlist** (coined here), **Admin app**, **Admin API**, **Legacy admin
portal**, **Admin transport**, **Verified admin**.

## Context

The **Admin app** is a separate deployment on its own domain. Every call it
makes to the **Admin API** is cross-origin. Nothing in this repo admits a
cross-origin caller today, so the Admin app cannot reach a single admin route
until this lands. ADR 0025's whole dual-mode gate is inert without it.

Facts measured at 2026-09-07, on `main` at `134a4b81`:

- **No CORS exists.** No `Access-Control-*` header is written anywhere, and no
  `OPTIONS` handler exists under `src/app/api/admin/**`.
- **A preflight hits the auth branch and 401s.** `/api/admin/**` is a protected
  route (`src/lib/shared/protected-routes.ts:85`), so `src/proxy.ts` branch 4
  (`:138-151`) runs for it. A CORS preflight carries no cookie, so branch 4
  returns `401 Unauthorized` with no `Access-Control-Allow-Origin`. The browser
  reports a CORS failure, not a 401 — the status is never readable.
- **`next.config.mjs` `headers()` (`:24-63`) is static.** A `source` pattern
  cannot vary its value by request `Origin`, and it does not attach to
  `src/proxy.ts`'s own 401/403 responses, which are proxy responses rather than
  route responses.
- **The global `Cross-Origin-Resource-Policy` is `same-origin`**
  (`next.config.mjs:54-55`).
- **No cookie can travel cross-origin.** `rw_impersonation` is
  `sameSite: 'strict'` (`src/app/api/admin/impersonation/start/route.ts:104`);
  every other app cookie is `lax` (`src/lib/approval/cookies.ts:52,107`,
  `src/lib/zernio/connect-session-cookie.ts:48,99`,
  `src/app/api/analytics/enqueue/route.ts:73`). A `lax` cookie is not sent on a
  cross-origin `fetch`.
- **Admin routes export 23 `POST`, 13 `GET`, 1 `PUT`, 1 `PATCH`. No `DELETE`.**
  No admin route sets a custom response header, so nothing needs
  `Access-Control-Expose-Headers`.
- **Every admin mutation route already wraps in `withSameOrigin`**, and
  `assertSameOrigin` (`src/lib/shared/csrf.ts:8-38`) throws when
  `NEXT_PUBLIC_APP_URL` is unset and refuses when the `Origin` mismatches.
- **No BotID rule covers `/api/admin/**`** (`src/lib/security/botid-routes.ts:47-50`).
- **No live WAF rule matches `OPTIONS`.** The four live rules match
  `POST /api/auth/signup`, `POST /api/onboarding/start`,
  `POST/PUT/DELETE /api/*` and `GET /api/*`
  (`docs/runbooks/vercel-waf-rate-limiting.md:441-444`).
- **`src/proxy.ts` sits outside the `ci:process-env` scan surface**
  (`src/lib/**`, `src/app/**`, `src/components/**`), and `readFlag` from
  `src/lib/config/flags.ts` is the edge-safe accessor the proxy already imports
  (`src/proxy.ts:10`).

Spec facts, looked up rather than recalled:

- **CORP does not apply to a CORS-mode fetch.** Fetch Standard §3.7: the header
  "can be used to require checking a request's current URL's origin against a
  request's origin **when request's mode is `no-cors`**." §4.4 (HTTP fetch)
  runs the check only "If **either request's response tainting or response's
  type is `opaque`**". A CORS-mode `fetch` is tainted `cors`.
- **COOP does not apply to a fetch response.** It governs whether a new
  top-level document opened by `Window.open()` or by navigation shares a
  browsing context group (MDN). It has no effect on `fetch`/XHR.
- **Our CSP `connect-src` (`src/lib/security/csp.mjs:54`) governs what OUR
  pages fetch.** It has no effect on the Admin app calling us. The reverse is a
  handoff fact: the Admin app's own CSP must list this app's origin in its
  `connect-src`.
- **`Origin` is sent on same-origin non-GET requests.** MDN: user agents add it
  to "same-origin requests except for `GET` or `HEAD` requests (i.e., they are
  added to same-origin `POST`, `OPTIONS`, `PUT`, `PATCH`, and `DELETE`
  requests)". The **Legacy admin portal**'s own mutations therefore carry an
  `Origin` header naming this app.

## Decisions

1. **`src/proxy.ts` is the single owner of CORS for `/api/admin/**`.** It owns
   the dynamic `Access-Control-Allow-Origin`, the `OPTIONS` short-circuit,
   `Vary: Origin`, and the refusal. Nothing else writes an `Access-Control-*`
   header.

   The admin-CORS block runs **first inside `proxy()`, before
   `isProtectedRoute`**. A preflight must never reach branch 4, which would
   401 it from a cookie the browser is not permitted to send.

   Rejected: `next.config.mjs` `headers()`. It is static, so it forces either a
   wildcard origin or one hardcoded origin per deployment; it answers no
   preflight; and it cannot attach to the proxy's own refusals.

   Rejected: a per-route `withAdminCors()` wrapper. It mirrors `withSameOrigin`
   and keeps the check visible at the export, but it cannot answer a preflight
   at all — the proxy 401s the `OPTIONS` before the route module loads — and it
   needs two remembered lines on roughly 20 route files.

   Rejected: proxy for the preflight, `headers()` for the response headers. Two
   owners for one contract is the thing the ticket exists to prevent.

2. **The allowlist is `ADMIN_APP_ORIGINS`: a comma list of EXACT origins, one
   value per Vercel environment, read server-side.** Production names the Admin
   app's domain only; staging names its staging domain. This is the **Admin
   origin allowlist**.

   **No entry is a pattern.** An entry containing `*` is a configuration error
   and the parser throws on it at read. That refusal is what keeps D7 below
   true.

   **Loopback is a separate code rule, not a list entry.** `http://localhost`
   and `http://127.0.0.1` on ANY port are admitted, and the rule is inert in
   the production lane. A port cannot be enumerated in advance, which is why
   ADR 0024 D7 wrote `http://localhost:*` rather than a fixed port.

   **The Admin app's Vercel preview domains are NOT admitted.** ADR 0024 D7
   already describes the developer's loop as the Admin app run locally against
   the staging Admin API, and that is what the loopback rule serves. Admitting
   preview URLs needs a pattern, and a pattern is the one thing D2 forbids.

   Invariant #13 applies: server-only, never a `NEXT_PUBLIC_*` companion. The
   var ships with rows in `docs/eservices-variables.md` and
   `.claude/reference/env-vars.md` in the same change that introduces it.

   Rejected: a hardcoded per-lane constant. It is auditable in git and cannot
   be changed from a dashboard, but the staging value is the one that churns
   most, and every dev-port change would become a PR and a deploy.

3. **The preflight response is a fixed contract. A refused origin gets `403`.**

   | | Allowlisted origin | Any other origin |
   |---|---|---|
   | Status | `204` | `403` with `{ "error": "origin" }` |
   | `Access-Control-Allow-Origin` | the echoed exact origin | absent |
   | `Access-Control-Allow-Methods` | `GET, POST, PUT, PATCH, OPTIONS` | absent |
   | `Access-Control-Allow-Headers` | `Authorization, Content-Type` | absent |
   | `Access-Control-Max-Age` | `600` | absent |
   | `Vary: Origin` | present | present |

   **`Vary: Origin` goes on every `/api/admin/**` response**, refused ones
   included. Without it a shared cache may serve one origin's
   `Access-Control-Allow-Origin` to another.

   **`Access-Control-Allow-Methods` omits `DELETE`** because no admin route
   exports it. Adding a `DELETE` route later is a deliberate edit here, which
   is the point.

   **`Access-Control-Allow-Headers` is a fixed constant, never echoed from
   `Access-Control-Request-Headers`.** Echoing makes the answer always yes and
   leaves no readable statement of what the Admin app may send.

   **`403` rather than a bare `204` on refusal.** The browser-visible outcome is
   identical — blocked either way — but a rejected origin is then greppable in
   Vercel logs by status alone.

   No `Access-Control-Allow-Credentials`, and no
   `Access-Control-Expose-Headers`. See D5 and the Context measurement.

4. **The origin check applies to EVERY method, and this app's own origin is
   implicitly allowed.** An `/api/admin/**` request whose `Origin` header is
   present and is neither on the **Admin origin allowlist** nor equal to this
   app's own origin is refused `403 { "error": "origin" }` before any Supabase
   work. A request with no `Origin` header is untouched.

   The implicit self-allowance is not optional. The **Legacy admin portal**'s
   own `POST`/`PUT`/`PATCH` requests carry an `Origin` header naming this app
   (MDN, Context above). Without it, this decision kills every legacy admin
   mutation.

   **It adds no new dependency.** Every admin mutation route already wraps in
   `withSameOrigin`, and `assertSameOrigin` already throws when
   `NEXT_PUBLIC_APP_URL` is unset and already refuses on a mismatched `Origin`.
   The proxy check duplicates a dependency that sits one layer down. A
   same-origin `GET` sends no `Origin` at all, so the check never fires there.

   **One predicate owns the origin comparison**, shared by `src/proxy.ts` and
   `src/lib/shared/csrf.ts`. Two copies of "is this our own origin" can
   disagree, and a disagreement is either a dead portal or a bypass — the same
   rule **Admin transport** already states for the bearer predicate.

   Rejected: applying the `403` to the preflight only. It is the smaller change
   and cannot touch the legacy portal, but it leaves a browser-enforced control
   with no server-side counterpart.

   Rejected: listing this app's own origin in `ADMIN_APP_ORIGINS`. Nothing would
   be implicit, but one missing entry in one environment silently kills the
   legacy portal there, and the variable's name would stop describing its
   contents.

5. **No credentials, ever.** `Access-Control-Allow-Credentials` is never sent.
   Without it a browser blocks a credentialed cross-origin response even when
   the caller sets `credentials: 'include'`. `SameSite` is the second control:
   `rw_impersonation` is `strict` and every other cookie is `lax`, so no cookie
   reaches a cross-origin `fetch` in the first place. Bearer-only, as ADR 0025
   **Admin transport** requires.

6. **The global `Cross-Origin-Resource-Policy: same-origin` is untouched.** No
   `/api/admin/**` override. Per Fetch §3.7 and §4.4 the check runs only on
   `opaque` tainting, so the header cannot block the Admin app's CORS-mode
   fetch. Setting `cross-origin` on these paths would announce that any site may
   embed admin API responses as a subresource — a weaker claim than the truth,
   on the paths that deserve the strongest one. COOP and our CSP are likewise
   inert for a fetched API response.

7. **The Admin origin allowlist replaces "no CORS exists" as the control ADR
   0025 D7 names.** ADR 0025 D7 concluded that the bearer-wins precedence rule
   is not a CSRF hole because "a cross-site page cannot add that header without
   a CORS preflight, and no CORS exists on this app". After this ADR, CORS
   exists. The replacement premise is narrower and is the operative one from
   here:

   > Only an origin on the **Admin origin allowlist** receives a preflight that
   > permits the `Authorization` header.

   Enforcement is what D2 and D3 already buy: the parser throws on `*`, so a
   wildcard `Access-Control-Allow-Origin` cannot be configured; and a
   non-allowlisted origin receives no `Access-Control-Allow-Origin` on either
   the preflight or the request. D4 adds the server-side half for browser
   callers, so the refusal does not depend on the browser honouring the
   response headers.

   The limit is stated, not hidden: **CORS is a browser control.** A non-browser
   caller holding a stolen bearer is unaffected by any of this, and omitting the
   `Origin` header defeats D4's check too. Closing that is the gate's job
   (**Verified admin**: authentic, live, `aal2` on every request), not CORS's.

   Ticket #1185's scope is unchanged. Either landing order is safe: CORS before
   #1185 means a preflight succeeds but branch 4 still 401s the real request;
   #1185 before CORS means bearers pass the proxy but no cross-origin caller can
   reach them.

   Rejected: a `ci:static-policy` clause failing any literal `*` written as an
   `Access-Control-Allow-Origin` value. It guards a second CORS owner appearing
   somewhere the D2 parser cannot see — but D1 says there is no second owner,
   and an audit for a rule D1 already forbids is an abstraction with no caller.

   Rejected: widening #1185's `withSameOriginUnlessBearer` to check the
   allowlist. D4 delivers the same server-side enforcement for browser callers
   at the proxy, without reopening a ticket that is already cut and blocked.

8. **`Access-Control-Max-Age: 600`, and no WAF rule in this ticket.** 600 s is
   the highest value Safari honours (Chrome caps at 7200 s), so a browser sends
   one preflight per path per ten minutes rather than one per request.

   No preflight rate-limit rule lands here. Under D1 the preflight short-circuits
   before any auth, so it makes no Supabase call and no database read — it is
   the cheapest path in the app.

   **The uncovered `OPTIONS` method is a real gap and it is app-wide**, not
   specific to `/api/admin/**`. It becomes its own ticket plus a row in
   `docs/runbooks/vercel-waf-rate-limiting.md`, so a whole-surface WAF change
   does not ride in on an admin CORS ticket.

## Consequences

- **The Admin app becomes callable.** This is the last edge-level blocker; the
  remaining ones are the gate tickets #1182–#1185.
- **ADR 0025 D7 must be read with D7 above.** Its sentence is stale on its own.
  A reader who finds only ADR 0025 will believe a premise that no longer holds.
- **The **Admin origin allowlist** is now a security boundary in a dashboard.**
  Its production value is one domain, set once; its staging value changes when
  the second developer's environment does. A wrong value is a hard outage of
  the Admin app, not a silent weakening — which is the safe failure direction.
- **`src/proxy.ts` grows a ninth responsibility.** It already carries eight
  branches. The CORS block is first and self-contained, and it is the only
  branch that returns before `isProtectedRoute`.
- **The origin comparison gains a second caller.** `src/lib/shared/csrf.ts` and
  `src/proxy.ts` share one predicate; neither re-spells it.
- **A `DELETE` admin route will fail cross-origin until D3's method list is
  edited.** Deliberate. The failure is loud and at the preflight.
- **The Admin app's own CSP must list this app's origin in `connect-src`.** That
  work is in the other repo and belongs in its handoff doc.
- **`OPTIONS` remains unmatched by every WAF rule** until the follow-up ticket
  lands. Recorded, accepted, and owned by that ticket.

## Alternatives rejected

Recorded per decision above. In summary: `next.config.mjs` `headers()` and a
per-route wrapper as the CORS owner (D1); a hardcoded per-lane constant, and a
Vercel-preview pattern, for the allowlist (D2); echoing
`Access-Control-Request-Headers`, and a silent `204` refusal (D3); a
preflight-only origin check, and listing this app's own origin in
`ADMIN_APP_ORIGINS` (D4); an explicit `Cross-Origin-Resource-Policy:
cross-origin` on `/api/admin/**` (D6); a `ci:static-policy` wildcard audit, and
widening `withSameOriginUnlessBearer` (D7); an `OPTIONS` WAF rule inside this
ticket, and extending `api-mutating-volumetric-log` to cover `OPTIONS` (D8).
