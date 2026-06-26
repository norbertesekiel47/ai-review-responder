# RepWorth — Codebase Audit & Remediation Plan

**Date:** 2026-06-25
**Scope:** Full-codebase audit across six dimensions — production readiness, modularity, clean codebase, scalable architecture, cost factors, security.
**Method:** Five parallel specialist agents read the actual code (not just docs), cross-checked against independent static analysis (`fallow`: 0 circular deps, 0 architecture-boundary violations, 92.5 avg maintainability, 1.8% duplication) and repo metrics (1,432 TS files, ~222k LOC, 594 test files, 69 migrations, 8 bespoke CI gates).
**Purpose of this doc:** Record the scores **and** every concrete fix needed to raise each dimension toward 10. Each fix carries a file:line location, the change, why it moves the score, an effort estimate, and a verification step. Owner applies changes later.

> Effort key: **S** = <30 min · **M** = hours · **L** = 1–3 days · **XL** = week+
> Severity key: **HIGH** = fix before scaling past beta · **MED** = fix this quarter · **LOW** = opportunistic

---

## Scorecard — current → target

| Dimension | Current | Target after fixes | Gating items |
|---|:---:|:---:|---|
| Production readiness | **8 / 10** | 9.5 | Readiness probe unwired (HIGH); one unbounded LLM client (HIGH) |
| Modularity | **9 / 10** | 9.5 | A few fat worker handlers; one comment-synced duplicate array |
| Clean codebase | **9 / 10** | 9.5 | SQL-heavy god-functions; 28 critical-complexity functions |
| Scalable architecture | **8 / 10** | 9 | Single worker process + single Upstash SPOF; unpaginated loops |
| Cost factors | **8.5 / 10** | 9.5 | Demo lane has no per-tenant guard; one bare model alias |
| Security | **8.5 / 10** | 9.5 | CI guards regex-evadable; mock-mode webhook fail-open |
| **Overall** | **8.5 / 10** | **~9.5** | Ship-ready at beta scale; short, well-understood fix list |

**Verdict:** Top-decile codebase for its stage. Documented invariants are genuinely reflected in code, not aspirational. Weaknesses are refinements and scaling work, not structural decay. Completing **Quick Wins + all HIGH items** retires every HIGH-severity correctness/readiness risk.

---

## Master checklist (severity-ordered)

### 🔴 Quick wins (HIGH/MED value, ≤1 hr total) — do these first
- [ ] **PR-2** Bound + reuse LLM client options in `review-summary.ts` (HIGH, S) — also fixes COST-3
- [ ] **PR-1** Point Railway healthcheck at `/ready` (HIGH, S)
- [ ] **PR-3** Boot-assert `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` (MED, S)
- [ ] **COST-2** Pin summary model `gpt-4o-mini` → `gpt-4o-mini-2024-07-18` + guard test (LOW, S)
- [ ] **PR-4** Boot-assert `REDIS_CACHE_URL` unconditionally (MED, S)
- [ ] **SEC-6** Fix Resend `Date.now()` dedup fallback (LOW, S)

### 🟠 HIGH severity (before scaling past beta)
- [ ] **PR-1** Readiness probe wired to traffic gating
- [ ] **PR-2** No unbounded LLM client anywhere
- [ ] **ARCH-1** Worker horizontally scalable (split roles, lock single-instance assumptions)
- [ ] **ARCH-2** Reduce Upstash blast radius (split correctness-critical keys)

### 🟡 MED severity (this quarter)
- [ ] **PR-3** LLM API keys boot-asserted
- [ ] **PR-4** `REDIS_CACHE_URL` boot-asserted
- [ ] **PR-5** Explicit BullMQ `lockDuration`/`stalledInterval`/`maxStalledCount`
- [ ] **PR-6** Next.js request correlation wired
- [ ] **ARCH-3** Keyset pagination on per-account background loops
- [ ] **ARCH-5** `checkSubscription` reads immutable `accounts.past_due_at`
- [ ] **COST-1** Demo lane per-tenant cost attribution + sub-ceiling
- [ ] **CLEAN-1** Break SQL-heavy god-functions
- [ ] **CLEAN-2** Test for `getCostReport` archival-boundary split
- [ ] **SEC-1** `sql.unsafe(nonLiteral)` fails the tenant-scope audit
- [ ] **SEC-2** AST-based `process.env` audit (#13/#14 robustness)
- [ ] **SEC-3** Remove webhook mock-mode fail-open in prod
- [ ] **SEC-4** Admin-AAL2 audit call-graph-based

### 🟢 LOW severity (opportunistic)
- [ ] **PR-7** Migrate raw `console.*` ingress/generator logs to `createWorkerLogger`
- [ ] **PR-8** Fix OutboxPoller interval doc drift (30s vs 10s)
- [ ] **MOD-1** Replace comment-synced status array with shared constant
- [ ] **MOD-2** Extract behavior from 200–350-line worker handlers
- [ ] **CLEAN-3** Move `dashboard/route.ts` logic into service layer
- [ ] **CLEAN-4** Reduce critical-complexity production functions
- [ ] **COST-3** `LLM_CLIENT_OPTIONS` on all LLM constructors (folded into PR-2)
- [ ] **COST-4** Reconcile stranded reservations on finalize failure
- [ ] **COST-5** Record moderation spend in `api_costs`
- [ ] **COST-6** `api_costs` cron alert on margin thresholds
- [ ] **COST-7** Paginate `margin-service.getMarginReport`
- [ ] **ARCH-4** Plan `reviews`/`responses` partitioning + tombstone pruning
- [ ] **SEC-5** Trust only edge-set forwarded IP header
- [ ] **SEC-7** Track dev-only `undici`/jsdom/vitest CVEs

---

## 1. Production readiness — 8 → 9.5

**Already strong:** Transactional outbox is *type-enforced* (only `queue.add` is `OutboxPoller.ts:228`; producers route through `enqueue*(tx, …)` helpers — invariant #2 structurally unbreakable). Retry classification surgically correct (`generate-draft.ts:110-139`). Every third-party egress bounded (Stripe 20s, Zernio/Resend/Twilio/Telegram 10s, LLM 30s, Postgres.js `statement_timeout` 30s). Sentry scrubber covers all event shapes + masks approval tokens. Graceful shutdown drain→flush→close with watchdog. Secret-leak hunt came back clean.

### PR-1 · Point Railway healthcheck at `/ready` — **HIGH · S**
- **Where:** `railway.toml:22` (`healthcheckPath = "/api/health"`); readiness endpoint already exists at `worker/index.ts:351-366` (`/ready` probes Postgres + queue Redis + cache Redis, 503-on-fail).
- **Problem:** `/api/health` returns only `{status, uptime}` — a worker can boot with a dead DB / misconfigured Redis `family` and still pass the healthcheck and receive webhook ingress traffic. The deep readiness probe is dead infrastructure.
- **Fix:** Set `healthcheckPath = "/ready"` (or add a synthetic monitor that scrapes `/ready` and alerts). Confirm `/ready` returns 200 only when all three dependencies answer.
- **Score impact:** Removes the single biggest silent-outage vector → +0.75 on its own.
- **Verify:** Deploy to staging with an intentionally bad `REDIS_CACHE_URL`; confirm the platform marks the deploy unhealthy instead of routing traffic.

### PR-2 · Bound + reuse the LLM client in `review-summary.ts` — **HIGH · S**
- **Where:** `src/lib/responses/review-summary.ts:38,44` — `new OpenAI()` / `new Anthropic()` constructed with **no options**.
- **Problem:** Inherits SDK default ~10-min timeout + 2 internal retries on *both* providers. A provider stall pins the worker invocation up to ~20 min/attempt — the exact failure mode `generator.ts:47` prevents everywhere else. (Independently flagged by the cost audit; see COST-2/COST-3.)
- **Fix:** Extract the existing `{ timeout: 30_000, maxRetries: 0 }` into a shared exported `LLM_CLIENT_OPTIONS` constant (e.g. in `src/lib/responses/llm-client-options.ts`) and pass it to **every** `new OpenAI()`/`new Anthropic()` — `review-summary.ts`, `moderate.ts:19`, and `generator.ts:47`.
- **Score impact:** Closes a 20-min worker-hang AND a cost-retry leak in one change. Highest value-to-effort fix in the whole audit.
- **Verify:** Add a unit test asserting all LLM constructors receive `maxRetries: 0` and a bounded timeout; extend the model-pinning test file to assert it.

### PR-3 · Boot-assert LLM API keys — **MED · S**
- **Where:** `worker/config/startup-assert.ts:23-28` (`assertCoreInfraEnv` asserts DB/Supabase/queue Redis but **not** `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`). Accessor already exists, unwired, at `config/worker.ts:231`.
- **Problem:** A typo'd LLM key boots clean, passes health, and the first `GENERATE_RESPONSE` job fails — then BullMQ retries + the 1h watchdog burn concurrency slots against an unrecoverable misconfig.
- **Fix:** Add both keys to `assertCoreInfraEnv` so boot fails fast.
- **Verify:** Unset `OPENAI_API_KEY` locally; confirm the worker refuses to boot with a clear message.

### PR-4 · Boot-assert `REDIS_CACHE_URL` unconditionally — **MED · S**
- **Where:** `worker/config/startup-assert.ts:195` (asserted only under `SELF_SERVE_SIGNUP_ENABLED`).
- **Problem:** This single Upstash instance backs cache + rate-limit + cost-reserve + regen-budget + idempotent-generation. If signup is off but the URL is missing/typo'd, only `/ready` catches it — boot does not.
- **Fix:** Move the assertion into `assertCoreInfraEnv` (unconditional).
- **Verify:** Unset `REDIS_CACHE_URL`; confirm boot failure.

### PR-5 · Set explicit BullMQ stall/lock options — **MED · S**
- **Where:** `worker/queues.ts` (`defaultJobOptions` sets attempts/backoff but leaves `lockDuration`/`stalledInterval`/`maxStalledCount` at BullMQ defaults).
- **Problem:** A job blocked >30s (default `lockDuration`) risks stalled-requeue → double-execution. Currently tolerable *only* because handlers are idempotent — but it's an implicit dependency.
- **Fix:** Set `lockDuration` comfortably above the slowest expected handler (account for the 30s LLM timeout + finalize), and pin `stalledInterval`/`maxStalledCount` explicitly with a comment explaining the relationship to handler timeouts.
- **Verify:** Document the chosen values against the longest handler's worst-case wall-clock.

### PR-6 · Wire Next.js request correlation — **MED · M**
- **Where:** `src/lib/shared/log-context.ts` (`withLogContext`/`createRequestId`/`mergeLogContext` exist but are used nowhere in `src/app`; there is no `middleware.ts`).
- **Problem:** Worker-side correlation is comprehensive; UI-side request logs carry no `request_id`/`correlation_id`, so a route→worker trace only connects if the ID is explicitly written to the outbox row.
- **Fix:** Add `src/middleware.ts` that seeds a request ID into ALS; adopt `withLogContext` in API route handlers; propagate the ID onto outbox rows so worker logs join the same trace.
- **Verify:** A single review-response flow shows one correlation ID from the ingress route through to the posted reply.

### PR-7 · Migrate raw `console.*` log sites — **LOW · M**
- **Where:** ~150 sites across `worker/ingress/*` and `src/lib/responses/generator.ts`.
- **Problem:** Raw `console.*` bypasses both the analytics blocked-key sanitizer and structured fields/correlation. No active leak today (curated `{length, count}` shapes), but a future `console.log('ctx', stripeEvent)` would leak with nothing to catch it.
- **Fix:** Route through `createWorkerLogger`; optionally add a lint rule banning `console.*` in `worker/` and `src/lib/`.
- **Verify:** `pnpm lint` flags new `console.*` in those paths.

### PR-8 · Fix OutboxPoller interval doc drift — **LOW · S**
- **Where:** `OutboxPoller.ts:22` (default 30s) vs `db/server.ts:27` comment + outbox-pattern skill (say "10s").
- **Fix:** Reconcile docs to the real 30s, and sanity-check it against the 2-min/1-h watchdog windows.

---

## 2. Modularity — 9 → 9.5

**Already strong:** Deep modules with discriminated-union contracts (`subscription-guard.ts:37` → `Allowed | Denied`). Reversible provider seams (`NotificationChannel` interface, `ReviewSource → NormalizedReview` DTO — adding a channel/source = one file + factory line). Orchestrator/module separation genuine (invariant #12). **0 circular dependencies, 0 architecture-boundary violations** (static analysis).

### MOD-1 · Replace comment-synced status array with shared constant — **LOW-MED · S**
- **Where:** `worker/jobs/publisher/ResponsePublisherWorker.ts:67` and `worker/jobs/publisher/failed-hook.ts:33` both redeclare `['approved','edited','awaiting_owner_connect']`, kept in sync by a comment ("mirrors AWAITING_PUBLISH_STATUSES exactly").
- **Problem:** The comment is the only thing preventing drift — exactly the DRY hazard repworth.md warns against.
- **Fix:** Import the canonical `AWAITING_PUBLISH_STATUSES` from `src/lib/shared/response-status.ts` in both sites; delete the local arrays.
- **Verify:** `pnpm ci:response-status` + existing publisher tests stay green.

### MOD-2 · Extract behavior from 200–350-line worker handlers — **LOW-MED · M**
- **Where:** `reconcileAccount` (353, `worker/background/pollers/billing-reconciliation/reconcile-account.ts:47`), `handleWeeklySummary` (251), `handleZernioBackfill` (245), `MonthlyImpactWorker.handle` (234), `OutboxPoller.pollOutbox` (232).
- **Problem:** Flat (not nested) but at the edge of invariant #12's "orchestration-only" carve-out — pollers are where that latitude is thinnest.
- **Fix:** Extract the core decision logic (e.g. the Stripe-vs-projection diff in `reconcileAccount`) into named modules with focused tests; leave the handler as orchestration.
- **Verify:** New unit tests on the extracted decision modules; handler length drops below ~120 lines.

---

## 3. Clean codebase — 9 → 9.5

**Already strong:** 2 real `any` in 108k non-test LOC (a legitimate Google Maps SDK gap), **0 `@ts-ignore`**, all 6 `@ts-expect-error` in one test exercising SDK typing limits. Single-source-of-truth `as const` constants (`subscription-status.ts`, `tier-config.ts`, `queue-names.ts`). Comments are "why" not "what"; **2 TODOs total**. Duplication 1.8%; avg cyclomatic 3.2; maintainability 92.5.

### CLEAN-1 · Break SQL-heavy god-functions — **MED · M**
- **Where:** `getCostReport` (**384 lines**, `src/lib/admin/cost-report-service.ts:117`); `reconcileAccount` (353, see MOD-2).
- **Problem:** Low cyclomatic complexity but high read burden; `getCostReport`'s 4-way `needsRollup × accountId` branching duplicates near-identical CTEs.
- **Fix:** Extract a small query-builder or branch helpers; a branch extraction can cut `getCostReport` ~60%.
- **Verify:** Function length + the duplicated-CTE count drop; cost-report output unchanged (snapshot test).

### CLEAN-2 · Test the `getCostReport` archival-boundary split — **MED · S**
- **Where:** `cost-report-service.ts` rollup boundary (`rollup_date <= CURRENT_DATE - 90 days`) — currently guarded only by a correctness comment.
- **Problem:** The boundary-day split (live rows vs archived rollups) is exactly the kind of off-by-one that silently corrupts a finance report.
- **Fix:** Add a focused test exercising rows on both sides of the 90-day boundary, including the boundary day itself.
- **Verify:** New test fails if the boundary predicate changes.

### CLEAN-3 · Move `dashboard/route.ts` logic into the service layer — **LOW · M**
- **Where:** `src/app/api/dashboard/route.ts` (404 lines) defines `fetchPerLocationData`/`getPrimaryLocationId` that do real query + branching work in the route file.
- **Problem:** Weakest adherence to "route handlers parse input, call one module, return output" (this is **not** an OAuth-handshake path, so ADR 0001's carve-out doesn't apply).
- **Fix:** Move those helpers into `src/lib/dashboard/`; the route resolves scope policy and delegates.
- **Verify:** Route file shrinks to thin orchestration; service has its own tests.

### CLEAN-4 · Reduce critical-complexity production functions — **LOW · M**
- **Where:** 28 "critical" complexity findings; the production-path offenders are `api/admin/overview/route.ts` GET (cyc=32, crap=1056), `allBusinesses` (cyc=24) in the same file, `api/onboarding/demo/regenerate/route.ts` POST (cyc=16, cog=21), `app/(authenticated)/dashboard/connect/page.tsx` `ConnectPageInner` (cyc=25, cog=35). *(Dev scripts like `scripts/redis.ts` cyc=49 are low priority — not runtime.)*
- **Fix:** Extract branch logic; for the admin-overview GET, push aggregation into a service (mirrors CLEAN-3).
- **Verify:** `fallow health --hotspots` shows these dropping below threshold.

---

## 4. Scalable architecture — 8 → 9

**Already strong:** "Vercel = UI only" rigorously enforced (all 98 API routes swept: zero LLM/external calls except two documented SerpAPI prefills + Zernio OAuth handshake; invariant #1, CI-backed). Outbox + watchdog textbook (`FOR UPDATE SKIP LOCKED`, attempt-scoped updates, 3-phase stale recovery). Dual-Redis split real (queue on Railway IPv6 private net; cache on Upstash TLS with 3s command timeout). Schema fundamentals sound (UUIDv7 PKs, partial indexes byte-matched to `ON CONFLICT`, archival poller caps growth).

### ARCH-1 · Make the worker horizontally scalable — **HIGH · XL**
- **Where:** `railway.json` (only `restartPolicyType=ON_FAILURE`, no replica count); `worker/index.ts` (one process runs all 22 BullMQ workers + ~22 background loops + ingress).
- **Problem:** Dominant SPOF and the #1 throughput ceiling. The single-concurrency overage worker + per-account Stripe idempotency keys *assume exactly one instance* — adding a replica today would double-bill.
- **Fix:** Split the Railway service into at least two roles — (a) BullMQ job consumers (the hot pipeline), (b) background pollers/schedulers + ingress. Make consumers replica-safe; move the single-concurrency overage worker + per-account Stripe idempotency to a leader-elected / advisory-locked design (or a dedicated single-replica service) **before** adding consumer replicas.
- **Score impact:** Removes the dominant SPOF *and* the throughput wall in one move → the largest single lift toward "1,000-business ready."
- **Verify:** `assertSingleConcurrencyWorker` (`worker/index.ts:185`) still passes for the locked worker; load test two consumer replicas with no double-post/double-bill.

### ARCH-2 · Reduce the Upstash blast radius — **HIGH · L**
- **Where:** Single Upstash backs cache + rate-limit + cost-reserve + regen-budget + idempotent-generation + channel-resolve cache.
- **Problem:** Every touch is individually resilient (3s timeout; pre-LLM errors retry; rate-limit fails open), but a sustained outage stalls *all* generation, and cost-reserve being down blocks new LLM work by design.
- **Fix:** Split the correctness-critical keys (cost-reserve, regen-budget, concurrency) onto their own Redis namespace/instance, separate from the soft cache, so a cache outage can't co-fail spend control.
- **Verify:** Kill the cache instance in staging; confirm cost-reserve + generation still function on the dedicated instance.

### ARCH-3 · Keyset-paginate per-account background loops — **MED→HIGH at scale · M**
- **Where:** `EngagementMonitorPoller.ts:86-129` (all active+trialing, daily), `StripeLocationsReconcilePoller.ts:123-156` (all paid accounts, **hourly**, loads upfront), `OnboardingDripScheduler.ts:34-54` (CROSS JOIN × 3 drip types, hourly), and the most frequent offender `ZernioRecentReviewPoller` tombstone scan (~189-230, unbounded per connection, **every 60s**).
- **Problem:** In-memory loads grow linearly with account/review count; uncomfortable around 10k–50k accounts (and earlier for a single customer with a huge review corpus).
- **Fix:** Apply the keyset-pagination pattern that **already exists** in `ZernioRecentReviewPoller`/`AnalyticsDispatchPoller` (`WHERE id > $cursor … LIMIT N` across ticks) uniformly; for the 60s tombstone scan add `LIMIT` + multi-tick, or `DELETE … RETURNING` without loading.
- **Verify:** Seed a synthetic account with 50k reviews; confirm per-tick row counts stay bounded.

### ARCH-4 · Plan `reviews`/`responses` partitioning + tombstone pruning — **LOW · L**
- **Where:** Deliberately deferred (migrations-log §retention); `dashboard/service.ts:115-121` ranking-snapshots read has no LIMIT (~2.6k rows/dashboard-load at 50 keywords × 52 weeks).
- **Problem:** Correct today; the first hot-path reads to degrade once per-customer history reaches tens of thousands of rows.
- **Fix:** Add a LIMIT/time-window to the ranking-snapshots read now (cheap); schedule partitioning + `status='deleted'` tombstone pruning before that scale arrives.
- **Verify:** Dashboard query plan stays index-only as review volume grows.

### ARCH-5 · `checkSubscription` on immutable `accounts.past_due_at` — **MED · M**
- **Where:** `checkSubscription` reads mutable `businesses.updated_at` for `past_due` grace; the immutable `accounts.past_due_at` exists (migrations-log Risk #2) but isn't wired in.
- **Problem:** Any unrelated `businesses` write resets `updated_at` → can extend a customer's 7-day past-due grace **indefinitely** (revenue leak).
- **Fix:** Compute grace from `accounts.past_due_at`.
- **Verify:** Add a test: a `businesses` update mid-grace does **not** extend the grace window.

---

## 5. Cost factors — 8.5 → 9.5

**Already strong:** Reserve-before-spend is structural for every billed path (LLM call only inside `withCostGuard` → `reserveCost`). Four-layer ceiling stack (per-review 3/day, per-business tier limit, global $100/day, per-business concurrency=3). LLM SDK retries disabled so BullMQ is the sole retry authority (prevents up to 12 billed calls/generation). Idempotent cache keyed by `(reviewId, version)`. Cheap pinned models. SerpAPI strictly active-only. Per-account margin observable (`margin-service.ts`).

### COST-1 · Per-tenant attribution + sub-ceiling on the demo lane — **MED · M**
- **Where:** `worker/jobs/onboarding-demo/.../generate-responses.ts:41` (`mode:'demo'`); `runDemoMode` (`generator.ts:91-117`) bypasses `withCostGuard` and caching by design; only ceiling is the global `cost:onboarding-demo:<date>` ($10/day) at `onboarding-demo-cost-guard.ts`.
- **Problem:** The pre-pay demo is the only LLM surface with no per-tenant budget and no `api_costs` attribution. One actor with multiple auth'd accounts + IP rotation could consume the full $10/day ceiling and starve real signups (denial-of-budget); it fans out 3 LLM calls per 20¢ reservation.
- **Fix:** Record demo spend in `api_costs` (synthetic "onboarding" bucket / null account); add a per-auth-id daily **cost** cap (not just request-count rate limits).
- **Score impact:** Closes the weakest cost surface and makes demo spend visible to `margin-service`.
- **Verify:** A scripted multi-account demo run shows attributed spend and trips the per-auth-id cap before the global ceiling.

### COST-2 · Pin the summary model — **LOW · S**
- **Where:** `src/lib/responses/review-summary.ts:28` uses bare alias `'gpt-4o-mini'` (not the pinned `gpt-4o-mini-2024-07-18`).
- **Problem:** Violates the "never bare aliases" rule (tech-stack) — silent-regression / silent-reprice risk if OpenAI repoints the alias. `model-pinning.test.ts` guards `generator.ts` but not this file.
- **Fix:** Use the pinned snapshot ID; extend `model-pinning.test.ts` to cover `review-summary.ts`.
- **Verify:** `pnpm test model-pinning` asserts the pinned ID here too.

### COST-3 · `LLM_CLIENT_OPTIONS` on all LLM constructors — **LOW · S (folded into PR-2)**
- **Where:** `review-summary.ts:38,44`, `moderate.ts:19`.
- **Problem:** Missing bounded options → inherits SDK's silent 2× internal retries (stacks billed retries under BullMQ attempts).
- **Fix:** Pass the shared `LLM_CLIENT_OPTIONS` (see PR-2).

### COST-4 · Reconcile stranded reservations on finalize failure — **LOW · M**
- **Where:** `onFinalizeError: 'log-and-return-value'` (`generator.ts:180`, `cost-guard.ts:70-80`).
- **Problem:** On a post-LLM Redis flake, the 15¢ pessimistic reserve (vs actual ~1–3¢) stays counted against the daily budget until the 24h TTL — can prematurely trip a near-limit business.
- **Fix:** A lightweight reconciliation poller, or a deferred `finalizeCost` retry via the outbox, to release the over-reservation promptly. (Keep the draft-preserving behavior; just don't strand the reserve.)
- **Verify:** Simulate a finalize failure; confirm the reservation is released well before TTL.

### COST-5 · Record moderation spend in `api_costs` — **LOW · S**
- **Where:** `moderate.ts:49` (`omni-moderation-latest` on every generation when `OPENAI_MODERATION_ENABLED=true`) — no `recordApiCost` row.
- **Problem:** $0 today (OpenAI moderation is free), but if that changes the cost is invisible to `margin-service`.
- **Fix:** Write a (currently $0) `api_costs` row so the accounting line exists ahead of any pricing change.

### COST-6 · Margin-threshold cron alert — **LOW · M**
- **Where:** `margin-service.ts` thresholds exist (account 25%/40%, platform <70%/<60% gross margin) but require an admin to open the report.
- **Fix:** Add an `api_costs`-based cron check that pages (Sentry/Discord, reusing the existing health-alert sink) when platform gross margin drops below 60%.
- **Verify:** Force a low-margin fixture; confirm an alert fires.

### COST-7 · Paginate `getMarginReport` — **LOW · S**
- **Where:** `margin-service.ts:219-221` fetches all active/past_due/trialing accounts then sorts in-process (self-noted).
- **Problem:** Query cost (not LLM cost) grows linearly past ~1k accounts.
- **Fix:** Push sort/limit into SQL; paginate.

---

## 6. Security — 8.5 → 9.5

**Already strong:** Webhook signature-verify-first holds for all 5 providers (Zernio verifies HMAC before even `JSON.parse`; `timingSafeEqual` with length guards; replay-resistant via `inbound_events … UNIQUE` + `ON CONFLICT DO NOTHING`). Moderation absolute veto on 3 independent paths. No unapproved posting (`postReply` has 2 callers, both worker-side downstream of all gates; kill-switch downgrades auto-policy rows *before* any external call — invariant #3). Approval tokens SHA-256-only + device-cookie binding + per-token rate limit + double-submit CSRF + advisory-lock TOCTOU safety. Service key confined to server. **Prior audit HIGH-1/2/3 all resolved** (`sales_partner` cross-tenant removed via migration 053; same-origin added; runtime CVEs patched).

> Theme: the live posture is strong. The MED items below are about making the **CI guards** as robust as the code they protect — today several are regex/substring drift-detectors that a future change could evade by syntax.

### SEC-1 · `sql.unsafe(nonLiteral)` must fail the tenant-scope audit — **MED · M**
- **Where:** `scripts/ci/tenant-scope-audit.ts:843-884` — when `sql.unsafe(...)` receives a helper-fn result or array index (not a literal/named const), `extractUnsafeSqlTemplates` yields no SQL text, so the query is **never checked** for tenant scope.
- **Problem:** This is the sanctioned raw-SQL path where injection/scope risk concentrates. The 3 current sites (`admin/notifications/route.ts:137-138`, `business-detail/update.ts:82`) are admin-only with positional params + column allowlists (safe today) — the risk is future drift landing unaudited.
- **Fix:** Make the audit **fail** (not silently skip) on an unresolvable `sql.unsafe(...)` arg, forcing such queries onto an explicit allowlist.
- **Verify:** Add a fixture with a non-literal `sql.unsafe` arg; confirm `pnpm ci:tenant-scope` fails.

### SEC-2 · AST-based `process.env` audit (#13 / #14 robustness) — **MED · M**
- **Where:** `scripts/ci/static-policy-audit.ts:62` (NEXT_PUBLIC allowlist matches **dot-access only**); `:63-65,232-243` (`auto_approval_policies` check is file-local regex, `'use client'`-only).
- **Problem:** `process.env['NEXT_PUBLIC_SECRET_FLAG']` (bracket/computed) bypasses invariant #13's guard; the table-access check (#14) doesn't follow a browser-Supabase helper through an import.
- **Fix:** Make the `process.env` checks AST-based (reuse the `process-env-audit.ts` TS-compiler walker) so bracket/computed access is caught. Add a `server-only` import to browser-reachable Supabase helpers as a runtime backstop for #14.
- **Verify:** Fixtures using bracket-notation env access and an imported browser-Supabase helper both fail `pnpm ci:static-policy`.

### SEC-3 · Remove webhook mock-mode fail-open in prod — **MED · S**
- **Where:** `worker/ingress/resend.ts:31-39`, `worker/ingress/twilio-verify.ts:29-36` — when the signing secret is unset **and** `MOCK_EXTERNAL_APIS==='true'`, signature verification returns `true`.
- **Problem:** A single prod misconfig of that flag silently disables signature verification for Resend + Twilio. (Stripe/Zernio/Telegram fail closed unconditionally — make these match.)
- **Fix:** Gate the mock bypass behind `NODE_ENV !== 'production'` **in addition to** `MOCK_EXTERNAL_APIS`, or remove it entirely and use a test-only signing secret.
- **Verify:** With `NODE_ENV=production` + `MOCK_EXTERNAL_APIS=true`, an unsigned Resend/Twilio payload is rejected.

### SEC-4 · Admin-AAL2 audit should be call-graph-based — **MED · M**
- **Where:** `scripts/ci/admin-aal2-audit.ts:54` — substring-presence test.
- **Problem:** A route can `import`/mention `requireAdminWithAal2` without awaiting it (or call it after a mutation) and still pass; GET routes that mutate are uncovered. (Actual routes are correctly gated via `_shared/start.ts:46` — the guard proves reference, not enforcement.)
- **Fix:** Walk the route's AST to confirm `requireAdminWithAal2` is **awaited before** any DB mutation; include mutating GET handlers.
- **Verify:** A fixture importing-but-not-awaiting the guard fails `pnpm ci:admin-aal2`.

### SEC-5 · Trust only the edge-set forwarded IP header — **LOW · S**
- **Where:** `src/lib/shared/request-ip.ts`, `worker/ingress/rate-limit.ts:16-23` (key off leftmost `x-forwarded-for`).
- **Problem:** Spoofable unless a trusted edge overwrites it. Impact is low (signature-verify is the real webhook gate), but it weakens IP-keyed rate limits.
- **Fix:** Read the right-most/trusted hop (or the platform's verified client-IP header) rather than the client-controllable leftmost value.

### SEC-6 · Fix the Resend `Date.now()` dedup fallback — **LOW · S**
- **Where:** `worker/ingress/resend.ts:198` — falls back to `resend-${Date.now()}` when `svix-id` is absent.
- **Problem:** Defeats idempotency for header-less (but signature-valid) payloads → could double-process on a buggy retry. (Post-verification, so not forgeable.)
- **Fix:** Reject header-less payloads (no stable dedup key) rather than minting a time-based one.
- **Verify:** A header-less payload is rejected; a normal one dedups on replay.

### SEC-7 · Track dev-only `undici` CVEs — **LOW · S**
- **Where:** 5 `pnpm audit` highs, all `undici` transitive via `jsdom`/`vitest` (test-only, not shipped runtime). Prior runtime advisories already fixed (Next 14.2→16.2.6, Fastify 5.8.4→5.8.5, uuid→14, postcss→8.5.15).
- **Fix:** Bump `jsdom`/`vitest` when upstream clears the advisory; no runtime exposure, low urgency.

---

## Cross-cutting theme — harden "folklore invariants" into robust CI

The strongest recurring finding across the security and production audits: the **enforcement philosophy is excellent (8 bespoke CI gates block every PR), but several gates are regex/substring drift-detectors a future change can evade by syntax.** Converting these to AST/call-graph checks is the highest-leverage way to make the documented invariants *airtight* rather than *review-dependent*:

- **SEC-1** — `sql.unsafe(nonLiteral)` should fail, not skip (tenant-scope).
- **SEC-2** — AST-based `process.env` (invariants #13/#14).
- **SEC-4** — call-graph admin-AAL2.
- **New CI checks to add** (one-line greps mirroring existing audits): ban `queue.add`/`new Queue().add` outside `OutboxPoller.ts` (protects invariant #2's silent-data-loss stakes); flag third-party SDK construction in `worker/`+`src/lib/` without a bounded timeout option (would have caught PR-2 and the historical SerpAPI starvation bug).

---

## Appendix — objective metrics (independent static analysis)

| Signal | Value | Read |
|---|---|---|
| Circular dependencies | 0 | Excellent |
| Architecture-boundary violations | 0 | Excellent |
| Unused dependencies / unresolved imports | 0 / 0 | Clean |
| Avg maintainability | 92.5 / 100 | Excellent |
| Avg cyclomatic / p90 | 3.2 / 8 | Low (good) |
| Duplication | 1.8% (45 clone groups) | Low |
| Dead code | 1 file, 0 exports | Near-zero |
| Functions over complexity threshold | 152 / 3,425 (4.4%), 28 critical | Realistic tail (admin/onboarding/scripts) |
| Type-safety escape hatches | 2 real `any` (108k LOC), 0 `@ts-ignore` | Top-decile |
| TS config | `strict` + `noUncheckedIndexedAccess` | Stronger than default |
| Tests | 594 files; every mandated critical path covered | Heavy investment |
| TODO/FIXME/HACK | 2 total | Exceptional |

**Worst-complexity functions** (for CLEAN-1/CLEAN-4): `scripts/redis.ts` main (cyc=49 — dev script, low priority), `api/admin/overview/route.ts` GET (cyc=32, crap=1056 — production), `cost-report-service.ts:117` getCostReport (384 LOC), `reconcileAccount` (353 LOC), `dashboard/connect/page.tsx` ConnectPageInner (cyc=25, cog=35).

---

*Generated from a 5-agent parallel code audit + independent `fallow` static analysis on 2026-06-25. Scores are the reviewer's calibration of the specialist findings. Update the checklist boxes as fixes land; re-run `fallow health --hotspots` and the relevant `pnpm ci:*` gate to confirm each score moves.*
