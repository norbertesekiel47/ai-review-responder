# Round 1 — Authentication & Authorization

**Audit date:** 2026-04-26
**Scope:** Supabase Auth flows (signup/login/OAuth/OTP/password reset), edge middleware, role enforcement, per-route authorization, IDOR / tenant isolation across all 49 API routes.
**Methodology:** Whitebox source review. Three parallel sub-agent passes followed by direct verification of every Critical/High finding against the actual source code.

**Severity rubric:**
- **Critical** — Account takeover, RCE, full tenant data exposure, payment bypass, unauthenticated cross-tenant write
- **High** — Authenticated cross-tenant read/write IDOR, single-endpoint auth bypass, persistent privilege escalation
- **Medium** — Defense-in-depth gap that becomes exploitable under realistic conditions, info disclosure with prerequisites
- **Low** — Hardening opportunity with limited current impact
- **Informational** — Architectural notes, future-state concerns

---

## Findings (by severity)

### [HIGH] H-1: `sales_partner` role has unscoped access to every business

- **Location:**
  - `src/app/api/admin/businesses/route.ts:25-84` (GET — lists all businesses)
  - `src/app/api/admin/businesses/[id]/route.ts:17-42, 48-113` (GET + PATCH — any business)
  - `src/app/api/admin/businesses/[id]/channels/route.ts:15-62` (GET — any business's channel handles)
  - `src/app/api/admin/businesses/[id]/mark-posted/route.ts:5-62` (POST — mark any response posted)
  - Likely also: `src/app/api/admin/businesses/[id]/keywords/route.ts`, `src/app/api/admin/businesses/[id]/ranking/route.ts` (not read directly — same pattern, worth verifying)
- **Description:** Every business-detail route checks `requireRole(request, 'admin', 'sales_partner')` but does NOT scope queries by `onboarded_by = currentUser.id` for sales_partner callers. Both roles see the same unfiltered SQL. The schema has an `onboarded_by` column (per migration 025 in `CLAUDE.md`) precisely to enable this scoping, but no route uses it.
- **Impact:** When a second `sales_partner` is hired/added, they immediately get full read + write access to every business onboarded by every other partner: list all customers, read business details, modify settings via PATCH, mark any response as posted, view masked SMS/Telegram/WhatsApp handles. The `admin` vs `sales_partner` role distinction collapses into a single super-admin role. Today this is latent (Norbert is the sole partner per project context) but the bug is structural and would be exploited the day a second partner logs in.
- **Proof of concept:**
  ```bash
  # Sales partner Bob (onboarded_by=Bob's user_id) lists EVERY business in the system:
  curl -H "Cookie: sb-...=bobs_session" http://localhost:3000/api/admin/businesses
  # Bob reads partner Alice's customer detail:
  curl -H "Cookie: sb-...=bobs_session" http://localhost:3000/api/admin/businesses/{alice_business_id}
  # Bob marks one of Alice's pending responses as posted, breaking her workflow:
  curl -X POST -H "Cookie: sb-...=bobs_session" \
    -H 'Content-Type: application/json' \
    -d '{"responseId":"<alice_response_id>"}' \
    http://localhost:3000/api/admin/businesses/{alice_business_id}/mark-posted
  ```
- **Recommended fix:** Introduce a `getScopedBusinessFilter(role, userId)` helper in `src/lib/db/auth.ts` that returns either an empty fragment (admin) or `AND b.onboarded_by = ${userId}` (sales_partner). Apply it to every list/detail/PATCH query in `src/app/api/admin/businesses/*` and any future per-business admin endpoint. For `mark-posted` specifically, add a precondition SELECT that verifies the calling sales_partner can reach the business via `onboarded_by`. Alternatively, gate every per-business write to `requireRole('admin')` and let only the read endpoints be scoped — depends on how you want partners to operate.

---

### [MEDIUM] M-1: Cancelled business owners retain dashboard read access

- **Location:** `src/middleware.ts:108-117` (owner API gate), `src/middleware.ts:120-128` (owner page gate)
- **Description:** The middleware permits any authenticated `owner` with a `business_id` to access `/api/dashboard/*`, `/api/settings`, `/dashboard/*`, and `/settings`. It does not check `subscription_status`. `subscription-guard.ts` correctly blocks cancelled businesses inside workers (CLAUDE.md confirms the policy), but the read-side dashboard remains open. The schema's `cancelled` and `past_due` states are documented but enforced only at write/queue points.
- **Impact:** A customer whose subscription was cancelled can keep logging in indefinitely and reading their reviews, response history, and metrics. They cannot trigger new generations or notifications, but the product is still partially "free" to use. Also undermines retention/billing UX (no in-app prompt to renew). Not exploitable by an attacker, but a real defense-in-depth and revenue gap.
- **Proof of concept:** (1) Sign up as owner. (2) Subscribe via Stripe → `subscription_status='active'`. (3) Admin/Stripe sets `subscription_status='cancelled'`. (4) Owner reloads `/dashboard` — middleware passes. (5) `GET /api/dashboard` returns full data.
- **Recommended fix:** Add `subscription_status` to `readSelf()` (`src/middleware.ts:70-78`) and reject `cancelled` (and optionally `past_due` after grace) at the owner-page/owner-API gate by redirecting to a `/billing` or `/subscription-required` page. Re-use `checkSubscription()` semantics from `src/lib/shared/subscription-guard.ts` so the policy is centrally defined. Note this interacts with **R6 finding M-N** (the `past_due` grace based on mutable `updated_at` — already known).

---

### [MEDIUM] M-2: `signup-status` is an authenticated enumeration oracle

- **Location:** `src/app/api/auth/signup-status/route.ts:56-71`
- **Description:** The route is authenticated but discloses a binary signal: `200` if the caller's `auth_id` has a corresponding `users` row; `404 account_incomplete` if not. An attacker who obtains another user's Supabase session token (via stolen cookie, malicious browser extension, network capture on an HTTP-mixed page, etc.) can confirm whether that account is fully provisioned vs. mid-signup.
- **Impact:** Marginal — by the time the attacker has a valid session cookie, they already have a near-takeover; the additional signal is "is this a finished account or a half-signed-up one." Useful for targeting follow-on attacks (e.g., racing the user to finish signup against a stolen pre-OTP session). Not catastrophic but easy to fix.
- **Proof of concept:** With a stolen session cookie: `GET /api/auth/signup-status` → `200 {…subscription…}` means "real account, you can keep going"; `404 account_incomplete` means "racing window still open."
- **Recommended fix:** Always return `200 { state: 'complete' | 'incomplete', … }` instead of distinguishing via HTTP status. The body is already only readable to the authenticated caller, so the information leak is bounded by session theft anyway — but uniform status codes deny the oracle.

---

### [MEDIUM] M-3: No per-partner rate limit on `/api/admin/demos/generate`

- **Location:** `src/app/api/admin/demos/generate/route.ts:42-64`
- **Description:** Demo generation calls SerpAPI plus multiple LLM calls — high $ per call. The route enforces a daily *global* cap (50/day) and a per-IP per-minute burst limit (5/min), but no per-`currentUser.id` cap. A single sales_partner can therefore burn the entire daily SerpAPI/LLM budget alone, denying the rest of the team.
- **Impact:** Cost denial-of-service by a single misbehaving or compromised partner account. Currently latent (one operator), real risk once the team grows. Severity bumped above "Low" because cost-impact is concrete and bypassable without exploit-grade skill.
- **Proof of concept:** Loop 50 demo-generate POSTs with a single partner cookie, all from the same IP — once-per-12s spaced — and the global cap empties without tripping the per-IP limit.
- **Recommended fix:** Add a per-`currentUser.id` daily limit (e.g., 10/day) using the same `rate-limit.ts` Redis-Lua primitive. Pair it with the global cap rather than replacing it.

---

### [LOW] L-1: Middleware does not normalize pathname case before role checks

- **Location:** `src/middleware.ts:81-128` (the `pathname.startsWith('/admin')`, `'/api/admin'`, `'/dashboard'`, etc. checks)
- **Description:** `pathname` is matched case-sensitively. A request like `/API/admin/overview` skips the role gate entirely because `pathname.startsWith('/api/admin')` is `false` for the upper-cased string. The same applies to `/Admin`, `/Dashboard`, etc.
- **Impact:** Effectively zero today — Next.js App Router file-based routing is case-sensitive on Linux, so `/API/admin/overview` cannot resolve to `src/app/api/admin/overview/route.ts` and 404s before the handler runs. The risk would activate if (a) Vercel ever introduces case-insensitive route matching, (b) a future rewrite or proxy normalizes case before the framework, or (c) a non-route resource (static, image) is later served from a path overlapping a protected one. Defense-in-depth gap, not a current vulnerability.
- **Proof of concept:** Currently 404s. If you later add a Cloudflare/Vercel rewrite that lowercases paths, this opens.
- **Recommended fix:** In middleware, normalize once before all comparisons: `const lowered = pathname.toLowerCase();` and use that for the `startsWith` checks. Cheap insurance.

---

### [LOW] L-2: `(authenticated)` layout guard runs after data fetches start

- **Location:** `src/app/(authenticated)/layout.tsx:31` (per agent report — verify line)
- **Description:** The layout calls `redirect('/admin/login')` for unauthenticated users, but in App Router server components, sibling page data fetching can begin before the layout's redirect is serialized. Middleware already protects these routes, so this is a defense-in-depth note rather than an active bypass.
- **Impact:** None today (middleware blocks first). Becomes meaningful only if middleware coverage regresses for these paths — at which point the layout would no longer be the sole protector.
- **Recommended fix:** Either (a) keep relying on middleware as the authoritative gate and document the layout redirect as cosmetic, or (b) move the `redirect` to the very top of the layout async function before any other awaits. No change strictly required.

---

### [INFORMATIONAL] I-1: Provisional session swap relies on cookie confidentiality

- **Location:** `src/app/api/auth/finish-signup/route.ts:55-74, 105-125`
- **Description:** The finish-signup endpoint binds the new `users` row to the `auth_id` from the session cookie. If the session cookie is ever stolen (XSS, MITM on a mixed-content page, malicious browser extension), the attacker can finish the victim's signup and attach a business to the victim's email. This is the standard threat model for cookie-based session auth — listed here for completeness, not as a bug.
- **Recommended fix:** None required for current threat model. If high-assurance is desired later, add an optional step-up (re-prompt for password or Google re-auth) before `finish-signup` succeeds.

---

## Verified safe (claims investigated, no finding)

The following potential issues were investigated and ruled out. Listing them so you can see what was checked.

| # | Question | Status | Reason |
|---|---|---|---|
| 1 | Account enumeration via `/api/auth/signup` | **Safe** | Both known + unknown emails return uniform `accountExistsResponse()` semantics; lab note's `account_exists` vs `over_email_send_rate_limit` disambiguation holds. |
| 2 | Account enumeration via `/api/auth/forgot-password` | **Safe** | Generic success regardless of email existence; rate limited. |
| 3 | OTP brute force on `/api/auth/verify-otp` | **Safe** | Strict rate limits 8/email/10min and 30/IP/10min; Redis-down fails closed (503). |
| 4 | OTP replay after successful verify | **Safe** | Supabase `verifyOtp()` invalidates server-side per documented behavior. |
| 5 | OAuth callback CSRF (state, code_verifier) | **Safe** | Supabase SDK's `exchangeCodeForSession` handles PKCE + state internally. |
| 6 | OAuth callback open redirect via `next=` | **Safe** | `nextIsSafe` filter (line 58-59) plus strict prefix-whitelist by role (`startsWith('/admin')` for admin destinations, `startsWith('/dashboard'\|'/settings'\|'/onboarding')` for owner; everything else falls back to role-default home). Path-traversal payloads (`/..%5C/example.com`) fail the role-prefix check and route to `/dashboard` or `/admin/overview`, not the attacker URL. |
| 7 | Password reset token reuse | **Safe** | Supabase recovery tokens are single-use, server-side validated, 15-min expiry. |
| 8 | Owner ↔ admin flow confusion (signup mints admin role) | **Safe** | `auth-flow.ts` discriminator + per-route `requireRole` combination prevents role-cross at every entry. Forgot-password silently no-ops on role mismatch (line 111-119 per agent). |
| 9 | CSRF on auth endpoints | **Safe** | All mutating auth routes call `assertSameOrigin()` (`csrf.ts:8-34`) — Origin-header check against `NEXT_PUBLIC_APP_URL`. |
| 10 | `SUPABASE_SERVICE_KEY` exposure in Edge middleware | **Safe** | Middleware uses cookie-bound anon client only (line 42-61) and explicitly comments at line 7-9 that the service key was removed. RLS policy `users_self_select` (migration 006) covers the role-lookup query. |
| 11 | Middleware matcher excludes a protected path | **Safe** | Matcher `/((?!_next/static\|_next/image\|favicon.ico).*)` covers everything except Next.js internals. All protected paths are matched. |
| 12 | IDOR on `/api/dashboard/reviews/[reviewId]/{approve,edit,regenerate}` | **Safe** | The SQL fetch uses `WHERE rv.business_id = ${user.businessId}` against the session-derived `businessId`, returning 404 on cross-tenant access. (Agent #3 confirmed via direct read; relying on that finding.) |
| 13 | `business_id` accepted from request body on owner routes | **Safe** | Owner routes derive `business_id` from `user.businessId` (session), not request input. |
| 14 | Mass-assignment on PATCH endpoints | **Safe** | `UpdateBusinessSchema` Zod-whitelists fields; `FIELD_TO_COLUMN` plus a `COLUMN_RE = /^[a-z][a-z0-9_]*$/` check (`src/app/api/admin/businesses/[id]/route.ts:85-94`) catches any future drift before SQL is built. Excellent defense-in-depth. |
| 15 | `/api/admin/payment-success` (Stripe redirect target) | **Safe-ish** | Read-only lookup of own session by `client_reference_id`; admin-role-gated; not a Stripe webhook handler (those live on the worker). Minor scope leak documented under H-1 if a partner can guess another partner's session_id, which they generally can't. |
| 16 | `/api/feedback` HMAC verification | **Safe** | HMAC-SHA256 over `${businessId}\|${rating}\|${weekStartDate}` with constant-time compare; cannot be bypassed by the unauthenticated caller. |
| 17 | `/api/signup/place-prefill` | **Safe** | Place ID format validated; rate-limited per IP with strict-fail. |
| 18 | Rate-limit IP source trust on Vercel | **Safe** | Leftmost `x-forwarded-for` extraction; Vercel sets this reliably; `'unknown'` fallback prevents shared-bucket attacks. |
| 19 | SMS disable is callable by sales_partner | **Safe** | `requireRole(request, 'admin')` only on `src/app/api/admin/channels/sms/disable/route.ts:37`. Sales-partner returns 403. (Worth re-verifying the other channel /disable, /cancel, /confirm routes use the same admin-only gate — likely true given the `_shared` helper pattern, but I didn't open every file.) |

---

## Recommended Round-1 fix priority

Order by exploitability × current impact:

1. **H-1** — Add `onboarded_by` scoping to all per-business admin reads/writes. Single-shot fix via a shared helper. **Do this before hiring a second sales_partner.**
2. **M-1** — Enforce `subscription_status='active'` at the owner middleware gate. Prevents customers from continuing to use the product after cancellation.
3. **M-3** — Add per-partner daily quota on demo generation. Cheap to add, blocks future cost-DoS.
4. **M-2** — Unify `signup-status` to always return 200 with state in the body. One-line change.
5. **L-1** — Lowercase pathname before middleware comparisons. Defense-in-depth, near-zero cost.
6. **L-2** / **I-1** — No action required.

---

## Coverage notes / what's NOT in this round

- Ranking + keywords admin endpoints (`/api/admin/businesses/[id]/{keywords,ranking}/route.ts`) were inferred to share H-1 — worth opening to confirm the same pattern.
- `/api/admin/{costs,jobs,notifications,overview}/route.ts` similarly likely list global data; if any of these should be partner-scoped, they're unscoped today (Round 7 follow-up).
- Dependency CVE check (Round 5).
- Supabase RLS policy review per-table (only `users_self_select` was examined; other policies behind `supabase/migrations/*.sql` not deeply reviewed in this round — worth a separate pass after the app-layer audit).
- Live exploitation of any of the above (out of scope per audit type chosen).
