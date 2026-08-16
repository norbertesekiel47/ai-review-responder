# Modularity Re-Audit (the Five Questions) — 2026-07-01

**Date:** 2026-07-01 · **Status:** READ-ONLY audit, no code changed · **Baseline:** the
2026-06-26 campaign ([`2026-06-26-modularity-five-questions-remediation.md`](2026-06-26-modularity-five-questions-remediation.md), PRs #376–#400)

> Re-run of the five-questions audit before the next feature wave. Scope: (a) did the
> June remediation **hold** across the ~35 commits / 259 files merged to `main` since
> (#405–#436: landing rebuild, analytics window + rating aggregate, queue-health,
> guarded polls, publisher fixes, deepening refactors #430–#432), and (b) a fresh
> full-codebase pass per question.
>
> **Method:** fallow static layer (dead code, duplication, complexity, cycles,
> boundaries) + all 8 CI audit guards executed live + five parallel agent
> investigations (one per question) + manual spot-verification of every headline
> finding against source.

---

## 0. Verdict

**All five questions still answer yes.** No regression broke a June invariant; two
small single-source regressions slipped into new client-side code; the deeper pass
surfaced one lane the June audit under-graded (fat API routes, Q3).

| # | Question | Jun 26 | Now | Answer |
|---|----------|:---:|:---:|---|
| 1 | Modify a feature without touching unrelated files? | A− | **A−** | YES-WITH-CAVEATS — CI-guarded single-sourcing held; 2 new client-side duplications + 4 pre-existing amplifiers now enumerated (§2) |
| 2 | Test a module in isolation? | A− | **A−** | YES — held and slightly improved; every new seam landed DI'd with its own unit test (§3) |
| 3 | Single responsibility per module? | A− | **B+** | YES-WITH-CAVEATS — worker/lib clean; downgrade because the deeper pass found 4 thin-route violations the June audit missed (§4) |
| 4 | Dependencies explicit? | B+ | **B+** | YES — held and trending positive; env baseline exactly 14, DB-singleton residual shrank 217→214 (§5) |
| 5 | Replace a component without rewriting others? | A− | **A−** | YES — clean pass; every post-June publisher commit respected the seam (§6) |

### Objective statics (2026-07-01 vs Jun 24 baseline)

- **Circular dependencies: 0** (held) · **Boundary violations: 0** (held)
- **Duplication: 1.42%** (was 1.9% — improved)
- **fallow health: 87.5/100, grade A** (formula v2; penalties concentrated in unit-size 10.0 + coupling 2.4)
- **CI guard layer: 8/8 pass live** — `ci:tenant-scope`, `ci:rls-audit`, `ci:analytics-events`,
  `ci:static-policy`, `ci:response-status`, `ci:admin-aal2`, `ci:config-coverage`, `ci:process-env`
- Dead code: 1 dormant-by-decision directory + 1 stray types file + 2 unused exports (§7)

---

## 1. What held (the June discipline, re-verified)

- **Response-status single source + AST guard**: passing over 687 files.
- **Typed config layer**: `ci:process-env` baseline exactly **14** — zero new raw
  `process.env` readers in 35 commits; the one new env var (`WORKER_INTERNAL_SECRET`)
  is typed in both `src/lib/config/server.ts` and `worker.ts` with rationale comments.
- **Flag discipline**: zero new flags; inline-flag CI ban unchanged; no new `NEXT_PUBLIC_*`.
- **ReviewPublisher seam**: all 6 call-sites still resolve through `getReviewPublisher()`;
  #419's Sentry surfacing was implemented *inside* the adapter
  (`src/lib/publishing/zernio-review-publisher.ts`) and re-throws unchanged — the
  textbook seam-respecting change.
- **New code raised the bar, not lowered it**: `worker/internal/queue-health.ts` is fully
  dependency-injected (secret reader + count fetcher wired at `worker/index.ts`), unit-tested,
  and single-sources queue names from `src/lib/shared/queue-names.ts`; `createGuardedPoll`
  (#434) replaced 13 loops' ad-hoc timer state with an explicit `start()/stop()` lifecycle;
  the analytics window enum has exactly one owner (`src/lib/kpi/types.ts` —
  `DASHBOARD_WINDOWS`/`resolveDashboardWindow`) consumed by toolbar, hooks, and both routes.
- **Import-time hygiene**: zero new module-level clients, timers, env-throws, or top-level
  awaits across all 126 changed non-test source files.

---

## 2. Q1 — Modify without touching unrelated files (A−, YES-WITH-CAVEATS)

### Regressions (new since 2026-06-26)

| Sev | Finding | Where |
|---|---|---|
| MED | Landing rebuild re-implements the marketing nav links as a **third copy** instead of deriving from `NAV_LINKS` | `src/components/sections/landing/LandingExperience.tsx:161-163` vs owner `src/components/ui/SiteNav.tsx:17-19` (2nd copy: `SiteFooter.tsx:24-26`). Renaming/adding a marketing page now touches 3 files. |
| MED | `RecentSentimentMix` re-encodes the star→sentiment rule (≥4 / ==3 / ≤2) client-side instead of importing from the owner | `src/components/dashboard/kpi/RecentSentimentMix.tsx:20-23` vs owner `classifySentiment` (`src/lib/reviews/sentiment.ts:31`); same thresholds also in `RecentRatingBreakdown.tsx:14-17` — three encodings of one business fact. |
| LOW | Landing 820px mobile cutoff lives in both JS and CSS with no single owner | `LandingExperience.tsx:81` vs `landing-experience.css:241` (comment-acknowledged only). |
| LOW | Admin jobs page hardcodes the BullMQ job-state names that `QUEUE_HEALTH_JOB_STATES` declares itself sole owner of | `src/app/admin/jobs/page.tsx:159-179` vs `worker/internal/queue-health.ts:27-34` — move the list beside `queue-names.ts` in `src/lib/shared/` so the UI can import it. |

### Pre-existing amplifiers (enumerated for the first time)

| Sev | Finding | Where |
|---|---|---|
| MED | Adding a KPI writes the same SQL **twice**: `getLocationKpiSummary` / `getAccountKpiSummary` are near-copies of five queries differing only in the scope join | `src/lib/kpi/service.ts:81-168` vs `:169-260` |
| MED | Channel set re-enumerated instead of derived from `CHANNEL_IDS` (whose doc comment claims "every enumeration derives from this") | `src/lib/channels/override.ts:21`, `src/lib/notifications/channels/enrollment-reducer.ts:24`, `settings/channels/ChannelsClient.tsx:8`, + `'telegram'\|'whatsapp'` inlined in ~6 files despite `MobileChannel` existing |
| MED | 8 near-identical `channel_enrollments` UPDATE blocks (4 failure kinds × 2 location variants); each new channel copies ~4 more | `worker/jobs/notification/dispatch.ts:84-198` |
| LOW-MED | `reviews.status` has **no authoritative constant module** — `'deleted'`/`'new'` raw in 14+ sites; exactly the gap `response-status.ts` + AST guard closed for responses, un-closed for reviews | `src/lib/reviews/process-review.ts:199-252`, `src/lib/kpi/service.ts` ×9, `src/lib/dashboard/aggregate-service.ts:322,335` |
| LOW | ~7 outbox writers use raw topic literals; no CI guard for topic names | `process-review.ts:356`, `create-business.ts:313`, `EngagementMonitorPoller.ts:173,183`, `DrainOwnerConnectWorker.ts:60-73`, `archive-location-tx.ts:459`, `approval/correlation.ts:35`, `teardown-outbox.ts:27-34` |
| LOW | Public pricing page hardcodes display prices duplicating `TIER_CONFIG` baseCents; annual figures exist only in the page | `src/app/(public)/pricing/PricingContent.tsx:34-94` vs `src/lib/accounts/tier-config.ts:58-83` |
| LOW | Value-summary wire shape declared inline twice + a structurally-typed local copy | `src/lib/dashboard/types.ts:73-78,246-251`, `ValueKpiGrid.tsx:9-14` |
| LOW | Dangling doc reference (repo rule: dangling refs are bugs) | `src/lib/notifications/channels/types.ts:8` cites `docs/adding-communication-channels.md`, which no longer exists |

### Scenario traces

- **Add a notification channel:** ~11–13 files; ≥4 touches exist only because of the
  duplication above (re-declared unions, channel→flag map in `eligibility.ts:46-47`,
  copied UPDATE blocks, `mask-handle.ts`). ~⅓ of the touch count is amplification.
- **Add a dashboard KPI:** ~4 files, all genuinely related; only defect is the doubled SQL.

---

## 3. Q2 — Test in isolation (A−, YES)

- Every substantive seam added since June has a dedicated unit test:
  `worker/internal/__tests__/queue-health.test.ts` (+7-case degradation suite on the
  consumer route), `worker/background/__tests__/guarded-poll.test.ts`,
  `stripe-activation-enqueue.test.ts` (backfill resume through real handlers),
  `rating-breakdown.test.ts` + KPI service/route/toolbar tests.
- 607 test files repo-wide; since 6/26: 87 test files touched vs 128 source files (~0.68).
  Every net-new *logic* module is unit-tested; only presentation components are not.

| Sev | Finding | Status |
|---|---|---|
| MED | DB-gated integration suites still **skip silently** (`describe.skip`, no warn) without `TEST_DATABASE_POOL_URL` | PRE-EXISTING (flagged in June, unchanged) — e.g. `src/__tests__/tenant-isolation.test.ts:7-9` |
| LOW | Rebuilt landing UI (`LandingExperience.tsx`, `be-ui-tilt-card.tsx`) is untested imperative rAF choreography | NEW surface, acceptable for marketing UI — note only |
| LOW | `src/hooks/useSyncPendingCount.ts` testable only via 4 parent component renders | PRE-EXISTING |

---

## 4. Q3 — Single responsibility (B+, YES-WITH-CAVEATS)

Worker and lib modules genuinely hold single responsibilities: both publisher hotspots
(`postReplyAndHandleTerminalOutcomes`, `handle409Disposition`) are documented
outcome-table policy modules whose complexity is the distinct-outcome vocabulary
(invariant #12 shape); `onboardBusinessAsAdmin` legitimately owns its saga +
compensations; no god module exists (closest watch item:
`src/lib/shared/job-outbox-helpers.ts`, 603 lines / 12 `enqueue*` fns across 7 domains —
the offboarding cluster could migrate out before it grows). `LandingExperience.tsx`
(297 lines, NEW) is right-sized for a self-contained marketing page (CSS extracted,
TiltCard imported).

**The downgrade driver: four API routes violate repworth.md's "parse input, call one
module function, return output" — all PRE-EXISTING (missed by the June pass, which
only extracted auth-callback):**

| Sev | Route | What it inlines |
|---|---|---|
| **HIGH** | `src/app/api/auth/finish-signup/route.ts:190-227` (221 lines) | A ~38-line `channel_enrollments` INSERT block that (a) **duplicates the post-OTP INSERT in `/api/auth/verify-otp`** — one durable fact (email-channel enrollment) owned by two routes, and (b) carries a fallback branch whose own comment admits its `ON CONFLICT` references a **constraint deleted in migration 034** and would error if it ever fired. |
| MED-HIGH | `src/app/api/admin/overview/route.ts:70-292` (223 lines) | A full report-builder: 7 inline SQL queries + churn CTE + trend derivation + inline email-health thresholds. The same concern was extracted for costs into `cost-report-service.ts`; overview never was → `src/lib/admin/overview-service.ts`. |
| MED | `src/app/api/auth/signup/route.ts:93-183` (206 lines) | ~90 lines of Supabase identity-provisioning (advisory-lock pre-check, timestamp-recovery query, anti-enumeration disambiguation, ~35-line error triage, compensating deleteUser) — an unextracted `provisionAuthUser` module. |
| MED-LOW | `src/app/api/onboarding/select-plan/route.ts:186-292` (271 lines) | Lock-then-read tier-snapshot transaction + trial-eligibility policy inline (guard stack itself is legitimate). |

Secondary (LOW, pre-existing): `getCostReport` copy-pastes the 90-day rollup boundary
predicate **8×** across hand-duplicated queries (`src/lib/admin/cost-report-service.ts:117-428`
— DRY defect, not SRP); `handle409Disposition` repeats a candidate-lost UPDATE 3× inline;
`onboardBusinessAsAdmin` duplicates its 4-DELETE rollback verbatim (`:322-327`, `:419-424`);
`ConnectPageInner`'s nested-ternary dispatch inflates one otherwise-cohesive component.

---

## 5. Q4 — Dependencies explicit (B+, YES)

Held and trending positive — see §1 for the guard evidence. Deltas:

- **DB-singleton residual (accepted in June): shrank.** 214 non-test importers of
  `db/server` vs ~217 at baseline.
- The two significant new dependencies were introduced the right way:
  `WORKER_INTERNAL_SECRET` typed in both config lanes; queue-health handler DI'd;
  guarded-poll state closure-encapsulated with explicit lifecycle ownership in
  `worker/index.ts`.

| Sev | Finding | Status |
|---|---|---|
| LOW | `ci:process-env` scans only `src/lib` + `worker`; `src/app/**` / `src/components/**` unguarded (today's reads there are all exempt/inlined literals) | PRE-EXISTING |
| LOW | Pre-push hook (`lefthook.yml`) omits `ci:process-env`, `ci:response-status`, `ci:admin-aal2`, `ci:config-coverage` while running the equally-cheap `ci:static-policy` — violations surface only at CI, not locally | PRE-EXISTING |
| LOW | `WORKER_INTERNAL_SECRET` has no prod boot assert; misconfig degrades to `queueHealth:{unavailable:true}` + warn | DELIBERATE, documented (`queue-health.ts:9-11`) — decide if the degrade posture is wanted long-term |
| LOW | 4 bespoke pollers retain module-level `let timer/isPolling` outside `createGuardedPoll` | PRE-EXISTING, documented as retained (`guarded-poll.ts:23-26`) |

---

## 6. Q5 — Replace a component (A−, YES)

Clean pass; zero regressions:

- **ReviewPublisher**: all 6 call-sites through `getReviewPublisher()`; #416–#419 all
  seam-respecting. Documented residual unchanged: worker still imports Zernio error
  *classes* (6 files) — plus one adjacent item the residual wording doesn't cover:
  `canonicalizeReplyText` imported from `src/lib/zernio/canonicalize-reply` by
  `verify-posted.ts:23` and `publisher-error-handlers.ts:27`. Same fate — fold into the
  adapter when a second adapter forces the error-taxonomy shape.
- **ReviewSource**: prompt builder touches only source-agnostic `NormalizedReview` fields;
  zero zernio/serpapi references in `src/lib/responses/`. Known GBP-readiness gap
  confirmed: ingest parses then **discards** the Google-native `review.name`
  (`src/lib/reviews/zernio-normalize.ts`) — already designed-for in
  `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md:239-241`.
- **Stripe**: single construction site `stripe-client.ts:35`. **Redis**: construction
  confined to `db/redis-cache.ts` (Upstash) + `worker/redis-connection.ts` (queue); the
  one outlier (`worker/index.ts:356` readiness probe) reuses `getRedisOptions()` — wiring,
  not duplication.
- **Channels**: registry seam intact; a 4th channel is additive but touches ~5 files
  instead of 2 due to the Q1 amplifiers (finding table §2).

---

## 7. Hygiene & tooling notes

- **`src/components/sections/landing-legacy/`** (7 components incl. `VideoHero.tsx`): zero
  importers. This was a **deliberate retention** ("keep old landing dormant for recovery")
  when the rebuild shipped. Now that #436 promoted the new landing to production and it has
  baked, decide: delete (git history is the recovery) or add `fallow-ignore-file` with an
  expiry note. Recommend delete.
- **`worker/jobs/publisher/types.ts`**: unreferenced — likely stranded by the Stage-5 seam
  refactor. Verify + delete.
- **Unused exports**: `SPRING_MOUSE`, `useHoverCapable` (`src/components/ui/be-ui-tilt-card.tsx:23,29`);
  `DrawerState` re-flag is the **known false positive** (team-reviewed 6/26, keep).
- **fallow artifact, not a real issue**: "80 stale suppressions" = the parser tokenizing
  the prose after `// fallow-ignore-next-line complexity — <explanation>` in 3
  auto-post-notice files as issue-kind words. Cosmetic fix: move the rationale to its own
  comment line above the pragma.
- `warm-editorial.css` unused-flag remains the documented false positive (referenced by
  6 live mockups). _(Deleted 2026-08-16 with `docs/design/dashboard-redesign/`; tag
  `design-mockups-2026-06`.)_

---

## 8. Prioritized recommendations

**Tier 1 — real defects, small fixes:**
1. Extract the email-channel-enrollment INSERT into one shared module used by both
   `finish-signup` and `verify-otp`; **delete the dead pre-migration-034 fallback branch**
   (it can only ever error). (Q3-HIGH, also a Q1 single-owner violation)
2. Fix the two new client regressions: derive landing nav from `NAV_LINKS` (export it
   from `SiteNav` or a shared module) and sentiment buckets from
   `classifySentiment`/a shared threshold constant. (Q1-MED ×2)

**Tier 2 — the route lane (the B+ on Q3):**
3. Extract `src/lib/admin/overview-service.ts` (mirror of `cost-report-service.ts`).
4. Extract `provisionAuthUser` from the signup route; tier-snapshot + trial-eligibility
   from select-plan into the payments/billing modules.

**Tier 3 — amplifier pay-down (do before the features that hit them):**
5. Before any KPI work: collapse the doubled per-scope SQL in `kpi/service.ts`
   (scope-join parameterization or sql-fragment composition).
6. Before a 4th channel: derive all channel unions from `CHANNEL_IDS`, extract the
   repeated `dispatch.ts` UPDATE block, single-source the channel→flag map.
7. `reviews/status.ts` constant module + extend the AST status guard to reviews;
   optionally a topic-name guard for outbox writers.

**Tier 4 — hygiene:** delete `landing-legacy/` + `worker/jobs/publisher/types.ts` + the
2 tilt-card exports; single-source pricing display values from `TIER_CONFIG`; mirror the
4 missing audits into the pre-push hook; add a one-line stderr warn to the
`TEST_DATABASE_POOL_URL` skip gate; fix the dangling channels doc ref; reformat the 3
fallow pragma comments.

---

*Nothing here blocks feature work. Tier 1 is an afternoon; Tiers 2–3 are targeted,
same-shape extractions the codebase has done before (auth-callback, cost-report-service),
best scheduled just-in-time before the feature that touches each area.*
