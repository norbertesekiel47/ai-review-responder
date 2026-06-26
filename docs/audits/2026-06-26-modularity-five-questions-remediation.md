# Modularity Audit (the Five Questions) + Stage 1–6 Remediation — Retrospective

**Date:** 2026-06-26 · **Status:** Campaign COMPLETE (Stages 1–6 merged to `main`) · **PRs:** #376–#400

> This is the canonical record of the **five-questions modularity audit** the owner
> requested before adding more features, and the six-stage remediation that followed.
> It is distinct from [`2026-06-25-codebase-audit-and-remediation.md`](2026-06-25-codebase-audit-and-remediation.md),
> which is a broader six-*dimension* audit (production / modularity / clean / scalable /
> cost / security). This doc tracks ONLY the five modularity questions and the
> Stage 1–6 work that answered them.

---

## 0. The ask

> "Before I proceed with more features, I want a very heavy audit of the entire code
> base to make sure it's clean and the modularity aspect is optimized. The codebase
> should be able to answer **yes** to the following questions — if not, give me a
> report of why."

The five questions:

1. **Can I modify a feature without touching unrelated files?**
2. **Can I test a module in isolation?**
3. **Does each module have a single responsibility?**
4. **Are dependencies explicit?**
5. **Can I replace one component without rewriting others?**

The audit was **read-only** (no code changes). Acting on it came later, and only after
the owner signed off on a plan (see §3).

---

## 1. Audit findings — the baseline (2026-06-24)

**Method:** `fallow` static analysis (cycles, duplication, complexity) + three targeted
agent investigations + manual hotspot verification over `src/` (650 files) + `worker/`
(139) + ~567 test files (~216k LOC).

**Objective health was already strong — this was *targeted hardening*, not a rescue:**

- **Circular dependencies: 0** — the single strongest modularity signal; nothing tangled.
- **Duplication: 1.9%** (below the 2% "healthy" line).
- **Maintainability: 92.5/100** — 3,379 functions; only 2 rated "high" complexity.
- **Dead code:** ~1 stray CSS file, 1 unused type export, 1 duplicate `flagOff` — essentially clean.

### Per-question verdict (baseline grades)

| # | Question | Grade | The weak spot |
|---|----------|:---:|---|
| 1 | Modify without touching unrelated files? | **B+** | Response-status literals hardcoded in **30 files** of inline SQL (`status IN ('approved',…)`) bypassing the existing `shared/response-status.ts` (only 4 importers). Adding a status was a grep-and-edit. |
| 2 | Test a module in isolation? | **A−** | The strongest dimension — no global live boot, ~97% pure/mocked tests, worker handlers decoupled from BullMQ. Watch-out: integration suites skip silently without `TEST_DATABASE_POOL_URL`. |
| 3 | Single responsibility? | **B+** | `auth/callback/route.ts` at **cognitive complexity 44** — a route mixing Supabase client construction, two auth-exchange paths, role lookup, and five redirect branches with a cookie-copy loop repeated 5×. |
| 4 | Dependencies explicit? | **C+** | **The weakest.** Three issues: `sql`/`supabaseServer` eager singletons imported by **~217 files**; **~1,668 raw `process.env.X` reads across 361 files** (no typed/validated owner); feature-flag reads leaking inline into route handlers. |
| 5 | Replace a component? | **B−** | Two missing seams. **Publishing hard-wired to Zernio** (`zernioClient` imported directly across ~6 worker files; the parked direct-GBP path would be a rewrite). LLM-provider fallback inline `callOpenAI`/`callAnthropic`, not an interface. |

**Bottom line:** genuinely clean codebase; the work before more features was Q4
(dependencies) and the two Q5 seams.

### The audit's prioritized "Recommended" list

- **Tier 1 (pays for itself immediately):** (1) extract `resolveCallbackDestination()` from the auth-callback hotspot; (2) adopt `response-status.ts` everywhere + a CI guard.
- **Tier 2 (the C+ on dependencies):** (3) one typed, validated config module owning `process.env`; (4) route all feature flags through `<feature>/flags.ts` + a CI ban on inline reads.
- **Tier 3 (strategic):** (5) a `ReviewPublisher` interface with Zernio as the first adapter.
- **Hygiene:** delete the unused CSS + type, dedupe `flagOff`, clean stale suppressions.

---

## 2. From plan to campaign — the process

The owner chose the **thorough** variant on three fronts (build the publisher seam now;
full env→config migration; full 16/20-flag sweep) and deliberately kept the DB-client
singleton **out of scope**.

The "Recommended" list was hardened into an implementation plan via **`/grill-me-codex`**:
Act 1 = the owner is interrogated one decision at a time until the decision tree is
locked; Act 2 = a *different* model (OpenAI Codex) adversarially attacks the locked plan
across multiple rounds until APPROVED, with Claude as final arbiter. The plan reached
**VERDICT: APPROVED** after 4 rounds (Codex caught 4 CI/production-breaking issues a naive
plan missed — e.g. a response-status CI guard that would break `ON CONFLICT` byte-for-byte
matching; eager `z.parse` at import breaking previews/tests; a worker dotenv-ordering hole).

**Per-batch pipeline** (every stage / PR followed this exactly):

> sibling worktree → recon → TDD → **independently re-run the full verify gate**
> (lint · typecheck · test · build · `ci:tenant-scope` · `ci:rls-audit` ·
> `ci:static-policy` · `ci:config-coverage` · `ci:process-env` · `ci:fallow`) →
> **Codex correctness review** (read-only, multi-round, Claude final arbiter) →
> **thermo-nuclear maintainability review** → PR → CI green incl. **React Doctor 100/100**
> → **staging ride** (worker-touching batches: the Railway worker must boot clean) →
> merge → reset `staging` to `main`.

---

## 3. The remediation — Stage by Stage

15 PRs (#376–#398) across six stages, every one **behavior-preserving** (changing *where*
config/flags are read and *adding two seams/guards*, never runtime behavior).

### Stage 1 — Tier-1 quick wins (#376) — UI-only

- **Extracted `resolveCallbackDestination({role, rawNext, flow})`** out of the cognitive-44
  `auth/callback/route.ts` into the pure, unit-tested `shared/auth-flow.ts`. The `next`
  sanitization (`startsWith('/') && !startsWith('//')`) + role/path allowlists live
  *inside* the resolver (one sanitization site); the route keeps only Supabase I/O and
  dispatches on a discriminated result. Decision-table tests cover all branches + hostile
  `next` values. → killed the worst Q3 hotspot **and** a thin-route violation.
- **Adopted `shared/response-status.ts` as the single source** for response-status values;
  raw literals replaced; an **AST-based CI guard** (consistent with the existing
  tenant-scope/static-policy audits, not grep) flags raw status literals in TS, with
  per-line `// status-audit-ignore` pragmas for the SQL-predicate exceptions that must stay
  byte-for-byte stable (migrations, index predicates, `ON CONFLICT … WHERE`). → "add a
  status" is now a one-file change (Q1).

### Stage 2 — typed config foundation (#377)

- **`src/lib/config/{client,server,worker}.ts`** — lazy + memoized `getServerConfig()` /
  `getWorkerConfig()` over Zod schemas. **Root schemas are shape-only** (every field
  optional) so `getServerConfig()` *never throws* on a missing var — required-ness lives in
  **lane-scoped boot asserts** (`assertCoreAppConfig()` via Next `instrumentation.register()`;
  `assertWorkerConfig()` at worker boot; subsystem asserts like `getStripeConfig()` at each
  subsystem's entry). This was Codex's key correction: fail-fast at **boot**, not at import,
  and lane-aware, so a UI-only preview never dies on an absent worker/Stripe secret.
- CI guards: a **config-coverage audit** (every required var belongs to exactly one lane's
  assert), a **`process-env` baseline guard**, and a **no-secret `next build` canary**.

### Stage 3 — the env→config migration (#378–#391)

Migrated the ~1,668 raw `process.env.X` reads onto the typed accessors, **batched by area**
to bound review size: email/Resend pilot (#378) · Stripe/payments + the `getServerConfig`
lane-safety fix (#379) · worker-pollers (#381) · worker-jobs (#382) · worker-ingress
webhook secrets (#383) · `src/lib` server secrets + the foundational allowlist (#384) ·
SerpAPI+Redis (#386) · zernio transport (#387) · notification-channel send (#388) ·
`TRIAL_PERIOD_DAYS` (#389) · **`costs/tracker.ts` cost-guard — migrated byte-for-byte, full
Codex, the spend-safety invariant** (#390) · out-of-guard `src/app` route reads (#391).

**Result:** every non-flag config read flows through `getServerConfig()` / `getWorkerConfig()`;
import-time client/singleton constructors are **allowlisted** (`db/server.ts`,
`db/redis-cache.ts`, `cost-report-service.ts`, `shared/logger.ts`, `price-tier-map.ts`,
`demos/fetch-reviews.ts`). The `process-env` audit baseline went **100 → 14** — its genuine
**non-flag floor** (`NEXT_PUBLIC_APP_URL` literals that must stay build-inlined + DB/sentry/
redis-connection infra constructors).

### Stage 4 — the feature-flag sweep (#392–#396)

- **`readFlag(name)` primitive** (`src/lib/config/flags.ts`) — runtime-agnostic
  (`process.env[name] === 'true'`, **not** memoized — a test that sets the env reads live),
  a *peer* of the config accessors, deliberately NOT routed through `getServerConfig` (so
  worker-owned flags don't assume Next-server env). Owns the `VERCEL_TARGET_ENV` preview/
  staging/prod resolution in one place (#392).
- **All 20 flags** (16 `*_ENABLED` + 4 `*_DISABLED`) routed through a per-feature
  `<feature>/flags.ts` accessor → `readFlag`: auth cluster (#393), channels/publishing/poller
  (#394), locations/payments/onboarding/moderation (#395).
- **CI ban** (#396): `ci:static-policy` gained an `inline-feature-flag` rule that bans inline
  `process.env.*_ENABLED`/`*_DISABLED` outside the `flags.ts` modules (matches dot AND
  string-bracket notation). → single owner per flag, enforced by CI (Q4).

### Stage 5 — the `ReviewPublisher` seam (#397) — the last Q5 gap

**Pure refactor, zero behavior change** (guarded by 195 existing publisher/publishing tests
+ 13 new adapter tests + 1 new concurrency test).

- **`src/lib/publishing/review-publisher.ts`** — `ReviewPublisher` interface
  (`resolveTarget` + `publishReply`/`deleteReply`/`findReply`); a neutral `ReviewRef`
  (app-owned `responseId`/`reviewId`/`businessId`) nested **separately** from a provider
  `ReviewLocator` (`accountId`/`locationId`/`providerReviewId`) so the adapter's transport
  methods get a coords-only object — **no app id leaks into the adapter** (the fix from
  Codex round 1); `getReviewPublisher()` lazy-singleton factory is the adapter-selection seam.
- **`zernio-review-publisher.ts`** — first adapter; DELEGATES to the existing `zernioClient`
  + `lookupZernioReviewId` + the Redis page-cache (deliberate: keeps the worker's existing
  test mocks valid → the strongest zero-behavior-change guard). Owns the active-connection
  SELECT (moved out of `ResponsePublisherWorker`), review-id resolution, and the verify-walk
  page-cache bounding (deduped out of `verify-posted` + both `verify409*`).
- **6 call-sites switched** through the seam: `ResponsePublisherWorker`, `review-lookup`
  (`resolvePublishTarget` consolidates the no_connection→park / review_not_found→exception /
  transient→retry dispositions that were split across files), `post-reply`, `verify-posted`,
  `verify409AndDispose`/`verify409InTx`, `edit-publish`. The zernio *ingest* workers READ
  reviews and are NOT part of this seam.
- **Deferred (documented residual):** the worker keeps catching the existing Zernio error
  *classes* + all DB disposition — neutralizing the error taxonomy waits for a real GBP
  adapter to force (and validate) its shape (a 1-adapter interface can be subtly wrong-shaped
  until a second adapter exists).
- **Reviews:** Codex APPROVED after 2 rounds; thermo-nuclear passed (`ResponsePublisherWorker`
  and `publisher-error-handlers.ts` both *shrank*; page-cache duplication removed).

### Stage 6 — hygiene (#398)

Re-verified all four audit hygiene items; only one was real. **Single-sourced `flagOff()`**
(byte-identical channel-agnostic 404) into `src/app/api/admin/channels/_shared/flag-off.ts`;
telegram + whatsapp `_shared.ts` re-export it. The other three were fallow false-positives /
already-resolved and **intentionally left untouched** (documented): `warm-editorial.css` is
referenced by 6 live dashboard-redesign mockups; `DrawerState` is actively used (prior team
review confirmed the fallow flag is a false positive); the `AutoPostNoticeWorker`
fallow-ignore comment is already well-formed.

---

## 4. Before → after

| # | Question | Audit | Now | What moved it |
|---|----------|:---:|:---:|---|
| 1 | Modify without touching unrelated files? | B+ | **A−** | `response-status.ts` single source + AST CI guard (the 30-file amplifier is gone). |
| 2 | Test a module in isolation? | A− | **A−** | Held; every new unit shipped as a pure, independently-tested module. |
| 3 | Single responsibility? | B+ | **A−** | The cognitive-44 auth-callback hotspot extracted; `ResponsePublisherWorker` got smaller. |
| 4 | Dependencies explicit? | **C+** | **B+** | Typed config layer owns env (baseline 100→14, CI-guarded); all 20 flags through per-feature accessors (CI-guarded). |
| 5 | Replace a component? | B− | **A−** | The `ReviewPublisher` seam closed the highest-value gap (GBP is now a second adapter, not a rewrite). |

All five now answer a confident **yes**.

### Two deliberate residuals (scoped OUT — documented, low-priority, not blocking)

- **Q4 isn't A** — the `sql` / `supabaseServer` DB singletons are still ambient (imported by
  ~217 files). Injecting them is a 200+-file refactor, and test isolation is already achieved
  via module mocking. This is the remaining lever if Q4 → A is ever wanted.
- **Q5 isn't A** — the LLM-provider fallback stays inline `callOpenAI`/`callAnthropic`. At two
  pinned providers, an interface would be a speculative abstraction; wait for a third concrete
  use case (per the project's "don't abstract before the second use case" rule).

---

## 5. Two follow-ups from the same codebase-health arc

These weren't among the five questions but were surfaced/triggered during the work and merged
in the same session.

- **Worker transient-DB crash-net resilience (#399).** A staging boot revealed that a transient
  Postgres statement-timeout (`57014`), surfaced by postgres.js as a *connection-layer*
  `unhandledRejection` that escaped a poller's own try/catch, made the process-level crash-net
  exit the **entire worker** (24 queues + 20 loops) over one blip. Fix: the `unhandledRejection`
  handler now **recovers** from a clearly-transient DB error (explicit allowlist
  `isCrashNetRecoverableDbError`, ambiguous codes excluded) while a duration-based governor
  (`worker/transient-rejection-governor.ts`) escalates a *sustained* storm to a crash+restart;
  `uncaughtException` stays always-fatal. The classifier moved to `src/lib/db/transient-error.ts`.
  Codex APPROVED after **3 rounds** (narrowed the predicate; redesigned the governor from
  count-based to duration-based so a boot fan-out can't trip it).
- **Dependabot security patches (#400).** Lockfile-only transitive bumps: form-data 4.0.6
  (HIGH, runtime), undici 7.28.0 (HIGH, dev), esbuild 0.28.1 (LOW). Open advisories **13 → 4**.
  The remaining 4 (vite, @opentelemetry/core, @babel/core) were **deferred with reasons** —
  each is blocked by the repo's own supply-chain hardening (`minimumReleaseAge` 7-day
  quarantine + `trustPolicy: no-downgrade`) or needs a coordinated `@sentry/node` SDK bump.
  Respecting the hardening beat forcing a low-severity fix.

---

## 6. Where the artifacts live

- **This retrospective** — the canonical campaign record.
- **Per-PR detail** — `docs/progresstracking.md` (Stages 1–4 are summarized; Stages 5–6 +
  follow-ups have a full sprint entry dated 2026-06-26).
- **Current state** — `docs/currents.md` top summary (2026-06-26).
- **Root-cause notes** — `.claude/reference/lab-notes.md` (the worker-crash + pnpm-hardening notes).
- **Agent guidance** — `.claude/CLAUDE.md` (the `ReviewPublisher` seam pointer + crash-net gotcha).
- **The original audit report + the Codex-approved plan** lived in ephemeral grill-codex /
  job directories outside the repo; their substance is preserved here.

---

*None of Stages 1–6 was blocking — features could ship at the baseline. This campaign is what
keeps "yes" the answer to all five questions as the codebase grows.*
