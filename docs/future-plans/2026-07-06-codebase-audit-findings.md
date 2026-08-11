# Codebase Audit — Findings & Remediation Tracker

**Audit conducted:** 2026-07-02 against `main` @ `8105b2c6` · **Documented:** 2026-07-06
**Type:** read-only due-diligence review (7-phase: architecture, correctness, security, performance, maintainability, config/ops) followed by a verification pass that re-checked every load-bearing claim against source.
**Status:** no code changed. This file is the punch-list for later fixing.

## Overall assessment

Mature, well-engineered codebase with genuinely strong security and reliability discipline. All six documented architecture invariants hold under spot-check, zero circular dependencies, the transactional-outbox spine and handler idempotency are model implementations, and a deep security pass found **no exploitable application vulnerabilities**. There is **one true critical** — live provider API keys sitting in git history (C1) — and **one outage-capable code defect** (H0). Everything else is medium/low: a handful of real correctness bugs, some scaling risks that aren't biting yet, and knowledge-duplication debt.

## How to read this

- **Severity** reflects the *audited* ranking (after a verification pass corrected some initial calls — e.g. the Stripe-ordering item was downgraded from High to Low).
- **Verified** = I read the cited code myself. **Reported** = high-confidence agent finding, corroborated but not personally re-read line-by-line.
- **Effort** rough sizing: S = <1h, M = half-day, L = 1+ day.
- Fix order guidance is at the bottom.

---

## 🔴 CRITICAL

### [ ] C1 — Live provider API keys exposed in git history · **Verified** · Effort: M

**What:** A root-level `keys.md` was committed in `24353cf1` ("Sprint 1: scaffolding", 2026-04-06) containing the full credential set, then deleted from the tree. The current working tree is clean (`.env*` is correctly gitignored; only `.env.example` is tracked) — but **git history is permanent**. Hash-comparison of the leaked values against the current `.env.local` (no secret values printed):

| Secret | Status |
|---|---|
| OpenAI `sk-proj-…` | 🔴 **STILL LIVE — never rotated** |
| Anthropic `sk-ant-api03-…` | 🔴 **STILL LIVE — never rotated** |
| SerpAPI key | 🔴 **STILL LIVE — never rotated** |
| Supabase anon key | 🟠 Still live (public-designed; low but nonzero) |
| Stripe `sk_test_…` | 🟡 Still live (test-mode; low) |
| Supabase **service** key | ✅ Already rotated |
| Twilio/Resend secret | ✅ Already rotated |
| Upstash Redis tokens (×2) | ⚠️ Var renamed — **verify manually** |

**Why it matters:** the still-live OpenAI/Anthropic/SerpAPI keys are directly billable and grant model/data access. Anyone who ever cloned the repo, any fork, or any CI cache holds working production credentials. The worst item (Supabase service key = full RLS bypass) was already rotated, which is why this is critical rather than catastrophic.

**Fix (in order):**
1. Rotate now: OpenAI, Anthropic, SerpAPI, Supabase anon. Verify/rotate both Upstash tokens. Confirm the Stripe test key.
2. Scrub history with `git filter-repo` (or BFG), force-push, re-clone all working copies. GitHub caches unreachable commits — file a support request to GC if the repo was ever public.
3. Update `docs/runbooks/secrets-rotation-api-keys.md` to include provider/infra keys (it currently covers only ENCRYPTION_KEY/SESSION_COOKIE_SECRET/CSRF_SECRET) and record this rotation in its (currently empty) log.
4. Add a pre-commit/CI secret scan (e.g. gitleaks) so a future `keys.md` can't land.

---

## 🟠 HIGH — live impact

### [ ] H0 — Unguarded async BullMQ `failed`-hook can crash all 24 queues · **Verified** · Effort: S

**Where:** `worker/jobs/zernio/ingest-failed-hook.ts:20-47` (registered at `worker/index.ts:153`).
**What:** `handleIngestFailed` awaits bare-`sql` INSERTs + `markOutboxFailed` with **no top-level try/catch**. A BullMQ `'failed'` listener's promise is never awaited, so any rejection becomes a process-level `unhandledRejection`. The crash-net's recoverable allowlist (`src/lib/db/transient-error.ts:79-92`) deliberately **omits** `53300 too_many_connections`, `40001`, `08000/08007/08P01`, and any code-less error → those hit `fatalExit` → `process.exit(1)`, killing every in-flight job across all 24 queues + 20 loops.
**Trigger:** a Zernio outage exhausts many `ingest_zernio_review` jobs at once → hooks fire concurrently → connection pressure yields `too_many_connections` (not in the allowlist) → whole worker restarts. A *deterministic* throw (e.g. TypeError on a drifted error shape) crash-loops hourly via the watchdog re-pend.
**Proof it's a miss, not a design choice:** the sibling `worker/jobs/publisher/failed-hook.ts:34-38` already wraps its whole body with the comment "any throw … bubbles into an unhandled promise rejection that could crash the process."
**Fix:** mirror `handlePublisherFailed` — top-level try/catch + Sentry capture + last-resort `markOutboxFailed(...).catch(...)`. Cheap insurance: enable `@typescript-eslint/no-floating-promises` for `worker/**` (currently off in `eslint.config.mjs`).

### [ ] H1 — Admin overview/jobs run unbounded full-table aggregates on a 30s poll · **Verified** · Effort: S–M

**Where:** `src/app/api/admin/overview/route.ts` (polled by `admin/overview/page.tsx:143`, `refetchInterval: 30_000`) and `src/app/api/admin/jobs/route.ts:76-93`.
**What (verified):**
- `overview/route.ts:105-114` email-health query has **no `WHERE`** — all time bounds are inside `FILTER(...)`, so the planner must sequential-scan all of `notification_deliveries` (no existing index serves it).
- `job_outbox` has **no index for `status='failed'`** across all 70 migrations (`idx_jo_topic` leads with `topic`; `idx_jo_pending` is partial on `status='pending'`), and failed rows are terminal and never archived → the failed set + the WHERE-less CASE-count full-scan the table twice a minute per open tab.
- `responses` is scanned twice more in the overview request; `responses`/failed `job_outbox` are never trimmed by `ArchivalPoller`, so cost grows with lifetime volume. In-code comment concedes "at MVP scale this is fine" — the growth curve is the risk.
**Fix (trivial, high value):**
- Add `WHERE created_at >= NOW() - INTERVAL '7 days'` to the email-health query (one line). Note: a dedicated `CREATE INDEX ... ON notification_deliveries (created_at)` may be needed — migration 034 only has a composite `(account_id, created_at)`.
- `CREATE INDEX CONCURRENTLY idx_jo_failed_created ON job_outbox (created_at DESC) WHERE status='failed';` and replace the WHERE-less CASE-count with per-status counts.
- Consider a 30–60s Upstash TTL cache on the whole overview payload (it's already polled at 30s).
- **Cross-agent convergence (3 agents):** this route also holds business logic in the handler with **zero tests** — extract to `src/lib/admin/overview-service.ts` (mirror `margin-service.ts`) + add tests in the same change.

---

## 🟠 HIGH — architectural (risk, not a live bug today)

### [ ] H3 — Approval-transition SQL is triplicated across all three approval modes · **Verified** · Effort: M

**Where:** `src/lib/approval/token-mode.ts:50-59` (email), `session-mode.ts:79-88` (dashboard), `callback-mode.ts:51-60` (chat) — the `UPDATE responses SET status='approved', approval_method=…, approved_at=NOW(), approved_text=response_text, posting_error=NULL` block is **byte-identical** in all three (plus each mode's own `edited`/`superseded` copies).
**Why it matters:** the single most safety-critical write in the system sits directly under invariant #3 ("no unapproved posting"). All three are currently identical and correct — the risk is a *future* schema/semantics change diverging one path from the others.
**Fix:** extract `markResponseApproved(tx, {responseId, businessId, method})` (+ `edited`/`superseded` siblings) into `src/lib/approval/transitions.ts`; the modes keep their distinct locking/link semantics.

### [ ] H2 — "All Locations" aggregate dashboard fans out an N+1 · **Reported** · Effort: L

**Where:** `src/lib/dashboard/aggregate-service.ts:97-118` runs the full 13-query dashboard batch **per location** (10 locations ≈ 145 queries). With Vercel's `DB_POOL_MAX=3`, 5 concurrent locations × 12 statements serialize into ~20 round-trip waves through PgBouncer. The file's own header comment earmarks this.
**Why it matters:** not biting yet, but will as multi-location accounts grow.
**Fix:** convert to set-based `GROUP BY business_id` account-level queries (each already exists in that form in the KPI layer); recent-reviews → one `ROW_NUMBER() OVER (PARTITION BY business_id)` query. Do before any account reaches ~10 locations.

### [ ] H4 — Business logic + inline SQL in the largest, hottest route handlers · **Reported** (convergent) · Effort: L

**Where:** `src/app/api/dashboard/route.ts` (425 lines — 4 inline SQL queries, the 30-day grace math at :91, the subscription-gating ladder implemented *twice* in-file), `src/app/api/zernio/connect/start/route.ts` (415 lines — 12-step Redis CAS + orphan self-heal business rule), `src/app/api/onboarding/start/route.ts` (352 lines).
**Why it matters:** these are the routes most likely to change; logic here can't be reused by workers or tested without route ceremony. Violates the project's own "routes call one module function" rule.
**Fix:** extract per family — `src/lib/dashboard/subscription-gate.ts`, `src/lib/zernio/connect-start.ts` (ADR 0001's own "Consequences" promised this and it never happened), `src/lib/onboarding/start-tx.ts`.

---

## 🟡 MEDIUM — verified correctness bugs

### [ ] M-A — Tombstone flow splits dependent writes across two autocommit statements · **Verified** · Effort: S

`worker/background/pollers/ZernioRecentReviewPoller.ts:220-236` marks reviews `'deleted'` (UPDATE #1) and fails their responses (UPDATE #2) as **two separate `await sql` statements, no `sql.begin`**. If #2 fails or the process dies between them, the next cycle's SELECT (`status <> 'deleted'`) never returns those reviews again → responses stranded forever in `pending_approval`/`approved` pointing at a source-deleted review; an `approved` orphan can even reach the publisher. **Fix:** wrap both UPDATEs in one `sql.begin`.

### [ ] M-B — Malformed-UUID params → uncaught `22P02` 500s across ~8 owner routes · **Verified** · Effort: S

`src/app/api/settings/voice/route.ts:28` interpolates `${locationId}::uuid` with no `isValidUuid` guard and no try/catch in GET; same gap at `src/lib/approval/http-routes.ts:160-170` and `src/app/api/dashboard/past-replies/_shared/edit-reply-request.ts:88-92`. Tenant scoping is intact — this is an error-contract bug (500 + Sentry noise instead of 400). The guard pattern already exists at `dashboard/route.ts:364-369`. **Fix:** `isValidUuid` guard at the two shared helpers + the voice GET (3 edits fix 8 routes).

### [ ] M-C — StripeCheckoutReconcileWorker marks outbox terminally failed on transient errors, then rethrows · **Verified (bounded)** · Effort: S

`worker/jobs/billing/StripeCheckoutReconcileWorker.ts:40-41` — `markOutboxFailed(...)` then `throw err`. A later successful BullMQ retry can't record success (`markOutboxCompleted` is guarded on `status='dispatched'` → no-ops), and a Stripe outage outlasting retries strands the row `'failed'` (the watchdog only recovers `'dispatched'`). **Bounded:** this is the *backup* reconcile lane; the Stripe webhook is the primary path (~3 days of provider retries). The correct pattern (`recordOutboxTransientError` for transient vs `markOutboxFailed` for terminal) is used 20 lines away in `UpdateStripeOverageWorker.ts:159-167`. **Fix:** classify transient vs terminal.

### [ ] M-D — Duplicate customer email on crash-after-send in two workers · **Verified** · Effort: S

`worker/jobs/OnboardingDripWorker.ts:173-183` sends the email, **then** sets `sent_at`, with no provider idempotency key → a crash between the two re-sends on watchdog replay (the own-outbox takeover branch re-enters on `sent_at IS NULL`). Siblings `WeeklySummaryWorker`/`MonthlyImpactWorker` deliberately mark-before-send. `EngagementAlertWorker` (partner-alert + owner-nudge branches) has the same shape. **Context:** `OutboxPoller` double-dispatch is by-design at-least-once (verified) — that's the mechanism that makes this ordering actually duplicate. **Fix:** mark-before-send (match siblings) or pass a stable Resend idempotency key.

### [ ] M-E — Tier-change validate/apply TOCTOU · **Reported** · Effort: M

`src/lib/accounts/tier-change.ts:46-119` (validate) checks "basic requires single location" outside the lock; `persistTierChangeTx` (:220-267) takes the `accounts` FOR UPDATE but re-validates nothing. A concurrent location-add can yield a basic account with 2 active locations → no overage price → persistent underbilling with no reconciler. Requires same-owner double-submit. **Fix:** re-run the location-count + tier-eligibility check inside `persistTierChangeTx` under the lock; abort with a retryable error.

### [ ] H6 — review-summary.ts violates two documented LLM contracts · **Verified** · Effort: S

`src/lib/responses/review-summary.ts:38,44` uses bare `new OpenAI()`/`new Anthropic()` → SDK-default ~10-min timeout + 2 retries (vs the generator's `LLM_CLIENT_OPTIONS` = 30s / 0 retries); and `:28` uses the **unpinned alias** `'gpt-4o-mini'` (`:29` Anthropic *is* pinned). Both escaped `model-pinning.test.ts`. Runs in Weekly/MonthlyImpact workers — a hung socket pins a queue ~10 min; an alias repoint silently changes shipped owner-facing summaries. Spend stays safe (cost guard reserves first). **Fix:** import the shared client options + pinned model constant; extend `model-pinning.test.ts` to this file.

### [ ] H7 — Location route masks server faults as HTTP 401 · **Verified** · Effort: S

`src/lib/locations/owner-route.ts:67-73` — when `requireRole` throws anything other than an `AuthError` (e.g. a DB outage), it returns `{ error: 'Unauthorized' }` at 401 instead of re-throwing to a 5xx. The canonical gate (`src/lib/auth/route-helpers.ts:120-123`) explicitly documents that this exact drift "hid genuine server faults behind an 'Unauthorized' response." Affects all four `/api/locations/*` routes: faults become undiagnosable, and the client may log the user out. **Fix:** re-throw non-`AuthError` (or return `internal_error` 500).

---

## 🟢 LOW / defense-in-depth

### [ ] H5 — Stripe out-of-order webhook can transiently re-flag an account · **Verified (downgraded from High)** · Effort: M

`worker/ingress/stripe/apply-subscription-state.ts:93-120` allows `active→past_due` with **no `event.created` comparison**, and `invoice-payment-failed.ts` applies a *synthesized* `past_due` (not a live retrieve). An out-of-order `payment_failed` after a healed `invoice.paid` can re-flag the account. **Why it's Low, not High:** (1) self-healing — `invoice-paid.ts` applies a *live* `subscriptions.retrieve`, so the next real event corrects it; (2) caught — `reconcile-account.ts:185-237` auto-corrects only the `trialing` drift but surfaces every other status mismatch as a human-actioned drift alert (verified). The "auto-cancel a paying customer" outcome needs an extra unproven `past_due→cancelled` step. **Fix:** retrieve live subscription status in the payment-failed path (mirror invoice-paid), or compare `event.created` before applying.

### [ ] LOW-1 — Public demo page writes `view_count` to Postgres on every unauthenticated view · **Reported** · Effort: S
`src/app/(public)/demo/[slug]/page.tsx:18,83` (4-month-old TODO). Write-amplification under crawler traffic. Implement the noted Redis `INCR` + flush, or drop the counter.

### [ ] LOW-2 — Three HMAC-signed-cookie impls, four constant-time-compare variants · **Reported** · Effort: M
`approval/cookies.ts`, `zernio/connect-session-cookie.ts`, `admin/impersonation/cookie.ts` (divergent UTF-8 byte compare), `shared/feedback-hmac.ts`. **Not a vuln** (security pass confirmed all are constant-time) — security-primitive drift risk. **Fix:** one `src/lib/shared/signed-value.ts` (`signValue`/`verifySignedValue` + one `constantTimeEqual`); modules delegate.

### [ ] LOW-3 — 30-day cancellation-grace window has two owners · **Reported** · Effort: S
`src/app/api/dashboard/route.ts:91` (`30 * 86_400_000`, JS) vs `worker/background/pollers/CancellationGracePoller.ts:48` (`INTERVAL '30 days'`, SQL, no fallback) — can already disagree on legacy rows. **Fix:** shared `cancelledGraceDeadline()` (mirror the correct `past-due-recovery.ts`).

### [ ] LOW-4 — Worker ingress logs via bare `console.*` (90 calls) · **Reported** · Effort: M
Concentrated in Stripe/Zernio ingress handlers — bypasses `createWorkerLogger` + its sanitizer. Next.js API routes also lack structured logging (correlation IDs only begin once a job payload exists). **Fix:** thread `createWorkerLogger('ingress:…', eventId)` through ingress; add a thin route logging wrapper with `LOG_SERVICE=web`.

### [ ] LOW-5 — 13 public routes leak raw Zod `issues` arrays; two error-shape dialects · **Reported** · Effort: S
`onboarding/start:255`, `auth/signup:71`, etc. expose internal schema paths; some routes use `{error: snake_code}`, others `{error: "Prose"}`; `internal` vs `internal_error`. **Fix:** one shared `invalidBody(parsed.error)` helper emitting a stable shape.

### [ ] LOW-6 — CLAUDE.md JSONB string-guard allowlist has drifted · **Verified (doc-only)** · Effort: S
Doc says "exactly 2 sites" and references a deleted route (`admin/payment-success/route.ts`); ≥6 real guard sites exist (`OutboxPoller.ts:216`, `AdminExceptionWorker.ts:121`, `AnalyticsDispatchPoller.ts:148`, `billing-reconciliation/account-flags.ts`, `past-replies/draft-status/route.ts:81`, `RankingTrackingWorker.ts:39`). **No unguarded JSONB read exists** — doc-accuracy only. **Fix:** rewrite the allowlist.

---

## 🧹 CLEANUP / TECH DEBT (batch when convenient)

| Item | Location | Fix | Effort |
|---|---|---|---|
| Dead `withRateLimit`/`withSession` wrappers (0 call sites) while 24 routes copy-paste the ceremony | `src/lib/auth/route-helpers.ts:29-46,79-91` | Adopt or delete | S |
| Raw `INSERT INTO job_outbox` in 5 routes bypasses the typed helper | `onboarding/start:148`, `demo/regenerate:149`, `signup-status:55`, `admin/demos/generate:148`, `zernio-queue:115` | Add `enqueue*` helpers + a `ci:` grep gate | M |
| Hard-bounce prefix synced across 2 files by a comment | `worker/ingress/resend.ts:116` ↔ `admin/overview/route.ts:111` | Export `HARD_BOUNCE_FAILURE_PREFIX` | S |
| Approval-URL built in 3 places; claim-rollback block pasted twice | `notification/dispatch.ts:311`, `EngagementAlertWorker`, `OnboardingDripWorker`; `OwnerEmailWorker.ts:204≡312` | `buildApprovalUrl()`; extract claim-rollback helper | S |
| ~10 local UUID-regex copies alongside canonical `isValidUuid` | `billing/checkout:31`, `locations/owner-route:13`, zernio/disconnect, feedback, analytics/enqueue, csv-import, … | Export `zUuid` from `ids.ts`; delete copies | S |
| 2 synthetic subscription-status string literals | `dashboard/route.ts:57,244` string-matched in `DashboardContent.tsx:189,200`, `useSettingsForm.ts:54` | Add virtual statuses to `subscription-status.ts` | S |
| Email shell "defined ONCE" adopted by only 2 of 10 templates | `email/templates/shared.ts:45`; 8 files keep own `<!DOCTYPE>` | Migrate onto `buildEmailShell` or fix the comment | M |
| Invariant-#1 ESLint zones miss 4 Vercel-shipping surfaces (no live violation) | add `src/hooks/**`, `src/contexts/**`, `src/proxy.ts`, `src/instrumentation-client.ts` to the entry zone | + 1 fixture each in `eslint-boundaries.test.ts` | S |
| 6 dead-code items | `worker/jobs/publisher/types.ts`, `landing-legacy/VideoHero.tsx`, `be-ui-tilt-card.tsx:23,29`, `useEditReplyDraft.ts:47`, 1 CSS asset | Delete (2 auto-fixable via `fallow fix`) | S |
| 2 commented-out remnants | `dashboard/page.tsx:12`, `serpapi-prefill.ts:99` | Delete lines | S |
| Fallow stale-suppression signal masked by 80 false positives | trailing-prose suppression comments (e.g. `AutoPostNoticeWorker.ts:29`) | Move rationale off the directive line | S |
| Comment/config drift | `worker/index.ts:136-143` claims "Concurrency 5" but runs at 1; notification-worker single-flight relies on an unasserted `concurrency:1` | Fix comment / add boot assertion | S |
| Prod log lines omit stack traces (Sentry-only) | `logger.ts:37-40` | Acceptable; note the Sentry dependency in the alerting runbook | S |
| `AnalyticsDispatchPoller` does up to 250 serial UPDATEs/cycle | `AnalyticsDispatchPoller.ts:183-185` | One set-based UPDATE with a VALUES join | S |
| `EngagementMonitorPoller` unbounded `responses` aggregate (daily cadence contains it) | `EngagementMonitorPoller.ts:92-100` | LATERAL `ORDER BY approved_at DESC LIMIT 1` per business | M |
| No dashboard/KPI payload caching; all 3 owner tabs fetch the full payload | `service.ts`, `useDashboardData.ts` | 30–60s Upstash TTL keyed `(scope, window)`, invalidated on write paths | M |

**Dependencies:** production is nearly clean — 1 moderate transitive advisory (`@opentelemetry/core` via `@sentry/nextjs`). The HIGH/moderate `vite`/`launch-editor`/`@babel/core` advisories are Windows-only dev-tooling transitives (vitest/eslint), not in the Vercel/Railway runtime. `pnpm audit --prod` already runs non-blocking in CI.

---

## Non-findings (correctly hedged — do NOT chase)

- **Perf S1** — `ZernioReviewIngestWorker` walks up to 4×50-review pages per webhook. May be deliberate (webhook lacks a stable id, or the page-walk doubles as reply reconciliation). Confirm intent before touching.
- **Perf S2** — ~~`GET /api/dashboard/kpis` appears to have no UI consumer. No current cost; only a concern if later wired *in addition to* `/api/dashboard`.~~ **RESOLVED by #757 (2026-08-11, PR #793):** the observation was correct — zero consumers, verified three ways — and the route plus its whole `src/lib/kpi/service.ts` stack were **deleted** rather than wired up. `/api/dashboard` is now the one KPI path.
- **HMAC compares are NOT a security bug** — all four are constant-time; LOW-2 is purely DRY.

## What's done well (preserve)

All 6 architecture invariants hold; zero circular deps. No exploitable security vulns (IDOR scoping, injection, webhook signature verification, approval-token handling, service-key isolation all sound; all prior-audit HIGHs remediated). Cost-guard reserves before every LLM call (spend always safe). OutboxPoller is a model at-least-once spine; the outbox invariant is expressed *as a type* (enqueue helpers require a `TxClient`); `FOR UPDATE` has **zero** unsafe uses (all ~30 inside `sql.begin`). Handler idempotency 5/5. Best-in-class ESLint boundary system with a regression test. Correlation IDs + dual-side Sentry with scrubbing + business-visible-failure alerting. Strong HTTP security headers + CSP + BotID. 623 test files; all 7 mandated critical areas covered; zero env drift; four security-guardrail CI audits pass.

---

## Suggested fix order

1. **C1** — rotate still-live keys + scrub history (the one critical).
2. **H0** — guard the ingest `failed`-hook + enable `no-floating-promises` for `worker/**` (smallest diff, largest blast-radius reduction).
3. **H1** — one-line `WHERE` + `idx_jo_failed_created` + per-status counts (trivial; kills two 30s full scans).
4. Verified mediums: **M-A** (one `sql.begin`) → **M-B** (UUID guards, 8 routes) → **M-C** → **M-D** → **H6** → **H7** → **M-E**.
5. Architectural (schedule): **H3** → **H4** → **H2** (before multi-location growth).
6. Low / cleanup: batch opportunistically when touching the relevant files.
