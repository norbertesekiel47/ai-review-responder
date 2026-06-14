# RepWorth — Production-Readiness Deep Scan (Code-Level)

> **Generated:** 2026-05-28 · **Author:** Claude (senior-eng audit) · **Branch:** `main` (head migration 052) · **Scope:** code-level gaps for SaaS production readiness
>
> **Why this doc exists.** RepWorth already has an excellent _strategic_ readiness
> assessment in [`docs/sass_ready/`](./sass_ready/) (29 dimensions, completion %)
> and a [launch checklist](./launch-checklist.md). Those track **feature/vendor
> completeness** ("is X built? is the lawyer review done?"). This doc is the
> complementary **code-level audit**: concrete bugs, missing error/timeout/scope
> handling, and invariant-verification that a feature-completion audit misses.
>
> **Deliberately NOT re-listed here** (already tracked in `sass_ready`/launch
> checklist): PITR restore drill, lawyer/insurance, DKIM/SPF/DMARC, prod env vars
> (POSTHOG_API_KEY, IMPERSONATION_COOKIE_SECRET, OPENAI_MODERATION_ENABLED), Help
> Scout setup, load tests / k6, chaos drills, a11y CI gates, SOC 2, pentest,
> Bull Board, status page, removing CSP `'unsafe-inline'`, public API. Those are
> real and important — but they are _known_. This doc finds what's _not_ known.
>
> **Method.** Six parallel code-scan agents (security/multitenancy, reliability,
> data/DB, billing, code-quality, frontend/observability) + direct verification
> of every high-severity claim. Severities are calibrated against the documented
> design intent — several agent "Critical" flags were downgraded after I read the
> actual contract (noted inline). Each finding lists **file:line · evidence ·
> recommendation** so it's directly actionable.

---

## How to read severity

| Sev | Meaning |
|---|---|
| 🔴 **Critical** | Can cause data loss, security breach, money error, or a core-flow outage **in production**. Fix before onboarding paying customers. |
| 🟠 **High** | Will bite at modest scale or in a plausible failure mode; degrades reliability/observability/security materially. |
| 🟡 **Medium** | Real gap; fix in the first sprint or two post-launch. Hardening, not emergency. |
| 🟢 **Low** | Polish, hygiene, or "document the decision." |

---

## Executive summary

**Overall posture: strong.** Across six code dimensions, the architectural
invariants that matter most all **hold under inspection** — transactional outbox
(only one `queue.add()` in the entire repo), no-auto-post, approval-token hashing,
webhook signature verification, integer-cents money math, fail-closed cost guard,
and the three non-collapsed multi-location booleans. There is **no active
cross-tenant leak, IDOR, SSRF, secret leak, or unverified webhook in app code.**
The findings below are real but bounded — most are hardening, two are genuine
must-fix-before-paying-customers items.

### 🔴 Critical — fix before onboarding paying customers (2)
1. **§1.1 — Production CSP blocks Google Maps PlaceAutocomplete.** Self-serve
   signup + add-location wizard + admin location creation **break in production**
   and the failure is **invisible in dev/tests** (CSP is empty unless
   `NODE_ENV=production`). Highest leverage: a few CSP lines + a prod-build smoke
   test.
2. **§6.1 — Tier-change forgets to snapshot `locations_overage_price_cents`.**
   After any multi-loc→multi-loc tier change, customers see the **wrong overage
   price** and the reconcile poller fires a **false `price_mismatch` alert every
   hour.** One line in the existing tx; also closes the base-price grandfathering
   TODO.

### 🟠 High — bite at modest scale or in plausible failure modes (7)
3. **§5.1 / §5.2 — LLM generation has no timeout + stacked SDK×BullMQ retries**
   (up to 6 billed attempts; a stall pins a worker ~20 min). One-line fix at the
   client constructors: `{ timeout: 30_000, maxRetries: 0 }`.
4. **§3.1 / §3.2 / §3.3 — Three poller-hot-path index/retention gaps** on the
   fastest-growing tables: `inbound_events` archival seq-scan, `analytics_events`
   has no cleanup at all, `job_outbox` watchdog has no index for
   `dispatched`/`dispatching` (seq-scan every ~10–30 s).
5. **§4.1 — Three tenant/PII tables (`inbound_events`, `prospect_demos`,
   `google_connections`) have RLS disabled AND are invisible to the RLS audit.**
   `google_connections` is a **dead table still holding encrypted OAuth tokens** —
   drop it.
6. **§1.2 — `ci:rls-audit` is never run in CI** (and even when wired, can't see the
   §4.1 tables).
7. **§2.1 — Schedulers/pollers log via `console.*`** instead of the structured
   `createWorkerLogger` (~201 calls) — unqueryable, no correlation IDs.
8. **§6.2 — Out-of-order Stripe webhooks** (`subscription.updated/.deleted` before
   `checkout.session.completed`) are silently dropped (200 + `processed`); only the
   hourly reconcile catches the desync.

### 🟡 Medium — first sprint or two post-launch (13)
§1.3 missing `Referrer-Policy`/`Permissions-Policy` · §1.4 335-entry tenant-scope
allowlist erosion · §2.2 caught route errors bypass Sentry · §2.3 no
`loading.tsx`/`not-found.tsx`, sparse error boundaries · §2.4 SEO (1/57 pages have
metadata, no robots/sitemap) · §2.5 no readiness (deep) health check · §2.6 confirm
client Sentry scrubber · §3.4 all-locations dashboard N+1 · §3.5 unconfigured
Postgres.js pool · §3.6 audit tables no retention · §3.7 ZernioRecentReviewPoller
unbounded in-memory fan-out · §5.3 BullMQ no jitter + Redis job records never
evicted · §5.4 shutdown no watchdog/re-entrancy guard · §5.5 lead-intake Google
Sheets fetch no timeout · §6.3 grant-extension ~14-day grace mislabeled "7" · §6.4
`withCostGuard` latent fail-open · §7.1 ~35 bare `subscription_status` literals ·
§7.2 `held-draft.ts` no isolated unit tests · §7.3 billing-math test `readFileSync` ·
§8.1 no GDPR account-deletion/export path · §8.2 multi-location channel-scoping
residual debt (verify PRs #132/#133/#135 merged).

### 🟢 Low — polish / document the decision (9)
§1.5 CI no `timeout-minutes` / no vuln gate · §2.7 no `unhandledRejection` net ·
§3.8 no migration runner · §3.9 reviews/responses retention undocumented · §4.2
`/api/feedback` no rate limit · §4.3 `server.ts` no `server-only` guard · §5.6
Twilio client timeout parity · §5.7 two pollers unbounded SELECT · §7.4 1,150-line
marketing component · §7.5 minor hygiene (1 `any`, eslint-disable reasons, TODO
refs, route error-shape) · §8.3 confirm rate-limit `strict` on all auth routes.

### Tally
| Severity | Count |
|---|--:|
| 🔴 Critical | 2 |
| 🟠 High | 8 |
| 🟡 Medium | 15 |
| 🟢 Low | 10 |
| ✅ Verified-safe checks documented | 40+ |

_Dimensions scanned: security/multitenancy, reliability/resilience, data/DB &
performance, billing/Stripe & LLM cost, code quality/tests, frontend/observability/
ops, CI/build/headers, compliance/data-lifecycle. Every 🔴/🟠 claim was verified
against source._

> **The two-PR quick win:** §1.1 (CSP + prod-build smoke test) and §6.1 (one-line
> tier-change snapshot) remove both Critical items in well under a day. §5.1/§5.2
> (LLM timeout + `maxRetries: 0`) is the next one-line, high-leverage fix.

---

## 1 · CI/CD, Build & Security Headers
_(scanned directly — not delegated)_

### 🔴 1.1 — Production CSP breaks Google Maps PlaceAutocomplete (signup-blocking, dev-invisible)
- **Location:** `next.config.mjs:25-28` (CSP) vs `src/components/PlaceAutocomplete.tsx:4,20-24`
- **Evidence:** `PlaceAutocomplete` uses `@googlemaps/js-api-loader`'s
  `importLibrary('places')`, which **dynamically injects a `<script
  src="https://maps.googleapis.com/maps/api/js?...">`** and the Maps web
  component then makes `connect-src` calls to `maps.googleapis.com` and loads
  assets from `maps.gstatic.com`. The production CSP is
  `script-src 'self' 'unsafe-inline'; … connect-src 'self' https://*.supabase.co
  https://*.sentry.io https://o*.ingest.sentry.io` — **no Google domain in
  `script-src` or `connect-src`**. The CSP is **only applied when
  `NODE_ENV==='production'`** (empty string in dev), so this is **invisible in
  local dev and tests** and only manifests in prod.
- **Blast radius:** every PlaceAutocomplete surface — self-serve signup
  (`onboarding/start`, `onboarding/business`), the add-location wizard
  (`dashboard/add-location`), and admin business creation/demos. The Places
  script fails to load → the component drops to its error state → **owners can't
  pick their location → onboarding cannot complete in production.**
- **Recommendation:** add to the production CSP:
  `script-src … https://maps.googleapis.com`,
  `connect-src … https://maps.googleapis.com`,
  `img-src … https://maps.gstatic.com https://*.googleusercontent.com`,
  and (the new web component renders in shadow DOM with inline styles, already
  covered by `style-src 'unsafe-inline'`). **Then smoke-test PlaceAutocomplete
  against a production build (`pnpm build && pnpm start` with
  `NODE_ENV=production`)** — this class of bug only appears there. Stripe is
  *not* affected (it uses hosted Checkout via full-navigation redirect, verified).

### 🟠 1.2 — `ci:rls-audit` is never run in CI
- **Location:** `.github/workflows/ci.yml:49-54` (lint job runs `ci:tenant-scope`
  + `ci:analytics-events` only); `package.json` defines `ci:rls-audit`.
- **Evidence:** `grep -rn "rls-audit" .github/` → **not found in any workflow.**
  The RLS audit script exists and CLAUDE.md/`repworth.md` instruct running it for
  DB changes, but it is **not in the PR gate**. RLS is the security boundary for
  the few deny-all tables (`flagged_responses`, `onboarding_demos`,
  `analytics_events`, `impersonation_sessions`) — a migration that drops/weakens
  RLS on these would merge undetected.
- **Recommendation:** add `pnpm ci:rls-audit` as a step in the `lint` job (or a
  dedicated job) so RLS regressions fail the build like tenant-scope does.

### 🟡 1.3 — Missing `Referrer-Policy` and `Permissions-Policy` response headers

> **Status: ✅ Resolved** in PR #297 (2026-06-12) — both headers added in `next.config.mjs` `headers()`; verified against a production build with PlaceAutocomplete intact.
- **Location:** `next.config.mjs:7-33` (`headers()`)
- **Evidence:** Sets HSTS, `X-Content-Type-Options`, `X-Frame-Options`, CSP — but
  **no `Referrer-Policy`** (review/business URLs can leak in the `Referer` header
  to third parties, e.g. the Google Maps requests above) and **no
  `Permissions-Policy`** (camera/microphone/geolocation/usb are not disabled).
- **Recommendation:** add `Referrer-Policy: strict-origin-when-cross-origin` and a
  restrictive `Permissions-Policy: camera=(), microphone=(), geolocation=(),
  browsing-topics=()`. Cheap, standard hardening.

### 🟡 1.4 — Tenant-scope audit allowlist has grown to 335 entries / 2,052 lines

> **Status: ✅ Resolved** in PR #298 (2026-06-12) — every entry categorized (8-value `TenantScopeAllowlistCategory`), per-category path invariants enforced by the audit, exact-match `ALLOWLIST_BASELINE = 340` gate (any add/remove requires an explicit bump), count printed in audit output. No SQL snippet reworded.
- **Location:** `scripts/ci/tenant-scope-allowlist.ts` (196 KB, 335 entries)
- **Evidence:** Each entry is a query **exempted** from the cross-tenant scoping
  audit. 335 exemptions is large enough that (a) a genuinely-unsafe query can hide
  among legitimate id-as-tenant-root lookups, and (b) the audit risks becoming a
  rubber stamp. CLAUDE.md already documents two erosion modes (backtick-wrapped
  SQL in comments bypass the audit; moving allowlisted queries to new files
  orphans entries). The allowlist matches by exact SQL snippet, so any reword
  silently drops coverage.
- **Recommendation:** (1) categorize entries by reason (tenant-root-id lookup vs
  admin-after-requireRole vs pre-auth token resolution) and assert per-category
  invariants instead of one flat list; (2) add a periodic review checkbox to the
  launch/runbook cadence; (3) consider failing the audit if the allowlist *grows*
  without a linked reason. Track absolute count as a health metric.

### 🟢 1.5 — CI jobs have no `timeout-minutes`; no dependency-vuln gate

> **Status: ✅ Resolved** in PR #297 (2026-06-12) — `timeout-minutes` on every job in every workflow; non-blocking `pnpm audit --prod` step in the lint job.
- **Location:** `.github/workflows/ci.yml` (all 4 jobs)
- **Evidence:** No job sets `timeout-minutes` → a hung step runs to GitHub's
  6-hour default, burning runner minutes and blocking the queue. Separately, there
  is no `pnpm audit` fail-the-build step (Dependabot covers deps asynchronously,
  but a vulnerable transitive dep can merge between Dependabot runs). `pnpm audit`
  currently reports **0 vulnerabilities** — good baseline to lock in.
- **Recommendation:** add `timeout-minutes: 15` (lint/typecheck/test) / `20`
  (build) to each job; optionally add a non-blocking `pnpm audit --prod` step.

### Verified safe (CI/build/repo hygiene)
- `stripe.exe` (25 MB) and `.env.local` are **gitignored, not tracked**; only
  `.env.example` is committed. No secrets in tracked files. `.git` is 21 MB,
  1,388 tracked files — healthy.
- Third-party GitHub Actions are **SHA-pinned**; `permissions: contents: read`
  (least privilege); pnpm store cached; Node from `.nvmrc`, `corepack prepare
  pnpm@11.0.9` pinned. `engines.node: ^24.15.0`, `packageManager: pnpm@11.0.9`.
- `pnpm audit --prod` → **0 known vulnerabilities.**
- Stripe is server-side hosted Checkout (`checkout.sessions.create`,
  `src/lib/payments/create-checkout-session.ts`) — no client `@stripe/stripe-js`,
  so the CSP does not break payments.

---

## 2 · Observability, Logging Discipline & Frontend/UX
_(delegated scan, severities recalibrated against design intent)_

### 🟠 2.1 — Background schedulers/pollers log via `console.*`, not `createWorkerLogger`

> **Status: ✅ Resolved** in PR #299 (2026-06-12) — all remaining `console.*` calls in `worker/background/{pollers,schedulers}` (~113 across 18 files) migrated to `createWorkerLogger`; dynamic values moved into sanitized object args, helpers receive the threaded `WorkerLogger`, catch boilerplate deduplicated via `logUnhandledPollError`/`toError` in `logger.ts`. Zero `console.*` left in the tree.
- **Location:** `worker/background/schedulers/*.ts`, `worker/background/pollers/*.ts`
  (e.g. `MonthlyImpactScheduler.ts:24`, `OnboardingDripScheduler.ts:25`,
  `WeeklySummaryScheduler.ts:92`, `CleanupAbandonedSignupsPoller.ts:43,73,149`,
  `EmailChannelReconcilePoller.ts:81,177`). ~201 `console.*` calls in `worker/`.
- **Evidence:** These run every poll/scheduler cycle in production but emit
  unstructured `console.log/error` with string interpolation — no JSON shape, no
  `AsyncLocalStorage` correlation IDs (`account_id`/`business_id`/`job_id`). They
  are unqueryable in a log drain and not tied to the structured-logging spine the
  rest of the worker uses (`src/lib/shared/logger.ts`).
- **Recommendation:** instantiate `createWorkerLogger(prefix, correlationId)` at
  the top of each cycle and route all logs through it. This is the single largest
  observability-consistency gap. (Calibrated to High, not Critical: it's a
  consistency/queryability gap, not data loss.)

### 🟡 2.2 — Caught errors in route handlers go to `console.error`, bypassing Sentry

> **Status: ✅ Resolved** in PR #300 (2026-06-12) — shared `reportCaughtError(endpoint, err, context)` helper (`src/lib/shared/report-caught-error.ts`: `Sentry.captureException` tagged by endpoint + one structured log line) wired into every caught→logged→swallowed catch across `src/app/api` (~70 sites); log-then-rethrow paths left to `onRequestError`. Context objects carry IDs/failure codes only, never PII.
- **Location:** e.g. `src/app/api/auth/signup/route.ts:42`,
  `src/app/api/auth/verify-otp/route.ts:98`,
  `src/app/api/auth/mfa/challenge/route.ts:69`, `src/app/api/settings/route.ts:109`,
  `src/app/api/settings/voice/route.ts:221`.
- **Evidence calibration:** The frontend agent flagged this as "Critical: Sentry
  not in routes," but **`src/instrumentation.ts` exports
  `onRequestError = Sentry.captureRequestError`** — so Next.js **does** forward
  *uncaught/thrown* route errors to Sentry. The real (narrower) gap: errors that
  are **caught inside a try/catch and `console.error`'d without re-throwing or
  `Sentry.captureException`** are invisible to Sentry (e.g. rate-limit-store
  failures, swallowed DB errors). These are exactly the silent failure modes you
  want alerting on.
- **Recommendation:** in route catch-blocks that handle-and-continue, call
  `Sentry.captureException(err, { tags: { endpoint } })` before `console.error`,
  and log via a structured logger. Do **not** log full error objects that may
  contain PII.

### 🟡 2.3 — No custom `loading.tsx`, `not-found.tsx`; error boundaries on only 3 segments

> **Status: ✅ Resolved** in PR #301 (2026-06-12) — `error.tsx` for `(authenticated)/dashboard`, `(authenticated)/settings` (shared `SegmentErrorState` component) and `admin` (first boundary in that tree); `loading.tsx` for dashboard, past-replies, and admin lists; branded root `not-found.tsx` (island layout, brand tokens).
- **Location:** `src/app/**` — `loading.tsx`: **0**, `not-found.tsx`: **0**,
  `error.tsx`: only `(public)/login`, `(public)/signup`, `onboarding`
  (+ `global-error.tsx`). 57 `page.tsx` total.
- **Evidence:** Authenticated app (`(authenticated)/dashboard`, `/settings`,
  `/admin/*`) has **no segment error boundaries** → any render/data error in those
  trees bubbles to the bare `global-error.tsx` with no context and no recovery
  affordance. No `loading.tsx` → no streaming/suspense fallback UI on slow data.
  No `not-found.tsx` → default 404.
- **Recommendation:** add `error.tsx` to `(authenticated)/layout`, `dashboard`,
  `settings`, `admin/layout`; add `loading.tsx` for data-heavy segments
  (dashboard, past-replies, admin lists); add a branded `not-found.tsx`.

### 🟡 2.4 — SEO: only 1 of 57 pages exports `metadata`; no `robots.ts`/`sitemap.ts`

> **Status: ✅ Resolved** in PR #301 (2026-06-12) — `robots.ts` (disallows `/admin` `/api` `/auth` `/approve` + authed surfaces + tokenized `/demo`) and `sitemap.ts` (canonical public marketing + legal pages). Per-page `metadata` on `(public)` pages had already landed since this baseline — every public page exports it.
- **Location:** `src/app/**` — 1 file exports `metadata`/`generateMetadata`;
  **no `robots.ts`, `sitemap.ts`, or `manifest.ts`.**
- **Evidence:** Public marketing/legal/pricing/feature pages inherit only the root
  layout's metadata → poor titles/descriptions, no per-page OpenGraph (bad social
  unfurls), no canonical URLs, no sitemap for crawl efficiency, and `/admin`,
  `/api`, `/auth` are not disallowed from crawlers.
- **Recommendation:** add `src/app/robots.ts` (disallow `/admin`, `/api`, `/auth`,
  `/approve`) + `src/app/sitemap.ts` (public + legal pages); add per-page
  `metadata` exports with title/description/OpenGraph to all public pages.

### 🟡 2.5 — `/api/health` is liveness-only; no readiness (deep) check exists

> **Status: ✅ Resolved** in PR #302 (2026-06-12) — web `GET /api/health/ready` (Postgres `SELECT 1` + Upstash PING) and worker `GET /ready` (Postgres + both Redis instances) via shared `src/lib/shared/readiness.ts` (2s per-probe timeout, 503 + per-dep status). `/api/health` untouched (liveness by contract). Verified live incl. the 503 path with a dead cache Redis.
- **Location:** `src/app/api/health/route.ts`
- **Evidence calibration:** The agent flagged "health returns 200 without checking
  deps" as Critical, but the route is **intentionally dependency-light by
  contract** (inline comment: "no DB, LLM, Stripe, Zernio, or PostHog calls …
  must stay fast and side-effect free"). That's a valid *liveness* probe. The real
  gap (per `production.md` / Nygard): there is **no *readiness* endpoint** that
  verifies the worker/web can actually serve (DB `SELECT 1`, Redis `PING`). For
  Vercel this matters less (no LB readiness gate); for the **Railway worker** it
  matters more.
- **Recommendation:** keep `/api/health` as the fast liveness probe; add a
  `/api/health/ready` (web) and a worker readiness endpoint that checks Postgres +
  both Redis instances and returns 503 when a critical dep is down. Wire synthetic
  checks to the readiness endpoint.

### 🟡 2.6 — Verify client (browser) Sentry applies the PII scrubber
- **Location:** `src/instrumentation-client.ts` vs `worker/sentry.ts` (scrubber)
- **Evidence:** The worker Sentry init has a `beforeSend` scrubber; the **client**
  init should be confirmed to apply the same scrubbing (`scrubSentryEvent`) so
  browser errors don't ship DOM/query/PII to Sentry. (Note: `NEXT_PUBLIC_SENTRY_DSN`
  being public is **expected** — DSNs are not secrets; the agent's "exposed DSN"
  flag is a non-issue.)
- **Recommendation:** add/confirm a `beforeSend` scrubber in
  `src/instrumentation-client.ts`.

### 🟢 2.7 — Worker has no `process.on('unhandledRejection'|'uncaughtException')` net

> **Status: ✅ Resolved** in PR #299 (2026-06-12) — re-entrancy-guarded `unhandledRejection`/`uncaughtException` handlers in `worker/index.ts`: Sentry capture + one structured log line + `exit(1)` after a short flush. Deliberately does not re-enter graceful `shutdown()` (§5.4 stays open).
- **Location:** `worker/index.ts`
- **Evidence:** BullMQ wraps job-handler rejections, so most are caught; but a
  stray un-awaited promise rejection in a poller/scheduler would be lost. A
  top-level net that captures to Sentry and exits cleanly is cheap insurance.
- **Recommendation:** add `process.on('unhandledRejection'/'uncaughtException')`
  → `Sentry.captureException` + structured log + graceful exit.

### Verified safe (observability/frontend)
- **Feature-flag discipline:** no `NEXT_PUBLIC_*` companion for any feature flag;
  gates are server-authoritative (`SELF_SERVE_SIGNUP_ENABLED`,
  `CHANNELS_*_ENABLED`). ✅ matches invariant 13.
- **Analytics gating:** `CLIENT_ENQUEUEABLE_EVENT_NAMES` allowlist blocks durable
  facts from client POST. (Open item 2.x below: confirm `enqueueAnalyticsEvent`
  runs `sanitizeAnalyticsProperties` on the *properties* before persist — the
  route only validates the event *name*.)
- Root layout has `lang="en"`; sampled `Field` components wire `htmlFor`+label;
  critical client fetches (`ReviewActions`, enrollment widgets) have error/loading
  states.

### ✅ 2.8 — Analytics property sanitization (verified safe)
- `src/lib/analytics/enqueue.ts:29` runs `sanitizeAnalyticsProperties(input.properties ?? {})`
  **before** persisting via `jsonb(properties)`. So client-enqueued events cannot
  smuggle raw review text/PII into the payload — the route validates the event
  *name* (`CLIENT_ENQUEUEABLE_EVENT_NAMES`) and the lib sanitizes the *properties*.
  No action needed.

---

## 3 · Database & Performance
_(delegated scan — agent provided strong verification incl. a thorough "verified safe" list)_

### 🟠 3.1 — `inbound_events` archival DELETE is a guaranteed full-table scan
- **Location:** `worker/background/pollers/ArchivalPoller.ts:37-49` + `001_initial_schema.sql:291`
- **Evidence:** Archival filters `WHERE status='processed' AND processed_at < NOW()
  - INTERVAL '30 days'`, but the only status index is
  `idx_ie_status ON inbound_events(status) WHERE status != 'processed'` — its
  partial predicate **explicitly excludes the exact rows archival scans for.**
  `inbound_events` is the **fastest-growing table** (one row per Stripe/Resend/
  Twilio/Zernio webhook), so the daily cleanup seq-scans an ever-larger table.
- **Recommendation:** `CREATE INDEX idx_ie_archival ON inbound_events
  (processed_at) WHERE status = 'processed';` (or composite `(status,
  processed_at)`). Use `CONCURRENTLY`.

> **Status: ✅ Resolved** in PR #304 (2026-06-12) — migration 065 adds `idx_ie_archival ON inbound_events (processed_at) WHERE status = 'processed'` (`CREATE INDEX CONCURRENTLY`, standalone non-transactional file with header warning). Predicate mirrors the ArchivalPoller DELETE exactly.

### 🟠 3.2 — `analytics_events` has no retention / cleanup (unbounded growth)
- **Location:** `046_analytics_events.sql`; `ArchivalPoller.ts` (absent for this table)
- **Evidence:** `AnalyticsDispatchPoller` marks rows `status='completed'` and
  leaves them forever. The ArchivalPoller cleans `job_outbox`, `inbound_events`,
  `prospect_demos`, `api_costs`, `notification_deliveries` — **not**
  `analytics_events`. True unbounded table with no TTL/partition/DELETE path.
- **Recommendation:** add a batched DELETE of `completed` rows older than ~30d to
  ArchivalPoller, mirroring its existing batch + saturation-warning pattern.

> **Status: ✅ Resolved** in PR #304 (2026-06-12) — ArchivalPoller gained an `analytics_events` block: `completed` >30d and `failed` >90d (by `occurred_at`, so the existing `idx_analytics_events_status (status, occurred_at DESC)` serves both arms — no new index), mirroring the LIMIT-5000 + saturation-warning + FOR UPDATE SKIP LOCKED pattern, with tests. Windows recorded in the migrations-log retention table.

### 🟠 3.3 — `job_outbox` watchdog scans lack an index for `dispatched`/`dispatching`
- **Location:** `worker/background/pollers/OutboxPoller.ts:40-82` + `001_initial_schema.sql:320-321`
- **Evidence:** The watchdog runs **every poll cycle (~10–30s)** with UPDATEs
  filtered on `status='dispatched'` / `status='dispatching'`. `idx_jo_pending` is
  partial `WHERE status='pending'` (excludes these); `idx_jo_topic(topic,status)`
  leads with `topic` so can't serve a bare status scan → **seq-scans on a
  high-churn table** every cycle. (The Phase-2 claim query `status='pending'` IS
  covered.)
- **Recommendation:** `CREATE INDEX idx_jo_recovery ON job_outbox (dispatched_at)
  WHERE status IN ('dispatched','dispatching');` (matches the watchdog's
  `dispatched_at <` predicate).

> **Status: ✅ Resolved** in PR #304 (2026-06-12) — migration 065 adds `idx_jo_recovery ON job_outbox (dispatched_at) WHERE status IN ('dispatched','dispatching')`; all three watchdog predicates imply the index predicate (btree stores the NULL `dispatched_at` rows the stale-dispatching arm scans).

### 🟡 3.4 — All-locations dashboard is N+1 by location (~11·N + 2 queries/load)
- **Location:** `src/lib/dashboard/aggregate-service.ts:87-127` →
  `src/lib/dashboard/service.ts:63-218`
- **Evidence:** `getAggregateDashboardData` calls `getActiveDashboardData(loc.id)`
  per active location; each fires ~11 SQL + 1 Redis. For N locations ≈ `11·N + 2`
  queries/dashboard, throttled to concurrency 5. With the default pool `max:10`
  (see 3.5), a 10-location account can momentarily **saturate the whole pool from
  one dashboard request.** Self-documented as a known launch-scale tradeoff.
- **Recommendation:** before scaling multi-location, fold per-location batch into
  account-scoped `GROUP BY` queries (data is account-filterable via
  `businesses.account_id`).

> **Status: ⏸️ Deferred (deliberate)** as of 2026-06-12 — the §3.1/§3.3 covering indexes (PR #304) and the §3.5 pool bounds (PR #305) remove the acute pool-saturation risk this item was paired with, so the N+1 refactor is not launch-blocking. Deferred to keep the change measured (snapshot query count → fold the 2–3 heaviest of ~11 per-location queries into account-scoped `GROUP BY business_id` → assert identical output shapes against the existing unit tests), which needs green CI + code-review to land safely. **Revisit trigger:** before accounts with >5 active locations become common (the doc's own "before scaling multi-location" framing) — at that point a 10-location dashboard load can still issue ~112 queries against the now-bounded pool.

### 🟡 3.5 — Postgres.js connection pool size/lifetimes not configured
- **Location:** `src/lib/db/server.ts:8-19`
- **Evidence:** `postgres()` sets only `prepare:false` + `statement_timeout:30_000`.
  No `max`, `idle_timeout`, `max_lifetime`, `connect_timeout` → defaults to
  `max:10`/process with no idle reaping. Same client imported by Vercel routes
  **and** every Railway worker/poller (~14 background loops + BullMQ handlers +
  the N+1 dashboard) → no explicit demand limit / idle recycling / connect
  timeout behind PgBouncer.
- **Recommendation:** set explicit `max`, `idle_timeout`, `max_lifetime`,
  `connect_timeout` per process role (Vercel route vs worker), sized to the
  Supabase/PgBouncer ceiling.

> **Status: ✅ Resolved** in PR #305 (2026-06-12) — `src/lib/db/server.ts` now sets `max` (env-tunable `DB_POOL_MAX`, default 10), `idle_timeout: 30`, `max_lifetime: 1800`, `connect_timeout: 10` (Postgres.js seconds). Worker keeps 10; Vercel environments set `DB_POOL_MAX=3` per instance (documented in `env-vars.md`). `prepare:false` + `statement_timeout` untouched.

### 🟡 3.6 — `account_audit_log` / `approval_audit_log` have no retention policy
- **Location:** `034_multi_location_schema.sql:62-79`, `001_initial_schema.sql:458-473`
- **Evidence:** Both grow unboundedly; neither is in the ArchivalPoller set. Slower
  growth than analytics_events and may have a compliance-driven retention need —
  but there's no explicit policy either way.
- **Recommendation:** define an explicit (likely longer, compliance-driven)
  retention window + batched cleanup, **or** document a deliberate "keep forever"
  decision so it's a choice, not an accident.

> **Status: ✅ Resolved** in PR #304 (2026-06-12) — deliberate **keep-forever** documented in the migrations-log "Data retention policy" table (compliance/audit surfaces; `approval_audit_log` backs invariant #3's recorded-approval evidence chain). Revisit triggers: a documented compliance retention ceiling, or either table exceeding ~10M rows.

### 🟡 3.7 — `ZernioRecentReviewPoller` loads all active connections into memory, serial external fan-out
- **Location:** `worker/background/pollers/ZernioRecentReviewPoller.ts:96-105,291-323`
- **Evidence:** `loadAllActiveConnections` paginates the DB read but accumulates
  **every** active connection into one in-memory array; `runOnce` then loops
  serially with up to 4 Zernio calls/connection every 5 min. At 500 locations =
  a single 500-iteration serial loop of up to ~2,000 external calls/cycle, no
  concurrency, no per-cycle time budget, no load-shedding if a cycle overruns
  (the `isPolling` guard just skips the next tick).
- **Recommendation:** cap connections processed per cycle, add bounded concurrency,
  add a per-cycle deadline.

> **Status: ✅ Resolved** in PR #306 (2026-06-12) — per-cycle connection cap (`ZERNIO_RECENT_REVIEW_POLL_MAX_CONNECTIONS`, default 100) with an in-memory `business_id` keyset cursor (full rotation across cycles, wraps at end), bounded fan-out (`ZERNIO_RECENT_REVIEW_POLL_CONCURRENCY`, default 3), and a per-cycle deadline (`ZERNIO_RECENT_REVIEW_POLL_DEADLINE_MS`, default 4 min) that defers — and warn-logs — connections instead of running unbounded; the cursor advances only past dispatched connections so deferred ones lead the next cycle. Tests cover cap, cursor resume/wrap, deadline, and concurrency bound.

### 🟢 3.8 — No migration runner; CONCURRENTLY safety relies on operator reading a comment
- **Location:** `package.json` (no migrate script); `031_edit_existing_replies.sql:1-7`
- **Evidence:** Migrations are applied by hand in the Supabase SQL editor. Mig 031
  mixes DDL with `CREATE INDEX CONCURRENTLY` and *documents* it must run
  non-transactionally — relying on the operator unchecking "single transaction."
  Risk: an operator runs it in a tx and leaves an INVALID index, or applies out of
  order.
- **Recommendation:** adopt a runner that applies each file statement-isolated
  (and can opt files out of the wrapping tx), or split CONCURRENTLY statements into
  clearly-flagged standalone files.

> **Status: ✅ Resolved** in PR #304 (2026-06-12) — `deployment-guide.md` §2a is the standing procedure (numeric order, both-projects-staging-first, uncheck-single-transaction for CONCURRENTLY, INVALID-index repair, log entry in the same PR); convention adopted that CONCURRENTLY statements live in standalone flagged files (065 is the template). A full runner is deliberately deferred — revisit if migration cadence or team size makes manual application error-prone.

### 🟢 3.9 — `reviews`/`responses` unbounded by design — record the decision
- **Evidence:** Core tenant data is intentionally retained (correct), but no
  explicit statement that they're exempt from retention. At high volume, hot KPI/
  dashboard queries will eventually need `deleted`-status pruning or partitioning.
- **Recommendation:** document the deliberate exemption now; revisit partitioning
  at scale.

> **Status: ✅ Resolved** in PR #304 (2026-06-12) — exemption documented in the migrations-log retention table: `reviews`/`responses` are core tenant data, deliberately retained; revisit (pruning of `status='deleted'` tombstones and/or partitioning) before multi-location scale degrades hot KPI/dashboard queries.

### Verified safe (DB/perf) — high confidence, the agent actually checked
- **No `${JSON.stringify(x)}::jsonb`** anywhere in src/worker (only doc comments);
  all 56 JSONB write sites use the `jsonb()` helper (incl.
  `worker/jobs/response-generation/persist.ts:128`).
- **JSONB string-read guards** present (`OutboxPoller:149`,
  `AnalyticsDispatchPoller:123`).
- `statement_timeout:30_000` set correctly.
- Hot read paths indexed: past-replies/admin (`idx_reviews_business_review_date`),
  KPI/margin/cost (`idx_reviews_business_detected_at`, `idx_api_costs_account`,
  `idx_costs_daily`, rollup indexes). Cost report paginates server-side.
- Outbox/analytics claim queries use `FOR UPDATE SKIP LOCKED` + `LIMIT`; archival
  DELETEs batched (LIMIT 5000) with saturation warnings; `ON CONFLICT` targets the
  named constraint.
- Expression indexes use IMMUTABLE `(created_at AT TIME ZONE 'UTC')::date`.
- **No external calls inside DB transactions** (Zernio calls outside `sql.begin`;
  the only `sql.begin` wraps a pure DB write).
- UUIDv7 app-generated consistently; FKs with explicit `ON DELETE`; CHECK
  constraints on status/severity/source/sentiment domains; `api_costs.account_id`
  intentionally nullable (platform costs) with correct `IS NOT NULL` filters.

---

## 4 · Security & Multi-Tenancy
_(delegated scan; the agent's "verified safe" list is extensive — net: **no active cross-tenant leak, IDOR, SSRF, secret leak, or unverified webhook found in app code**)_

### 🟠 4.1 — Three tenant/PII tables have RLS disabled **and** are invisible to the RLS audit
- **Location:** `supabase/migrations/001_initial_schema.sql` (`google_connections` L117, `prospect_demos` L352, `inbound_events` L277); `scripts/ci/tenant-tables.ts`; `scripts/ci/rls-audit.ts:11` (`REQUIRED_RLS_TABLES = TENANT_TABLES`)
- **Evidence:** No `ENABLE ROW LEVEL SECURITY` statement exists anywhere for these three, and none are listed in `TENANT_TABLES` — so even **after** wiring `ci:rls-audit` into CI (§1.2), the audit *structurally cannot* flag them.
  - `inbound_events` — raw webhook payloads (Stripe/Twilio/Resend/Zernio bodies) that can contain phone numbers, emails, PII.
  - `prospect_demos` — business names, place IDs, generated review/response snapshots.
  - `google_connections` — holds `access_token_encrypted`, `refresh_token_encrypted`, `encrypted_dek` (Google OAuth secrets). **It is a dead/orphaned table** — Zernio superseded direct Google OAuth and it has zero current code references — yet it still sits in the DB holding token-shaped secrets with no RLS.
- **App-layer reachability is currently safe** (verified): `inbound_events` only touched by worker ingress + admin-gated `payment-success`; `prospect_demos` only by admin routes + the by-design public slug viewer. So this is a **missing defense-in-depth layer**, not an active leak — but `docs/security/rls-inventory.md` itself states "Tenant tables must keep RLS enabled even when most durable writes are enforced in application code."
- **Recommendation:** (a) **Drop `google_connections`** if confirmed dead (best — removes a secret-bearing orphan), else enable deny-all RLS; (b) enable RLS (deny-all/service-role, mirroring `flagged_responses`) on `prospect_demos` and `inbound_events`; (c) add all retained tenant/payload tables to `TENANT_TABLES`/`REQUIRED_RLS_TABLES` so the audit guards them going forward.

> **Status: ✅ Resolved** in PR #308 (2026-06-13) — took **Route A (keep + RLS)**, NOT the scan's "drop `google_connections`". Migration **066** enables deny-all RLS (enable RLS, no policy) on all three; the server reaches them only via the RLS-bypassing Postgres.js `postgres` role (mirrors `analytics_events`/`flagged_responses`/`impersonation_sessions`). All three added to `TENANT_TABLES` (→ `REQUIRED_RLS_TABLES`) so `ci:rls-audit` now guards them, plus matching `docs/security/rls-inventory.md` rows and **17** `tenant-scope-allowlist.ts` structural exemptions (baseline 340→357; `google_connections` needs none — all access is via identifier-interpolating purge helpers). **`google_connections` was NOT dropped — the scan's "dead table" claim is stale:** owner-offboarding now references it as a `hard_delete` purge target in 4 sites (`table-disposition`/`purge-stages`/`purge-helpers`/`purge-verification`), so a drop would require ripping those out. Verified **no anon/browser table access** (all via the service `sql` client), so deny-all is transparent to the public demo viewer + every ingress/admin/purge path. Migration is **hand-applied** (single transaction), staging-then-prod, both Supabase projects.

### 🟢 4.2 — Public `/api/feedback` has no rate limit
- **Location:** `src/app/api/feedback/route.ts` (no `checkRateLimit`)
- **Evidence:** Every other public route (`approve`, `signup`, `place-prefill`, `analytics/enqueue`) rate-limits; feedback doesn't. Mitigated: every request is HMAC-gated via `verifyFeedback(...)` before any DB write, and the upsert is week-scoped `ON CONFLICT` (idempotent). Residual risk: replaying one valid signed link can hammer the upsert (DB load only).
- **Recommendation:** add a per-IP `checkRateLimit` for parity.

> **Status: ✅ Resolved** in PR #307 (2026-06-13) — added a **fail-open per-IP `checkRateLimit`** (30 req / 60s, key `feedback:ip:<ip>`) to both GET and POST via a shared helper, for parity with the other public routes. Fail-open (not strict) is deliberate: the link is HMAC-gated, so this is signed-link-replay / DB-load hardening, not an auth gate, and an Upstash blip must not block legitimate owner feedback. Tests cover the 429 paths (GET denies before HMAC, POST before any DB work) and the IP key shape.

### 🟢 4.3 — `src/lib/db/server.ts` lacks an `import 'server-only'` guard
- **Location:** `src/lib/db/server.ts:1-20`
- **Evidence:** Instantiates the Postgres.js client (`DATABASE_POOL_URL`) and the Supabase **service** client (`SUPABASE_SERVICE_KEY`). No `'use client'` component imports it today (verified), but without the guard a future accidental client import would silently bundle DB credentials into the browser.
- **Recommendation:** add `import 'server-only';` at the top — a build-time tripwire, zero runtime cost.

> **Status: ✅ Resolved (alternative)** in PR #307 (2026-06-13) — the literal `import 'server-only'` was **rejected with evidence**, NOT "zero runtime cost" here: `src/lib/db/server.ts` is imported by ~130 Railway-worker files, and the worker runs under `tsx` (no `react-server` export condition), where `import 'server-only'` **throws at module load** (verified: `npx tsx -e "import('server-only')"` → "This module cannot be imported from a Client Component module"). It would crash the worker on boot, and `pnpm build` (Next-only) would never catch it. Same intent achieved **worker-safely** via a new `ci:static-policy` rule: a `'use client'` component may not import `@/lib/db/server` (which would bundle `DATABASE_POOL_URL`/`SUPABASE_SERVICE_KEY` into the browser) — a build-time/CI tripwire with zero runtime risk, reusing the invariant #14 machinery. Type-only imports are exempt; no current client importer exists, so the audit passes today. (If a runtime guard is later wanted, the path is to split the secret-bearing Supabase-admin client into a Next-only module — tracked as a follow-up, not done here.)

### Verified safe (security) — spot-checked, expected-but-not-broken
- **Webhook signature verification:** all 5 ingress handlers verify **before** any side effect with timing-safe compare, fail-closed in prod, and persist raw payload + provider event id via `claimInboundEvent` for dedup/replay (Stripe `constructEvent`, Resend/Svix w/ replay window, Zernio HMAC, Twilio `validateRequest`, Telegram secret-token).
- **Approval tokens:** only SHA-256 hashes hit Postgres; raw token hashed in-route and looked up by `token_hash`; never in outbox/logs. ✅ invariant 5.
- **SSRF:** Google Maps URLs are hostname-allowlisted + https-only at schema time; `resolvePlaceId`/`fetchBusinessDetails` parse identifiers structurally and call SerpAPI's fixed `google_maps` engine — they **never HTTP-fetch the user-supplied URL** and don't expand shortlinks.
- **Secrets:** `SUPABASE_SERVICE_KEY` referenced only in `server.ts`; all `NEXT_PUBLIC_*` are legitimately public (anon key, maps key, Sentry DSN, URLs).
- **IDOR / ownership:** owner routes cross-check body `accountId` against server-derived `user.accountId` AND verify `location.account_id`; scope derived server-side from `getUser()`, never from the body; admin `[id]` routes gated by `requireRole('admin')`.
- **AAL2:** `src/proxy.ts` enforces auth + role + AAL2 (when `MFA_ENFORCEMENT_ENABLED`) across admin/owner/onboarding surfaces using a cookie-bound anon client (no service key at the Edge).

---

## 5 · Reliability & Resilience
_(delegated scan — the two invariants that matter most **hold**: outbox correctness is architecturally enforced (the only `queue.add()` in the whole repo is `OutboxPoller.ts:160`), and no-auto-post holds)_

### 🟠 5.1 — LLM generation calls have **no explicit timeout** (inherit the 10-minute SDK default + 2 SDK retries)
- **Location:** `src/lib/responses/generator.ts:276,282` (client construction), `:328,357` (call sites); `worker/queues.ts:56-59`
- **Evidence:** `new OpenAI()` / `new Anthropic()` are constructed with **zero options** → SDK `DEFAULT_TIMEOUT` = 10 min and `maxRetries = 2` (verified in `node_modules`). The moderation call right next door (`src/lib/moderation/moderate.ts:50`) correctly sets `{ timeout: 10_000 }` with a comment that the default is "far too long here" — but the **primary generation path never got the same treatment.** A provider stall can pin a `GENERATE_RESPONSE` worker for up to ~20 min/attempt × 2 providers × 3 BullMQ attempts, starving the generation queue. Violates `repworth.md`: "every outbound call to OpenAI/Anthropic has an explicit timeout."
- **Recommendation:** construct both clients with `{ timeout: 30_000, maxRetries: 0 }` (one-line fix at the constructors). See 5.2 for why `maxRetries: 0`.

> **Status: ✅ Resolved** in PR #309 (2026-06-13) — both clients now constructed via an exported `LLM_CLIENT_OPTIONS = { timeout: 30_000, maxRetries: 0 }` in `generator.ts` (`getOpenAI`/`getAnthropic`). Construction-level (NOT per-call like `moderate.ts`) per the recommendation's "fix at the constructors" — one client-wide policy covering both call sites incl. the Anthropic fallback. Guarded by `client-options.test.ts`.

### 🟠 5.2 — Stacked retries: SDK `maxRetries: 2` × BullMQ `attempts: 3` → up to 6 billed LLM attempts
- **Location:** `src/lib/responses/generator.ts:276,282` + `worker/queues.ts:56-59`
- **Evidence:** SDK keeps its default `maxRetries=2` and `defaultJobOptions.attempts=3`. A transient provider error is retried up to 2× inside the SDK, then the whole job up to 3× by BullMQ → **as many as 6 real (billed) LLM attempts per logical generation, ×2 providers**, with no layer aware of the other. The Stripe/SMS/WhatsApp clients correctly disable SDK retries (`autoRetry: false`); the LLM clients didn't.
- **Recommendation:** set `maxRetries: 0` on the OpenAI/Anthropic clients; let the existing BullMQ + outbox-watchdog ladder own retries (single source of retry truth).

> **Status: ✅ Resolved** in PR #309 (2026-06-13) — `maxRetries: 0` on both clients (via `LLM_CLIENT_OPTIONS`); the BullMQ `attempts:3` + 1h outbox-watchdog ladder is now the single source of retry truth (no more stacked SDK 2× × BullMQ 3× = 6 billed attempts). Retry **classification is unchanged**: `maxRetries:0` only stops the SDK's internal re-tries, not the thrown error *types* `isTransientLLMError` keys on, so `generate-draft.ts`'s transient/terminal mapping (incl. the `CostInfraUnavailableError` retry path) is untouched — verified by the unchanged `generate-draft.test.ts` (10 tests green).

### 🟡 5.3 — BullMQ: no retry jitter; completed/failed jobs never evicted from Redis
- **Location:** `worker/queues.ts:56-59`
- **Evidence:** `backoff: { type: 'exponential', delay: 5_000 }` — pure exponential, **no jitter** → a provider outage hitting many jobs retries in lockstep (5s/10s/20s), a thundering-herd against the recovering dependency. Separately, `defaultJobOptions` sets no `removeOnComplete`/`removeOnFail`/`keepJobs` → BullMQ retains **every** finished job record in Redis forever. On Upstash (per-command + per-storage billing) this is unbounded steady-state growth — the Postgres analog (`ArchivalPoller`) exists, but there's no equivalent for Redis job records.
- **Recommendation:** add jitter (custom backoff strategy) and set `removeOnComplete: { age: 86400, count: 1000 }` + `removeOnFail: { age: 604800 }`.

> **Status: ✅ Resolved** in PR #311 (2026-06-13) — `worker/queues.ts` `defaultJobOptions`: `backoff: { type:'exponential', delay:5_000, jitter:0.5 }` + `removeOnComplete:{ age:86400, count:1000 }` + `removeOnFail:{ age:604800, count:5000 }`. **Two corrections to this finding:** (1) **no custom strategy needed** — BullMQ ≥5 has a **built-in `jitter`** field on the exponential strategy (`BackoffOptions.jitter`, validated in `job.js`) that randomizes the delay into `[maxDelay·(1−jitter), maxDelay]`; jitter only pulls delays *earlier* than the prior pure-exponential ceiling → no SLA regression, and `worker/index.ts` is untouched. (2) Job records live on the fixed-size **Railway** Redis (`REDIS_QUEUE_URL`), **not Upstash** as the evidence stated — the windows bound memory there, and a `count:5000` cap was added to `removeOnFail` (beyond the recommendation's age-only) to bound a sustained-outage failed-job pile.

### 🟡 5.4 — Graceful shutdown has no watchdog and no re-entrancy guard
- **Location:** `worker/index.ts:297-334`
- **Evidence:** `shutdown()` awaits `Promise.all(workers.map(w => w.close()))` with **no overall timeout and no `process.exit` fallback**. If any worker is mid-flight on a hung outbound call (see 5.1), `w.close()` waits indefinitely → the process never exits until Railway SIGKILLs it, **losing the PostHog/Sentry flush** that runs *after* `workers.close()`. Also `SIGTERM`/`SIGINT` handlers have no `isShuttingDown` guard → a second signal re-enters `shutdown()` (double `sql.end()`, double analytics shutdown).
- **Recommendation:** add an `isShuttingDown` boolean guard; arm a `setTimeout(() => process.exit(1), N).unref()` watchdog within the Railway grace window; flush analytics/Sentry *before* the potentially-blocking worker close.

> **Status: ✅ Resolved** in PR #310 (2026-06-13) — shutdown extracted to `worker/shutdown.ts` (`createGracefulShutdown(deps)`, unit-testable with fakes; `worker/index.ts` only wires real deps, invariant #12). `isShuttingDown` re-entrancy guard; `setTimeout(()=>exit(1), WORKER_SHUTDOWN_GRACE_MS).unref()` watchdog (default 25s inside the Railway grace window, env-tunable per env-vars.md); `flushAnalytics()` + `Sentry.flush(2_000)` run **before** the blocking `worker.close()`, with the terminal `shutdownAnalytics()` **after** close — strictly better than "move shutdownAnalytics before close" (jobs draining during a clean close still flush, using the existing non-terminal `flushAnalytics()` export). Mutually safe with the §2.7 fatal-exit net: `shutdown()` bails if `fatalExitInProgress`, while `fatalExit()` keeps its own guard and never bails on a graceful shutdown. 6 unit tests cover flush ordering, re-entrancy no-op, fatalExit bail, watchdog force-exit(1), and best-effort resilience (replacing the old brittle source-scraping test).

### 🟡 5.5 — Google Sheets append on the lead-intake request path has no fetch timeout
- **Location:** `src/lib/google/owner-leads-sheet.ts:87,137` (called from `src/app/api/lead-intake/route.ts:253`)
- **Evidence:** Two raw `fetch()` calls (OAuth token exchange + Sheets append) with **no `AbortSignal`/timeout**, `await`ed synchronously inside the Vercel `POST /api/lead-intake` handler. A hung Google connection blocks the user response up to the platform function timeout. The lead is already persisted and the append is in try/catch, so it's failure-tolerant — but the latency/hang exposure on a user-facing route is real.
- **Recommendation:** wrap both fetches in an `AbortController` (~5s), or move the append to the worker via an outbox row (it's non-blocking enrichment anyway — arguably an ADR-0001 nudge).

> **Status: ✅ Resolved** in PR #312 (2026-06-13) — both `fetch()` calls in `owner-leads-sheet.ts` (OAuth token exchange `:87` + Sheets append `:137`) now pass `signal: AbortSignal.timeout(5_000)`. The existing call-site `try/catch → reportCaughtError` swallows the resulting `TimeoutError` (the lead is already persisted before the append), so a hung Google connection can no longer block `POST /api/lead-intake`. Took the timeout for v1; the outbox-move option is noted for later (non-blocking enrichment, ADR-0001).

### 🟢 5.6 — Twilio SMS client omits the explicit timeout the WhatsApp client sets
- **Location:** `src/lib/notifications/channels/sms-channel.ts:40` vs `whatsapp-client.ts:99`
- **Evidence:** `twilio(SID, TOKEN)` with no options (SDK default 30s timeout, `autoRetry:false` — bounded) vs WhatsApp's explicit `{ timeout: 10_000, autoRetry: false }`. Inconsistent with the project's 10s convention.
- **Recommendation:** pass `{ timeout: 10_000, autoRetry: false }` for parity.

> **Status: ⏭️ Stale — no action** (2026-06-13) — the SMS channel was **removed entirely** in PR #260 (`feat: remove SMS notification channel entirely`). `src/lib/notifications/channels/sms-channel.ts` no longer exists (the channels dir is email/telegram/whatsapp only), so there is no Twilio SMS client left to harden. The surviving WhatsApp/Telegram clients already set explicit 10s timeouts. Annotation-only; no code change.

### 🟢 5.7 — Two pollers run unbounded main-query SELECTs (no `LIMIT`)
- **Location:** `worker/background/pollers/NotificationFailoverPoller.ts:138-159`, `CancellationGracePoller.ts:37-49`
- **Evidence:** Driving queries load the full predicate-matched set into memory. Predicates are self-limiting today (only `pending_approval` >4h old w/ no successful delivery; only accounts cancelled >30 days w/ active locations), so pathological growth is unlikely — but unlike the other pollers (Outbox, AnalyticsDispatch, CleanupAbandonedSignups, ZernioRecentReview) they have no batch cap.
- **Recommendation:** add `LIMIT` + per-tick batching so a backlog can't load an unbounded result set into one tick.

> **Status: ✅ Resolved** in PR #312 (2026-06-13) — `NotificationFailoverPoller`'s **both** driving SELECTs (all-failed + stale) gain `ORDER BY resp.created_at ASC LIMIT 200` (`const BATCH_LIMIT`). Oldest-stuck rows are triaged first; all-failed rows leave the predicate set once their failover outbox row is queued, and the stale arm's 24h `tryClaimAlert` dedup makes re-selection a cheap no-op — so a >200 simultaneous-stuck backlog (itself a sev incident) drains oldest-first across 2h ticks instead of loading unbounded into one tick. `CancellationGracePoller` left as-is per the recommendation (its result set is GROUP BY-bounded).

> _(The "health endpoints don't reflect serve-ability" point this scan also raised is consolidated as §2.5 — readiness vs liveness.)_

### Verified safe (reliability)
- **Outbox correctness architecturally enforced** — only one `queue.add()` in the repo; all follow-up work is `INSERT INTO job_outbox` inside the same `sql.begin()`. The silent-data-loss class is **absent**. ✅ invariant 2.
- **No-auto-post holds** — publisher gates on `ZERNIO_PUBLISHABLE_STATES` and the final UPDATE is status-guarded; idempotent on re-delivery. ✅ invariant 3.
- Outbox transitions idempotent + attempt-guarded (`FOR UPDATE SKIP LOCKED`, jobId `${id}_${attempts}`, watchdog recovers stuck rows in a separate tx).
- Concurrency guard atomic + crash-safe (single Lua INCR+check+EXPIRE+rollback, 5-min TTL net); slot/cost reservation released in `finally`.
- Subscription guard centralized (`checkSubscription`) and applied across all customer-facing workers (publisher, notification, generator, summary, owner-email, ranking, drip).
- Zernio/Telegram/WhatsApp/SerpAPI/OpenAI-moderation clients all set explicit 10–15s timeouts with `autoRetry:false`. Sampled `catch {}` blocks are intentional fallbacks (serialization, cache-miss, timing-safe-equal), not swallowed state errors.

---

## 6 · Billing / Stripe Correctness & LLM Cost Ops
_(delegated scan — money math verified integer-cents-clean; the items below are the real correctness gaps)_

### 🔴 6.1 — Tier-change route never updates the **stored** `locations_overage_price_cents` → wrong customer price + hourly false drift alerts
- **Location:** `src/app/api/billing/tier-change/route.ts` (the `UPDATE accounts` block — **verified**: sets `subscription_tier`, `locations_included`, `updated_at` only)
- **Evidence:** The route pushes the **new** tier's overage price to Stripe (`getOveragePriceId(tier)` with `create_prorations`), but the in-tx `UPDATE accounts` **omits `locations_overage_price_cents`.** Per invariant 9a, both `currentBillingSnapshot` (`src/lib/accounts/quota.ts:85`) and the reconcile poller's `expectedInvoiceForAccount` read the **stored** column. After any cross-tier change between two multi-loc tiers (e.g. standard 2500¢ → premium 2000¢), the stored value stays at the **old** tier's price. Signup paths (`create-business.ts`) snapshot it correctly — tier-change is the lone write site that forgot it, so it's a genuine inconsistency, not design.
- **Consequences:** (a) the customer's billing snapshot in `/api/account/settings` shows the **wrong overage price/total**; (b) `StripeLocationsReconcilePoller` fires a **false `price_mismatch` drift alert every hour** (and a false `upcoming_invoice_mismatch`), comparing Stripe's real overage `unit_amount` against the stale stored price.
- **Recommendation:** in the same tx, add `locations_overage_price_cents = ${newConfig.overageCents}` to the UPDATE. Add a tier-change billing-math test asserting the stored column moves. **(This same "snapshot prices on tier writes" fix also closes the documented base-price grandfathering TODO at `quota.ts:90-96` / `margin-service.ts:64`.)**

> **Status: ✅ Resolved** in PR #265 (2026-06-13 verified) — `persistTierChangeTx` (`src/lib/accounts/tier-change.ts:235-243`) is the PRIMARY tier-change writer and already snapshots ALL tier-derived columns in one tx: `locations_overage_price_cents` (:239), `base_price_cents` (:240), `locations_included` (:238). The Stripe webhook re-snapshots defensively via `CASE WHEN tierChanged` but sees `tierChanged=false` (the route commits the new tier first). The paired `quota.ts`/`margin-service.ts` base-price grandfathering TODO was closed by the migration-054 stored snapshot. Verify-only — no code change in the §6 sweep.

### 🟠 6.2 — `customer.subscription.updated` / `.deleted` lost if delivered before `checkout.session.completed`
- **Location:** `worker/ingress/stripe/subscription-updated.ts:57-66`, `subscription-deleted.ts:16-26`, `checkout-completed.ts:95`
- **Evidence:** Both handlers resolve the account by `WHERE stripe_customer_id = ${customerId}`, but `accounts.stripe_customer_id` is written **only** by `checkout-completed`. Stripe out-of-order delivery is documented and real: if `subscription.updated` arrives first, the lookup returns no row, the handler logs "no account found," and the **outer handler marks the event `processed` and returns 200** → Stripe never retries → the tier/`locations_paid` update is **permanently dropped.** Bounded by the hourly reconcile poller (eventual catch) and a pre-activation `.deleted` is benign, but a real desync window exists with no in-band recovery.
- **Recommendation:** on no-match, fall back to resolving via `sub.id` against `stripe_subscription_id`, or return a **non-terminal** result so Stripe retries; alternatively persist `stripe_customer_id` at checkout-session *creation* (it's known then), not only on completion.

> **Status: ✅ Resolved** in PR #313 (2026-06-13) — Option A (non-terminal retry): on no-account-by-`stripe_customer_id`, `subscription-updated.ts`/`subscription-deleted.ts` now THROW `AccountNotProvisionedYetError` instead of returning cleanly, so the ingress wrapper marks the event `failed` + replies **500** and Stripe redelivers once `checkout-completed` has written the customer id. Redelivery is idempotent (status-guarded UPDATE + `claimInboundEvent` failed-row reclaim + `ON CONFLICT DO NOTHING`). The subscription-**mismatch** / offboarding-snapshot branches stay clean returns (real mismatches, not timing). Out-of-order sequence + exactly-once proven by new tests in `stripe-webhook-handlers.test.ts`. A genuinely orphaned customer retries until Stripe's ~3-day schedule gives up; the hourly reconcile poller remains the standing backstop. (Option B — pre-create the Stripe customer at session creation — deliberately NOT taken; Option A + reconcile is sufficient for launch.) Worker-touching → staging-verified before merge.

### 🟡 6.3 — `grant-extension` yields up to ~14 days of effective grace, but is labeled/capped as "7"
- **Location:** `src/app/api/admin/billing/grant-extension/route.ts:121-122` (`MAX_EXTENSION_DAYS = 7`)
- **Evidence:** `expiresAt = max(pastDueAt + 7d, now) + days*DAY_MS` with `days ≤ 7`. For an in-window account this anchors to the **existing** 7-day deadline and adds up to 7 more → an effective window of **up to 14 days**. Intentional per the inline comment (avoids a no-op), but the math means a single max grant doubles paid grace — a finance/ops surprise.
- **Recommendation:** confirm intent (+7 on top of remaining grace **vs** extend-to-N-total). If the latter, anchor differently or cap the absolute deadline. At minimum rename the constant / document the doubling so an admin granting "7" knows it can be 14.

> **Status: ✅ Resolved** in PR #314 (2026-06-13) — chose **(a) keep "+N on top of remaining grace"** (additive). The anchor `max(grace deadline, now) + days` is deliberate (avoids the "now+days collapses inside the window" no-op and revives already-locked-out accounts), so behavior is unchanged; the surprise was purely naming/visibility. Renamed `MAX_EXTENSION_DAYS` → `MAX_ADDITIONAL_EXTENSION_DAYS` with a documenting comment, and added admin-UI copy in `PastDueExtensionPanel` ("added on top of remaining grace … up to ~14 days total from past-due"); the exact resulting deadline was already surfaced in the success response. Billing-math test pins the ceiling: fresh `past_due` + 7 → **+14d** total (integer ms/day math, no float). (Option (b) extend-to-N-total NOT taken — it would no-op the feature for in-window accounts unless the cap were raised, and discards the deliberate anchor.)

### 🟡 6.4 — `withCostGuard` finalize-failure path can fail-OPEN and leak the reservation (latent)
- **Location:** `src/lib/costs/cost-guard.ts:72-84`
- **Evidence:** When `finalizeCost` throws (Redis flake) after a successful LLM call, with `onFinalizeError: 'log-and-return-value'` the value is returned but `finalized=true` is set **before** the branch, so `finally` skips `releaseCost` and the 15¢ pessimistic reservation ages out via the 24h TTL. **No production caller uses that mode** (the generator uses the default `'propagate'`, which re-throws and discards the result → safe), so this is latent — but a sustained Redis-finalize outage would over-count the daily cap (fail-safe direction) while real cost never lands.
- **Recommendation:** keep `'propagate'` as the only production mode; add a test pinning that finalize-failure under `'propagate'` re-throws and does not double-release; consider release-then-finalize semantics so a finalize failure self-heals rather than relying on TTL.

> **Status: ✅ Resolved** in PR #14 (2026-06-13 verified) — `cost-guard.test.ts` already pins both finalize-failure modes: test #6 `finalizeCost throws (default propagate) → releaseCost NOT called, finalize error propagates` (caller value discarded → fail-safe), and #7 `log-and-return-value → returns value, no releaseCost` (reservation ages out via 24h TTL). No production caller uses the leak mode (the generator uses the default `'propagate'`). Test #10 also covers the cleanup-after-finalize-error edge. Verify-only — no code change.

### 🟢 6.5 — Inert-until-configured edge cases (record the assumption)
- **`daysRemaining` floor** (`src/lib/shared/past-due-recovery.ts:122`): the *displayed* days floor (`Math.floor`) is conservative, but the read-only **access** cutoff uses exact `remainingMs <= 0` — access is never cut early. Cosmetic only.
- **Stripe `trialing` false drift** (`billing-reconciliation/drift.ts:33-45`): the app has no `trialing` status; if a Stripe Price ever carries a trial, a false `status_mismatch` would fire hourly. Inert today (no trials configured). Add `trialing` to the tolerated set *before* introducing trials.

> **Status: ✅ Resolved** in PR #314 (2026-06-13) — both sub-items addressed. **`trialing`:** handled CORRECTLY as a top-level `subscription.status === 'trialing'` tolerance in `reconcile-account.ts` (the status-check site), NOT added to `isExpectedStatusWindow`'s `['past_due','unpaid']` array as the recommendation's line pointer implied — that function returns early unless OUR status is `past_due`, so it would never see the real trialing case (Stripe `trialing` vs our `active`); the literal edit would have been an inert no-op. **`daysRemaining` floor** (`src/lib/shared/past-due-recovery.ts:122`): confirmed **cosmetic-only** — the read-only access cutoff uses exact `remainingMs <= 0` (`:124`), so access is never cut early; no change. **Bonus (coupled gap surfaced by §6.3's additive choice):** `isExpectedStatusWindow` is now **extension-aware** — it derives its window from the single grace-clock owner `computePastDueRecoveryState` (collapsing `drift.ts`'s duplicate hardcoded 7-day `PAST_DUE_GRACE_MS`), so a granted `past_due_extension` that pushes effective access past day 7 no longer false-alerts `status_mismatch` hourly. Covered by new drift/poller tests.

### Verified safe (billing) — the math was actually checked
- **Webhook idempotency:** `inbound_events.external_event_key UNIQUE` + `claimInboundEvent` `ON CONFLICT DO NOTHING` + bounded stale-reclaim; handler returns 500 on processing failure so Stripe retries; duplicate delivery is a 200 no-op.
- **Per-handler concurrency:** every status handler takes `FOR UPDATE` + `pg_advisory_xact_lock` and is status-guarded/idempotent.
- **`invoice.paid`/`subscription.deleted`** correctly null `past_due_at` on recovery.
- **Money math is integer-cents throughout** — `computeOverageQuantity = max(0, count - included)` (boundary `count==included → 0`, no off-by-one); `totalCents = baseCents + units*priceCents`; the only float→cents is `Math.ceil(usd*100)` with a `Number.isSafeInteger && >= 0` guard; reconcile uses ±1¢ tolerance. No `parseFloat`/`toFixed`/`/100` on money.
- **Cost guard fail-CLOSED:** `reserveCost` before the LLM call; biz + global daily caps enforced atomically via Lua (DECRBY rollback on exceed) → throws `CostLimitExceededError`. Onboarding-demo guard reserves-before-spend, releases on failure, alerts at 50/90/100%.
- **Reconcile poller never auto-corrects** (drift → alert only); covers count, tier base + overage price, status, missing/duplicate subscriptions; single-flight guarded.
- **Three multi-loc booleans never collapsed** — all 6 call sites use the correct one (visibility/mode/eligibility). ✅ invariant 9b.

---

## 7 · Code Quality, Maintainability & Test Coverage
_(delegated scan — modularization effort has clearly paid off: **no file exceeds ~1,150 lines and only one is over 800**; severities recalibrated — the agent's "Critical" string-literal flag is a real rule violation but not a production bug)_

### 🟡 7.1 — `subscription_status` used as a bare string literal in ~35 places (rule violation)
- **Location:** e.g. `src/lib/accounts/tier-change.ts:69`, `worker/jobs/OnboardingDripWorker.ts:61`, `worker/jobs/billing/UpdateStripeOverageWorker.ts:121`, `src/lib/db/account-guard.ts:51,58-60`, SQL predicates in `grant-extension/route.ts:103,141` and several ingress handlers.
- **Evidence:** `repworth.md` ("Never do") explicitly forbids string literals for subscription status — import the enum (`src/lib/shared/subscription-status.ts`). The enum exists but is imported in only ~41 of ~76 files that touch `subscription_status`. (Calibrated **Medium**, not Critical: the guard logic is centralized and verified-correct in §5/§6 — this is consistency/regression-resistance, not a live bug.)
- **Recommendation:** migrate TS comparisons to `SubscriptionStatus.*`; for SQL predicates (harder to lint) reference the enum value or add a comment. Add an ESLint rule (`no-restricted-syntax`) forbidding the bare literals so it can't regress.

> **Status: ✅ Resolved** in PR #315 (2026-06-13) — migrated the **genuine** subscription-status sites to the `SubscriptionStatus` enum: ~20 TS comparisons + ~7 value-assignments across `src/` + `worker/` (Stripe ingress, pollers, schedulers, dashboard, `account-guard`, `loginDestination`, onboarding). The ~23 **SQL predicates** inside postgres.js `sql\`\`` templates keep the literal + a trailing `-- enum: SubscriptionStatus.X` reference comment (the enum can't be imported into a tagged template). **Spelling-only — zero behavior change** (enum value `===` the literal; full suite **6131 passed**). The scoping trap was respected: connection status (`conn.status`/`zc.status`), review status (`'pending_approval'`), job/outbox status, and the synthetic dashboard view-states (`'active_pending_business'`/`'pending_payment_admin_handoff'`) were **NOT** migrated. **Guard** (the regression-resistance the item asked for): instead of the suggested broad `no-restricted-syntax` ESLint rule (which can't tell which domain a bare literal belongs to and would false-positive on connection/review status → get disabled), a scoped **`ci:static-policy`** rule (`subscription-status-literal`) uses **line co-occurrence** — flags a bare status literal only on a non-comment line that also names the `subscription_status` column / `subscriptionStatus` field. Application-scoped (`src/`+`worker/`); SQL + dashboard discriminant carve-outs are an explicit, reviewed allowlist (27 sites) with the count printed so growth is visible. 8 new guard unit tests. Worker/billing-touching → staging-verified before merge.

### 🟡 7.2 — Moderation release-gate `held-draft.ts` has no isolated unit tests
- **Location:** `src/lib/moderation/held-draft.ts` (`hasOpenFlag()`, `HeldForReviewError`)
- **Evidence:** This gate enforces invariant 4 (high-confidence unsafe drafts are held, not posted). It's exercised **indirectly** via integration tests (`publish.test.ts`, approval `http-routes.test.ts`), but has **no dedicated unit test** for the boundary conditions of `hasOpenFlag()` (open row → true; no/closed rows → false; filters on `response_id AND status='open'`). The project rule requires tests for approval-token paths and outbox transitions; this safety gate sits in the same risk class.
- **Recommendation:** add `src/lib/moderation/__tests__/held-draft.test.ts` covering the open/closed/empty cases. (Medium because the behavior *is* covered end-to-end; the gap is isolation + boundary precision.)

> **Status: ✅ Resolved** in PR #277 — `src/lib/moderation/__tests__/held-draft.test.ts` exists with the isolated boundary cases (open row → true; no/closed rows → false; `response_id AND status='open'` filter); 10 `hasOpenFlag`/`HeldForReviewError` assertions. Verify-only — no change in this sweep.

### 🟡 7.3 — Billing-math test reads source via `readFileSync` instead of importing it
- **Location:** `…/add-location/wizard/AddLocationWizard.test.ts:15-19` against `…/wizard/billing.ts`
- **Evidence:** The test reads `billing.ts` from disk at runtime rather than importing the functions — brittle to file moves and bypasses type-checking of the contract under test.
- **Recommendation:** `import { computeProration, computeNextLocationBillingPreview }` directly so the test binds to the real module contract.

> **Status: ✅ Resolved** — the billing-math functions are imported and exercised **directly** (`computeProration`, `computeNextLocationBillingPreview`) in `src/app/(authenticated)/dashboard/add-location/__tests__/AddLocationWizard.test.ts` and `deferred-loc-assertions.test.ts`; no `readFileSync` against `billing.ts` remains in the wizard test dir. (The deep-scan's residual-`readFileSync` note referred to a separate legit source-assertion helper, not the billing-math test.) Verify-only.

### 🟢 7.4 — One `FeaturesContent.tsx` at 1,150 lines (largest file; marketing markup)
- **Location:** `src/components/sections/features/FeaturesContent.tsx`
- **Evidence:** Contains 7 inline `FeatXxx()` section components + 2 shared hooks in one file. It's cohesive presentational markup (low logic risk) and already composes internal components, so it's lower-risk than its line count suggests — but it's the one remaining outlier after the modularization sweep.
- **Recommendation:** extract each `FeatXxx()` to `feature-sections/` and the hooks to `./hooks.ts`, leaving a thin orchestrator. Low priority.

> **Status: ⏸️ Deferred (deliberate)** (2026-06-13) — `FeaturesContent.tsx` is still 1,171 lines, but it's cohesive presentational marketing markup (7 inline `FeatXxx()` sections + 2 hooks) with **zero correctness risk**, and `fallow`'s new-only gate does not flag it as a new finding. The split touches rendered markup (react-doctor / `repworth-brand-design` surface) for no functional gain, so it's deferred behind the higher-value §7.1/§7.5 items per the §7 LOW-defer guidance — tracked for a future markup-only cleanup PR. Like §3.4, this is a conscious deferral, not an oversight.

### 🟢 7.5 — Minor hygiene
- **`any` in `…/add-location/wizard/useAddLocationWizard.ts:48`** — `(loc: any)` mapping a known API shape; type it (one of only 4 `any` in the codebase).
- **`eslint-disable react-hooks/exhaustive-deps` without a `// REASON:`** in `FeaturesContent.tsx:149`, `auth-island/LoginForm.tsx:35`, `useLocationVoiceForm.ts:178` — add a one-line justification or fix the dep.
- **Untracked `TODO`s** in `quota.ts:90-96`, `margin-service.ts:64`, `demo/[slug]/page.tsx` — add ticket refs (the quota/margin ones are closed by the §6.1 fix).
- **Inconsistent route error shape** — mix of `jsonResponse({error})` and `NextResponse.json({error},{status})` across `api/dashboard/*`; centralize a typed error helper.
- **Document the `any` PgBouncer-JSONB carve-out** explicitly in CLAUDE.md so the 4 allowed sites are an explicit allowlist, not folklore.

> **Status (per sub-item):**
> - **§7.5a ✅ Resolved** in PR #316 — typed the `(loc: any)` in `useAddLocationWizard.ts` via a `VoiceConfigApiLocation` input DTO (nullable source shape, distinct from the defaulted `ExistingLocationVoice`).
> - **§7.5b ✅ Resolved** — the `FeaturesContent.tsx` disable was removed in an earlier sweep; the two remaining `react-hooks/exhaustive-deps` disables (`LoginForm.tsx`, `useLocationVoiceForm.ts`) now carry a prose justification (both are mount-only effects) added in PR #316. (The earlier "done" claim was incomplete — these two were still unjustified; verified and closed here.)
> - **§7.5c ✅ Resolved** — the `quota.ts:90-96` / `margin-service.ts:64` TODOs were closed by the §6.1 stored-snapshot fix (none remain in either file).
> - **§7.5d ✅ Resolved** in PR #316 — added a typed `errorResponse(code, status)` to `route-helpers.ts` and routed **41** dashboard error sites (`channels/**` + `dashboard/route.ts` + `kpis`) through it; every dashboard error now returns the uniform `{ error }` + no-store shape. Success payloads + the edit-reply flow untouched.
> - **§7.5e ✅ Resolved** in PR #316 — `CLAUDE.md` now documents the PgBouncer-JSONB `any` carve-out as an **explicit 2-site allowlist** (`RankingTrackingWorker.ts`, `admin/payment-success/route.ts`), correcting the scan's "4" (the Zernio request-body parses are HTTP bodies, not the stringified-column carve-out).

### Test-coverage assessment (mostly strong)
✅ Webhook handlers, billing math (`quota.test.ts`), idempotency/outbox transitions, tenant-scope (integration), approval-token paths, subscription guards, cost guard, output-filter/moderate — all have tests. ⚠️ **Gap:** `held-draft.ts` isolated tests (§7.2).

---

## 8 · Compliance, Data Lifecycle & Documented Residual Debt
_(scanned directly — lanes no agent owned)_

### 🟡 8.1 — No self-serve account deletion or data-export path (GDPR/CCPA gap)
- **Location:** absent. `DELETE FROM accounts` exists only in admin-onboarding
  rollback (`admin-onboarding-service.ts:325,422`) and signup cleanup
  (`auth/signup/route.ts:197`, `CleanupAbandonedSignupsPoller.ts:183`); no owner-
  facing erasure or export.
- **Evidence:** RepWorth stores PII — owner emails, phone numbers (SMS/WhatsApp
  enrollment), business identities, and review/response text. There is **no code
  path** for a live customer to exercise GDPR Art. 15 (access/portability) or
  Art. 17 (erasure), nor an admin tool to fulfill such a request end-to-end
  (cascade across `accounts`/`businesses`/`reviews`/`responses`/
  `channel_enrollments`/`api_costs`/`analytics_events` + Supabase Auth identity +
  Stripe customer). `sass_ready` lists "export/delete-account UI" as deferred —
  this confirms it's a **genuine pre-paid-customer compliance gap**, not just a
  UX nicety, especially for EU/UK SMB customers.
- **Recommendation:** before the first EU/UK paying customer, build (at minimum) an
  **admin-operated** erasure + export procedure with a tested cascade and an audit
  record, even if the self-serve UI comes later. Document the data map + retention
  in the DPA. Pairs with the audit-table retention decision (§3.6).

> **Status: ⏸️ Deferred (deliberate)** (2026-06-14) — **erasure (Art.17) is shipped; data EXPORT (Art.15 access/portability) is deliberately deferred until the first EU/UK paying customer** — the scan's own trigger — exactly like §3.4 and §7.4. The owner-offboarding cascade (spec `docs/superpowers/specs/2026-06-05-owner-offboarding-design.md`, migrations 056–061) gives a tested **erasure** path (`cancel_only` / `delete_data`) driven by the single-source-of-truth table map `src/lib/account-offboarding/table-disposition.ts` (33 tenant tables, each with disposition + scope evidence + purge-verification mode), with admin (`/api/admin/offboardings/*`) and owner (`/api/account/offboarding/*`) routes and an in-tx `account_audit_log` / `account_offboardings` record. **No Art.15 export path exists** — the offboarding `mode` schema accepts only `cancel_only` / `delete_data` (an `export_data` mode is rejected `400` by design; `src/app/api/account/offboarding/__tests__/confirm.test.ts` pins this), and `src/lib/legal/content.ts` states RepWorth provides no self-serve export. **Interim (pre-trigger) fulfillment:** an admin can satisfy a manual Art.15 request using that same `table-disposition.ts` map + one-off `account_id`/`business_id`-scoped reads — the capability exists, only the self-serve endpoint is deferred. **When built** (admin-operated minimum first, per the recommendation): an outbox-enqueued (invariant #2) Railway worker job (invariant #1) that DERIVES its table list from `table-disposition.ts` so export and purge can never drift — including the `retain_deidentified` tables (`accounts`/`businesses`/`users`) as the subject's own data — streams paginated JSON (no in-memory batch), writes an audit entry, and passes `ci:tenant-scope` + `ci:rls-audit`. Like §3.4 / §7.4, a conscious deferral with a documented trigger, not an oversight.

### 🟡 8.2 — Multi-location channel-enrollment account-scoping (documented active debt)
- **Location:** `docs/known-issues.md` — three **ACTIVE** items: (a) admin SMS lock
  `withMobileEnrollmentLock` + cross-channel precheck still keyed by `business_id`
  (`worker/ingress/twilio/`, `src/app/api/admin/channels/sms/`, 5 callers); (b)
  admin per-business channel status read
  (`src/app/api/admin/businesses/[id]/channels/route.ts`) lists by `business_id`,
  mismatching the account-scoped org-default; (c) dispatcher failure-handling
  enrollment writes flip status via `WHERE business_id = ctx.businessId`.
- **Evidence:** Telegram + WhatsApp owner paths were fixed to account-scope
  (`account_id` + `location_id IS NULL`); SMS-admin + dispatcher-write paths
  remained business-scoped, causing connect-500s / "idle vs already_verified"
  mismatches on multi-location accounts. Per session memory, **PRs #132 (admin
  read), #133 (dispatcher), #135 (SMS lock)** were opened to close exactly these —
  **verify they merged and update/close `known-issues.md` accordingly.** Listed
  here so the deep-scan doesn't appear to miss the codebase's own known-bug
  registry; not re-derived.
- **Recommendation:** confirm PR closure; if any remain open, they're real
  multi-location correctness bugs (invariant: org-default enrollment is
  account-scoped, `business_id` is legacy FK only). Add a regression test that an
  org-default row created under one location is read/written by `account_id`.

> **Status: ✅ Resolved (stale)** (2026-06-14) — resolved **by removal**, no code change. The item's source registry `docs/known-issues.md` was deleted (#275), and the **SMS notification channel was removed entirely** (#260, migration `061_remove_sms_schema.sql` — `CHANNEL_IDS` is now `['email','telegram','whatsapp']`; SMS was never live, `CHANNELS_SMS_ENABLED` defaulted off). That dissolved all three "active" sub-items: (a) the `withMobileEnrollmentLock` SMS lock + cross-channel SMS precheck and `src/app/api/admin/channels/sms/` no longer exist; (b)/(c) the SMS-admin read + dispatcher `WHERE business_id` enrollment writes that conflicted with the account-scoped org-default are gone. PRs #132/#133/#135 are moot. (Twilio remains, for **WhatsApp** delivery only — distinct from the removed SMS channel.) **Not a bug:** `src/app/api/admin/businesses/[id]/channels/route.ts` still reads by `business_id` — correct, because per-location *override* resolution is business-scoped; only **org-default** lookup is account-scoped + `location_id IS NULL` (invariant unchanged).

### 🟢 8.3 — Rate-limiter fail-open default — confirm coverage on all auth surfaces

> **Status: ✅ Resolved** in PR #300 (2026-06-12) — the fail-open branch now calls `reportCaughtError` (Sentry + structured log, limiter name only — keys can embed IPs), so a degraded limiter is visible. Strict coverage confirmed during the same sweep: signup, verify-otp, mfa/challenge, forgot-password, reset-password, resend-confirmation, login-attempt, and finish-signup all carry a `strict: true` failure catch returning 503.
- **Location:** `src/lib/shared/rate-limit.ts:30,67-73`
- **Evidence calibration:** Default is **fail-open** (Redis down → allow) "suitable
  for user-facing defense-in-depth," with an opt-in **strict** (fail-closed, 503)
  mode. The highest-risk endpoints **already use strict** — `auth/signup`
  (`{ strict: true }`) and `auth/verify-otp` (both email + IP, `{ strict: true }`),
  with explicit comments. So the brute-force concern is **largely handled.** The
  residual: confirm the *remaining* auth-sensitive routes (MFA challenge,
  forgot-password, resend-confirmation, login) also pass `strict: true` — otherwise
  a Redis outage opens a silent OTP/credential brute-force window on those. Also
  note the Redis-outage event only reaches `console.error` (no Sentry alert — ties
  to §2.2), so you wouldn't know rate-limiting had degraded.
- **Recommendation:** audit all auth/MFA routes for `strict: true`; emit a
  `Sentry.captureMessage` on the Redis-unavailable branch so a degraded limiter is
  visible.

### ✅ Verified safe (compliance/email)
- **Email HTML-injection:** the approval email (`templates/approval.ts`, the
  highest-risk template — it renders raw, attacker-influenceable review text)
  applies `escapeHtml()` to review text, reviewer name, business name, response
  preview, and date, and `escapeHrefUrl()` to links. Review content cannot inject
  HTML/phishing markup into the owner's inbox. *(Follow-up ✅ verified 2026-06-14:
  `templates/weekly-value-report.ts` (12 `escapeHtml`/`escapeHrefUrl` sites) and
  `templates/monthly-impact.ts` (10) escape every business-supplied string —
  business name, keyword, intelligence brief, review/response text, reviewer name —
  and `escapeHrefUrl()` all links, matching `approval.ts`. No injection surface in
  the digest templates.)*

---

## Appendix · Baseline health signals (good news)
- Only **10 TODO/FIXME/XXX** markers in src+worker non-test code.
- Only **4 `: any`** usages; **0 `@ts-ignore`/`@ts-expect-error`** in non-test code.
- **0** dependency vulnerabilities (`pnpm audit --prod`).
- TypeScript strict mode; SHA-pinned Actions; branch protection on `main`.
- Transactional outbox, partial indexes, batched retention, server-side
  pagination, model-pinning guard — a notably mature pre-launch posture.
