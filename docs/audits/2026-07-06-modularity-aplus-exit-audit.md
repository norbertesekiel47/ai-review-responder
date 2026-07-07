# Modularity A+ Campaign — Exit Re-Audit + Retrospective (the Five Questions)

**Date:** 2026-07-06 · **Status:** READ-ONLY audit + retrospective, no product code changed · **Scope:** the whole `main` tree at `3070f0e5` after the campaign's final PR (#456).
**Inputs:** [`2026-07-01-modularity-five-questions-reaudit.md`](2026-07-01-modularity-five-questions-reaudit.md) (the findings the campaign set out to close), the campaign design [`spec §2.1/§2.2`](../superpowers/specs/2026-07-01-modularity-aplus-campaign-design.md), and the Stage 2–4 plan.

> **Method (same as 2026-07-01):** fallow static layer (health, duplication, cycles, boundaries) + all 12 CI audit guards executed live + **five independent parallel agent investigations** (one per question) + adversarial spot-verification of every headline claim against source. This is the CAMPAIGN EXIT audit — the bar the owner set is **A or better on all five, zero unaccepted caveats**, plus two grep-proofs (no domain-module DB-singleton import; no LLM generation/insights call outside `runLlmTask`).

---

## 0. Verdict — **PASS. Campaign meets its exit bar.**

**All five questions answer A or better with zero unaccepted caveats.** Both June-accepted residuals are closed — the ambient DB singleton **permanently and structurally** (a strict, registration-derived, unit-tested, CI-wired guard), the inline LLM provider calls via the `runLlmTask` seam.

| # | Question | Jun 26 | Jul 01 | **Exit (Jul 06)** | Answer |
|---|----------|:---:|:---:|:---:|---|
| 1 | Modify a feature without touching unrelated files? | A− | A− | **A** | YES — all 4 Jul-01 single-source regressions closed + 6 pre-existing amplifiers paid down; duplication *improved* on the stable metric |
| 2 | Test a module in isolation? | A− | A− | **A** | YES — DB injection made unit isolation the default; the strict guard *proves* it; fixture discipline held |
| 3 | Single responsibility per module? | A− | B+ | **A** | YES — all 4 fat routes extracted (thin + injected + test-pinned); the §4 HIGH finish-signup dup single-sourced; enqueue god-module resolved |
| 4 | Dependencies explicit? | B+ | B+ | **A+** | YES — **the campaign's headline.** Both residuals closed; Residual A regression is now *structurally impossible* |
| 5 | Replace a component without rewriting others? | A− | A− | **A** | YES — a 2nd clean swap-seam (LLM) added without breaking the 1st (ReviewPublisher) |

### Objective statics (2026-07-06 @ `3070f0e5`)

- **Circular dependencies: 0** · **Boundary violations: 0** (both held across the whole campaign)
- **fallow maintainability: 92.5 (good)** · avg cyclomatic **3.2** · p90 cyclomatic 7 · dead files **0.1%** · dead exports **0.0%**
- **Duplication:** `fallow dupes` line-metric **1.379%** (1,116 lines / 41 files) — *down* from the pre-campaign 1,151 lines / 44 files. (The `fallow health` composite reports 1.6%, unchanged from the pre-campaign tree — a fallow-formula-version reading, not a regression; see §2.)
- **CI guard layer: 12/12 pass live and STRICT** — `ci:db-imports` (strict), `ci:process-env` (baseline 10), `ci:tenant-scope` (362), `ci:rls-audit`, `ci:analytics-events`, `ci:static-policy`, `ci:response-status`, `ci:admin-aal2`, `ci:config-coverage`, `ci:reviews-status` (strict), `ci:outbox-topics`, `ci:fallow` (now `--coverage`-informed in CI).
- fallow composite health score 78/B — the drop from the Jul-01 "87.5/A" is a *churn* penalty (6 months of commit volume), **not** structural decay (maintainability 92.5, 0 boundaries, 0 cycles).

### The two grep-proofs (both PASS)

**Proof 1 — no domain-module DB-singleton import.** `ci:db-imports` → `passed (strict — no non-composition-root file imports db/server)`. Independent grep across `src/lib` + `worker`: the **only** `src/lib` non-test file importing `@/lib/db/server` is `src/lib/db/auth.ts` (the owner-classified root — a Supabase SSR client factory + one identity SELECT). Every worker importer is a top-level handler/poller/scheduler **registered in `worker/index.ts`** (derived roots). **The strict guard is now the permanent proof** — root status is *earned by registration* (AST-parsed from `worker/index.ts`), the baseline is deleted, and any new non-root importer fails CI.

**Proof 2 — no LLM generation/insights call outside `runLlmTask`.** `runLlmTask` has exactly two tenants (`src/lib/responses/generator.ts`, `src/lib/responses/review-summary.ts`); the only completion calls live in the seam adapters (`src/lib/llm/openai-provider.ts`, `anthropic-provider.ts`). The 3 provider-client references outside `src/lib/llm/` are all legitimately-separate APIs: OpenAI `/moderations` (`src/lib/moderation/moderate.ts` — invariant #4 veto, not chat generation), Twilio WhatsApp `messages.create` (`whatsapp-client.ts`), and a model→price lookup table (`src/lib/costs/audit.ts`, data not a call).

---

## 1. Q1 — Modify without touching unrelated files (A−→**A**, YES)

All four 2026-07-01 caveats **closed**: `NAV_LINKS`/`MARKETING_LINKS` single-owned in `src/components/ui/marketing-links.ts` (imported by SiteNav/SiteFooter/LandingExperience); star→sentiment thresholds live only in `classifySentiment` (`src/lib/reviews/sentiment.ts`), consumed by `RecentSentimentMix` + `sentiment-tier.ts`; `QUEUE_HEALTH_JOB_STATES` moved to `src/lib/shared/queue-health-states.ts` (imported by `admin/jobs/page.tsx`); `landing-legacy/` deleted. Six pre-existing amplifiers also closed (reviews.status → `REVIEW_STATUS`, channel union → `MobileChannel`, pricing → `TIER_CONFIG`-derived, ValueSummary wire type single-sourced, the dangling channels-doc ref, and the 8×/candidate-lost/cost-report/scope-join SQL dedups).

**Duplication attribution (git-blame-proven):** of 37 clone groups, **36 pre-date the campaign** (April–June bodies; the campaign threaded at most 1–3 `sql`-param lines through them). **Exactly one is campaign-introduced:** `enqueueAccountOffboardingTeardown`/`enqueueAccountOffboardingPurge` in `src/lib/account-offboarding/outbox.ts` — two near-identical 15-line within-file outbox writers differing only in queue-name + payload type, matching the file's own pre-existing enqueue-sibling pattern (LOW, does not force touching *unrelated* files). Net duplication fell (1,151→1,116 lines).

**Residuals (all LOW, accepted):** the 820px landing breakpoint duplicated JS↔CSS (inherently cross-language, documented); the one outbox clone (a 1-function extraction would close it); `mock-generator.ts`'s private star-rule re-encoding (pre-existing demo path).

## 2. Q2 — Test a module in isolation (A−→**A**, YES)

The campaign converted the largest prior weakness — an ambient DB singleton imported by ~214 modules — into a **CI-enforced strict-zero injection convention**. Every business-logic module now takes `sql`/`supabaseServer` (and Stripe/Zernio/Redis via lazy seams) as explicit parameters, so unit isolation is the default (86 DI'd tests run in 596ms with no DB). Fixture discipline held: the shared `createMockSql` fixture is used by 52 suites; remaining hand-rolled mocks are precise (content-dispatch assertions the FIFO fixture can't express), not permissive catch-alls. Import-time hygiene clean — the only module-level client construction across `src/lib`+`worker` is `db/server.ts` itself (quarantined behind the injection boundary).

**Residuals (accepted):** composition roots (Next.js route/page/layout, BullMQ handlers, ingress) read the singleton and their tests use `vi.mock('db/server')` as the injection *mechanism* — spec §2.1-sanctioned (you cannot inject into a framework caller); still fully testable. DB-gated integration suites `describe.skip` without `TEST_DATABASE_POOL_URL` (pre-existing, now a *loud* skip via `describeWithDb`).

## 3. Q3 — Single responsibility per module (B+→**A**, YES)

All four fat routes extracted into injected, single-responsibility, test-pinned modules and their routes reduced to thin orchestrators: `admin/overview/route.ts` **223→32 L** (`overview-service.ts`), `auth/signup/route.ts` **206→136 L** (`provision-auth-user.ts`), `onboarding/select-plan` (`plan-activation.ts`), `kpi/service.ts` doubled per-scope SQL collapsed via shared fragment factories. The §4 HIGH finish-signup finding — a ~38-line inline enrollment INSERT + a dead pre-034 fallback — is single-sourced in `enroll-email-owner.ts` (shared by finish-signup + verify-otp) with the dead branch deleted. The enqueue-cluster god-module watch is resolved: `account-offboarding/outbox.ts` owns the 5 offboarding enqueuers, `job-outbox-helpers.ts` shrank 603→335 L to the generic enqueuers only. No new fat route surfaced.

**Residuals (accepted, pre-existing):** `notification/dispatch.ts` 8-block UPDATE cluster (the tracked Q1 amplifier — pay down before a 4th channel); `postReplyAndHandleTerminalOutcomes` (a legitimate invariant-#12 outcome-table policy module); `kpi` partial collapse (kept two-scope by design so `tenant-scope-audit` reads raw template text).

## 4. Q4 — Dependencies explicit (B+→**A+**, YES) — the campaign's headline

**Residual A (ambient DB singletons) — closed permanently and structurally.** The strict `ci:db-imports` guard is the strongest single piece of "dependencies explicit" evidence in the codebase: worker root status is *derived from `worker/index.ts` registration* via TypeScript-AST parsing (not file position), the baseline is deleted (any new non-root importer fails), runtime-value-precise (`import type` excluded), unit-tested (11/11), and CI-wired (`.github/workflows/ci.yml` lint job). Regression is structurally impossible. Only `src/lib/db/auth.ts` (an owner-classified root) imports the singleton in `src/lib`.

**Residual B (inline LLM provider calls) — closed.** `runLlmTask` is the sole executor (2 tenants); zero generation/insights call outside `src/lib/llm/`; the seam owns fallback + transient/terminal classification + model-pinning (`model-pinning.test.ts`) + the cost-guard contract (`cost-guard-contract.test.ts`), with UI-layer runtime imports of the provider SDKs banned by `eslint-boundaries.test.ts`.

**Bonus hardening the campaign also landed:** `ci:reviews-status` (strict) + `ci:outbox-topics` guards, closing two June §2 single-source residuals; env via the typed config layer (`ci:process-env` baseline 10); flags server-authoritative (`ci:static-policy`).

**Caveats (accepted):** (1) *permanence asymmetry* — Residual A has a dedicated structural guard; Residual B is closed by seam + tests + ESLint boundary but has no dedicated grep-guard banning a generation-shaped completion call in a new file. This matches the campaign's own "guard + seam" framing. A `ci:llm-seam` guard (banning generation-shaped `chat.completions.create`/`messages.create` outside `src/lib/llm/`, allowlisting `/moderations` + Twilio) would give B the same permanence — **recommended follow-up #2**. (2) Zernio `zernioClient` is still an ambient module singleton (~8 importers) — pre-existing, out of the campaign's stated DB+LLM scope, folding it behind injection is Q5's "second adapter" trigger.

## 5. Q5 — Replace a component without rewriting others (A−→**A**, YES)

Two first-class swap-seams. The **LLM task seam** is textbook: `LLMProvider` interface + two adapters (each wraps only the SDK body) + `LLM_TASKS` registry (per-task provider/model/fallback) + `runLlmTask` as the single door — swapping a task's provider or adding a 3rd adapter edits the provider map + registry only, callers pass `taskId`+prompt and read a neutral result (zero caller rewrites). The **ReviewPublisher seam** survived every campaign commit: all 5 production call-sites resolve through `getReviewPublisher(sql)`; adding a direct-GBP adapter needs no rewrite of the publisher workers' transport calls.

**Residual (accepted):** the publisher *error-taxonomy* is still Zernio-coupled (6 worker files catch Zernio error classes) — the seam scope was explicitly locked to *transport*; error-taxonomy neutralization is deferred until a real GBP adapter forces and validates the shape ("wait for the second use case" discipline). Moderation's own OpenAI client is a distinct concern (separate `/moderations` API, independently swappable behind `moderateResponse`).

---

## 6. Retrospective

### Before → after (the arc)

| Question | Jun 26 | Jul 01 | **Exit** |
|---|:---:|:---:|:---:|
| Q1 Modify | A− | A− | **A** |
| Q2 Isolate | A− | A− | **A** |
| Q3 Single-responsibility | A− | B+ | **A** |
| Q4 Explicit deps | B+ | B+ | **A+** |
| Q5 Replace | A− | A− | **A** |

**The db-imports baseline: 105 → 0.** The campaign shrank the ambient-DB-singleton importer set from 105 checked-in files (Stage 1, #441) to zero (2i, #455), then deleted the baseline entirely and flipped the guard to strict (PR 3, #456). Nine domain sweeps, **zero behavior regressions, zero migrations**, clean staging rides for every worker-touching sweep.

### Per-PR ledger (#438 – #456)

| PR | Stage | What |
|---|---|---|
| #438 | docs | five-questions re-audit + campaign spec + Stage 0+1 plan |
| #439 | 0a | single-source client facts (NAV_LINKS, star→sentiment, queue-states) + dead-code deletion |
| #440 | 0b | pre-push audit mirror + loud integration-skip (`describeWithDb`) |
| #441 | 1a | `ci:db-imports` ratchet guard + baseline (105 files) |
| #442 | 1b | constants + guards — reviews-status, outbox-topics, pricing, ValueSummary |
| #443 | 1c | LLM task seam (`src/lib/llm/`) — generator as first tenant |
| #444 | docs | Stage 2–4 completion plan |
| #445 | 2z | `jsonb` recorded instance-bound / composition-root-only |
| #446 | 2a | auth + approval injection + `provisionAuthUser`/email-enrollment extractions |
| #447 | 2b | admin + accounts injection + `overview-service` extraction + cost-report dedup |
| #448 | 2c | billing/onboarding injection + select-plan extraction + rollback dedup |
| #449 | 2d | KPI/dashboard injection + scope-join dedup + REVIEW_STATUS |
| #450 | 2e | channels/notifications injection + 8× enrollment-UPDATE dedup + channel single-sourcing |
| #451 | 2f | reviews/responses/zernio injection + review-summary LLM-seam 2nd tenant + REVIEW_STATUS strict |
| #452 | 2g | publishing injection + ReviewPublisher constructor-injection + candidate-lost dedup |
| #453 | 2h | offboarding + locations injection + enqueue-cluster migration |
| #455 | 2i | shared/app tail injection → baseline **0** + ratchet-harness consolidation |
| #456 | 3 | ratchet **strict** + F15 registration-derived roots + process-env widen + fallow `--coverage` |

(#454 was an unrelated docs PR — codebase-audit tracker + `/feature` command.)

### Residuals + follow-ups (ranked)

1. **Crash-net "zombie-pool" liveness-escalator** (worker-resilience). The governor is blind to a fleet-wide all-poller-timeout storm because each poller catches its own timeout. A proposed escalator (crash after N consecutive fleet-wide handled failures) is documented in the [2026-07-05] lab-note but **not specced** — needs a design pass (threshold semantics, fleet-wide-failure definition, governor interaction) and its own staging ride. **The #1 post-campaign follow-up** (owner-sequenced after this audit).
2. **`ci:llm-seam` guard** — give Residual B (LLM seam) the same structural permanence as Residual A: ban generation-shaped completion calls outside `src/lib/llm/` (allowlist `/moderations` + Twilio). A++ hardening.
3. **Zernio `zernioClient` ambient singleton** (~8 importers) — fold behind injection when a second review-source/publisher adapter arrives (Q5 trigger).
4. **Publisher error-taxonomy Zernio-coupling** — neutralize when a real direct-GBP adapter forces the shape.
5. **`notification/dispatch.ts` 8-block UPDATE amplifier** — pay down before a 4th channel.
6. **The one campaign-introduced outbox clone** (`account-offboarding/outbox.ts`, 15 L) — a 1-function extraction closes it if desired.
7. **LLM temperature-forwarding** — deferred (needs a temperature-sensitive Anthropic task; post-campaign).
8. **Prefill/SerpAPI tension** and the **820px JS↔CSS breakpoint** — pre-existing, accepted.
9. **Codex adversarial reviews were usage-capped** during 2i/PR3 (available ~Aug 5). The tight named-risk-file Codex pass is the standing pattern; the comprehensive human review is the fallback when Codex is unavailable.

### Metric note (for the record)

Spec §7's "duplication ≤ 1.4%" is **met by the conventional `fallow dupes` line-metric (1.379%)** but **not by the version-sensitive `fallow health` composite (1.6%)** — and that 1.6% was already the pre-campaign baseline (identical at `8105b2c6` and HEAD), so it is a fallow-formula-definition reading, not code the campaign added. The exit criterion passes by the stable metric.

---

## 7. Exit criteria (measurable A+) — all met

1. ✅ All guards green **and strict**: 12/12 CI audits pass live; `ci:db-imports` baseline emptied + flipped strict; `ci:reviews-status` strict; `ci:outbox-topics` guard live.
2. ✅ fallow: 0 cycles, 0 boundary violations, duplication 1.379% (≤1.4% by the stable metric), none of the four extracted routes a critical/high hotspot.
3. ✅ Fresh five-questions re-audit: **A or better on all five, zero unaccepted caveats**, with both former residuals grep-proven closed (no domain-module singleton import; no LLM generation/insights call outside `runLlmTask`).
4. ✅ Retrospective + docs updates landed (this doc + the CLAUDE.md invariant + currents/progresstracking/directory sweep).

**The Modularity A+ campaign is complete.** The injection convention is now a permanent, CI-enforced invariant, not a campaign artifact.
