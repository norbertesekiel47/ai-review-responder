# Modularity A+ Campaign — Design

**Date:** 2026-07-01 · **Status:** Spec approved section-by-section in brainstorm; awaiting written-spec sign-off
**Inputs:** [`docs/audits/2026-07-01-modularity-five-questions-reaudit.md`](../../audits/2026-07-01-modularity-five-questions-reaudit.md) (the findings),
[`docs/audits/2026-06-26-modularity-five-questions-remediation.md`](../../audits/2026-06-26-modularity-five-questions-remediation.md) (the process precedent),
[`docs/future-plans/2026-07-01-agentic-reputation-platform-design.md`](../../future-plans/2026-07-01-agentic-reputation-platform-design.md) (design-of-record bounding the LLM seam)

---

## 0. Goal and non-goals

**Goal:** take all five modularity questions to a literal A+ — every finding in the
2026-07-01 re-audit closed **and both June-accepted residuals closed** — with zero
behavior change, verified by a fresh independent re-audit at campaign end.

**Non-goals (explicitly out of scope):**
- Any schema change. Migration 070 (`reviews.google_review_name`) is separate,
  already-in-flight GBP-readiness work; this campaign contains **zero migrations**.
- Agentic Phase 1 features (run-spine tables, triage step, veto window, judge poller).
  The campaign *enables* them (LLM task seam, injected DB) but builds none of them.
- New product behavior of any kind. Every PR is behavior-preserving.

## 1. Decision log (locked with owner, 2026-07-01)

1. **Scope = literal A+.** Close every Tier 1–4 re-audit finding AND both June
   residuals (ambient DB singletons; inline LLM provider calls). Rationale: the
   agentic-platform pivot (design-of-record) supplies the concrete second use case
   that made both residuals "speculative" in June — they no longer are.
2. **DB residual closes via domain-boundary parameter injection** (not a lazy
   accessor, not ALS ambient context). Domain modules take the client as an explicit
   parameter; composition roots construct/import it.
3. **Full June pipeline on every PR** — no risk-tiering of the verification gauntlet.
4. **LLM seam is agent-ready now**, bounded strictly by the design-of-record: four
   task kinds (triage / generation / judge / insights), per-task pinned models with
   fallback, structured outputs, mandatory cost-guard. **No streaming, no tool-calls,
   no multi-turn loops** — the design-of-record disqualifies them ("no LLM in the
   control path"; "nothing here needs streaming").
5. **Campaign structure = foundation-first** (Approach A): conventions land first,
   then domain sweeps that each touch a domain exactly once (extraction + injection +
   dedup in one pass).

## 2. Seam designs

### 2.1 `Db` injection convention (Q4 → A+)

**Convention.**
- `src/lib/db/server.ts` remains the single owner/constructor. No change to pooling,
  `statement_timeout: 30_000`, or the two-client split — Postgres.js and
  `supabase-js` stay separate clients, never collapsed into a `{sql, supabase}` bag.
- **Composition roots** may import the singleton: route handlers (`src/app/api/**`),
  worker job handlers at their registration point, poller/scheduler boot, ingress
  handlers, `src/instrumentation.ts`, and `src/lib/db/auth.ts`. They pass the client
  down. (`src/lib/db/auth.ts` is an owner-decided 2i classification: it is a
  db-layer auth gate — a Supabase SSR client factory plus a single identity SELECT
  serving ~14 callers — not a domain business-logic module, so it is named
  explicitly as a root in the `ci:db-imports` guard rather than injected.)
- **Domain modules** (`src/lib/**` business logic) receive `sql: Sql` — or
  `tx: TransactionSql` inside transactions, which is already the repo convention for
  helpers like `job-outbox-helpers` — as an explicit leading parameter. They never
  import the singleton. This generalizes an existing pattern; it does not invent one.
- Pass exactly the client a module needs (`sql` and/or `supabase`), never a bag.

**Enforcement ratchet — now STRICT (Stage 3 done).** AST-based `ci:db-imports`
guard (same family as the existing audits). It shipped in Stage 1 with a checked-in
baseline of current importer files; every domain sweep shrank that baseline, and
Stage 3 (PR 3) drove it to zero and **flipped the guard to strict** — the baseline
file (`scripts/ci/db-imports-baseline.ts`) is deleted, and CI now fails on ANY
non-composition-root file that imports `@/lib/db/server` (no baseline, no
`--emit-baseline`). Composition roots are the fixed set above, plus worker roots
that are **registration-derived, not positional**: `isCompositionRoot` reads
`worker/index.ts` and credits a top-level `worker/jobs/<X>.ts`,
`worker/background/pollers/<X>.ts`, or `worker/background/schedulers/<X>.ts` as a
root ONLY if the entry point imports (registers) it. A top-level helper beside the
handlers (e.g. `summary-report-helpers.ts`) is a domain module, not a root, unless
registered; an un-credited real handler is a loud CI failure (fix by registering it
in `worker/index.ts`), never a silent root grant. The ratchet is what makes the
grade permanent.

**Test migration rule.** Tests move from `vi.mock('@/lib/db/server')` to passing the
repo's existing shared mock-sql fixture (single-sourced in #426) — mandated, so no
hand-rolled permissive mocks weaken assertions. Test count may not drop in any PR.

### 2.2 LLM task seam (Q5 → A+)

New `src/lib/llm/` owning three things:

1. **`LLMProvider` interface** — `complete(request) → { output, usage }`; request
   carries pinned model ID, system/prompt, max tokens, temperature, and an optional
   structured-output schema (for triage labels and judge verdicts). Two adapters
   (`openai-provider.ts`, `anthropic-provider.ts`) wrap today's `callOpenAI` /
   `callAnthropic` bodies byte-for-byte. Deliberately absent: streaming, tool-calls,
   multi-turn (per design-of-record).
2. **`LLM_TASKS` registry** — per-task descriptors:
   `{ taskId, primary: {provider, pinnedModelId}, fallback?, outputSchema?, promptPolicyRef }`.
   The four task IDs (`reply_generation`, `triage`, `judge`, `insights`) are declared
   as the *type vocabulary*; only `reply_generation` gets a runtime entry now — no
   dead task code ships. Model pinning moves here; `model-pinning.test.ts` retargets
   the registry (pinned IDs, never bare aliases — unchanged rule).
3. **`runLlmTask(task, input, costContext)`** — the single executor: cost-guard
   reserve → primary call → transient-classified fallback (reusing
   `isTransientLLMError` unchanged) → finalize with actual tokens + prompt-policy
   hash on `api_costs`. This is today's generator control flow *relocated*, not
   changed. The generator becomes the seam's first tenant with byte-identical
   behavior.

**Cost-guard invariant moves byte-for-byte** — the four pre-LLM touchpoints, the
`CostInfraUnavailableError` retry semantics from #255 (transport failures RETRYABLE,
budget decisions TERMINAL), and the guardrail-retry anti-respend edge case are a
named Codex-review focus for PR 1c, not incidental.

When agentic Phase 1 arrives, triage/judge/insights are registry entries + prompts,
not plumbing.

## 3. Stages and PRs (~16 PRs)

### Stage 0 — Quick wins (2 PRs, parallel-safe)

| PR | Contents |
|---|---|
| 0a | Single-source marketing nav links (shared `NAV_LINKS` → SiteNav / SiteFooter / LandingExperience); single-source star→sentiment thresholds (shared constant → `classifySentiment` + `RecentSentimentMix` + `RecentRatingBreakdown`); move `QUEUE_HEALTH_JOB_STATES` to `src/lib/shared/` so `admin/jobs/page.tsx` imports it; delete `src/components/sections/landing-legacy/` + `worker/jobs/publisher/types.ts` + 2 unused tilt-card exports; fix the dangling `docs/adding-communication-channels.md` ref; reformat the 3 fallow pragma comments (prose to its own line) |
| 0b | Pre-push hook (`lefthook.yml`) mirrors all 8 CI audits; `describeWithDb` test helper that emits a stderr warn when integration suites skip for missing `TEST_DATABASE_POOL_URL` |

### Stage 1 — Foundations (3 PRs; later stages depend on these)

| PR | Contents |
|---|---|
| 1a | `ci:db-imports` AST guard + checked-in baseline (no runtime change); injection convention documented in `.claude/` reference |
| 1b | `src/lib/reviews/status.ts` constants + AST-guard extension to review statuses (same `status-audit-ignore` pragma carve-outs for byte-stable SQL predicates); outbox writers adopt `QUEUE_NAMES` (7 sites) + topic-name guard; pricing page derives display prices from `TIER_CONFIG`; value-summary wire type declared once |
| 1c | LLM task seam per §2.2 — worker-touching: staging ride + `pnpm eval:llm` mandatory |

### Stage 2 — Domain sweeps (~9 PRs; each = extraction + injection + dedup in ONE pass, shrinking the 1a baseline)

| PR | Domain | Headline work beyond injection |
|---|---|---|
| 2a | Auth | Extract `provisionAuthUser` from signup route; single-owner email-enrollment module shared by `finish-signup` + `verify-otp`; delete the dead pre-034 fallback branch (replaced by a regression test on the primary path's precondition) |
| 2b | Admin | Extract `src/lib/admin/overview-service.ts` (mirror of cost-report-service); dedup the 8× rollup-boundary predicate in `getCostReport` via sql-fragment composition |
| 2c | Billing/onboarding | Select-plan tier-snapshot transaction + trial-eligibility policy into the payments module; extract `rollbackProvisionedBusiness()` in admin-onboarding (4-DELETE dedup) |
| 2d | KPI/dashboard | Collapse the doubled per-scope SQL in `kpi/service.ts` (scope-join parameterization) |
| 2e | Channels/notifications | Derive all channel unions from `CHANNEL_IDS` / `MobileChannel`; extract the 8× `channel_enrollments` UPDATE block in `dispatch.ts`; single-source the channel→flag map in `eligibility.ts` |
| 2f | Reviews/responses | Adopt `reviews/status.ts` at all 14+ literal sites; inject through process-review / sentiment / place-id-resolver; **rebase on migration-070 ingest wiring** |
| 2g | Publishing | Dedup the candidate-lost UPDATE into the `-tx` leaf (`edit-publish-errors.ts`); inject through publisher worker files (ReviewPublisher seam untouched) |
| 2h | Workers/outbox | Migrate the 5-function offboarding enqueue cluster out of `job-outbox-helpers.ts` into the offboarding domain; inject pollers via `createGuardedPoll` deps |
| 2i | Locations/offboarding + remainder | Sweep the baseline tail to zero |

### Stage 3 — Ratchet strict (1 PR) — DONE (PR 3)

Flipped `ci:db-imports` from baseline to a strict composition-root allowlist —
baseline file deleted, and worker roots are now registration-derived from
`worker/index.ts` (not positional; `NON_ROOT_EXCEPTIONS` deleted). Widened
`ci:process-env` scanning to `src/app` + `src/components` and made `NEXT_PUBLIC_*`
an exempt indicator (build-inlined public client config), taking its baseline
14 → 10 (2 genuine admin-channel reads added; 6 `NEXT_PUBLIC`-only readers dropped
as newly-exempt) — still baseline-mode, not strict. Also gave `ci:fallow` real
`--coverage` in CI (`.github/workflows/fallow.yml` runs `pnpm test:coverage` then
`ci:fallow:coverage`, which first normalizes the vitest-4 v8 `-1` branch-count
sentinel); local/manual `ci:fallow` stays static.

### Stage 4 — Exit gate (1 PR + audit)

Fresh five-questions re-audit (same independent-agent method as 2026-07-01) — **must
score A or better on all five with zero unaccepted caveats**; retrospective doc in
`docs/audits/`; CLAUDE.md / `docs/directory.md` / `.claude/reference` updates
(injection convention, LLM seam pointer, delete the two now-closed "deliberate
residual" notes).

**Sequencing:** Stage 0 ∥ Stage 1 may overlap. Stage 2 sweeps run sequentially
(staging rides + shared fixtures make parallel sweeps riskier than they're worth);
2a–2i order is flexible when conflicts with in-flight work appear.

## 4. Per-PR pipeline (June pipeline, every PR — Decision 3)

> sibling worktree (`pnpm worktree:new <branch>`, never nested) → recon → TDD →
> full local verify gate (lint · typecheck · test · build · all `ci:*` audits) →
> multi-round Codex adversarial review → thermo-nuclear maintainability review →
> PR → CI green incl. React Doctor 100/100 → staging ride for worker-touching
> batches (Railway worker boots clean) → merge → ff `staging` onto `main`.

## 5. Behavior-preservation proof, by change type

- **Mechanical injection:** tests migrate to the shared mock-sql fixture; test count
  may not drop; typecheck + full suite are the net.
- **Route extractions:** TDD — decision-table tests on the extracted module first
  (June `auth-flow.ts` pattern); route suites untouched and green.
- **Dedups:** characterization tests pinned on current behavior *before* refactoring
  where coverage is thin (dispatch UPDATE variants, cost-report predicate).
- **LLM seam:** existing generation suite + retargeted model-pinning test + offline
  `eval:llm` + staging ride generating a real draft; cost-guard semantics reviewed
  as a named focus (§2.2).
- **Dead-fallback deletion (2a):** regression test asserting `createBusinessTx`
  always sets `account_id` (the precondition that makes the fallback unreachable).

## 6. Risks → mitigations

1. **DI churn through billing/approval paths** → full pipeline per PR + per-domain
   batching + the `ci:db-imports` ratchet (baseline-shrinking through Stage 2, now
   flipped strict in Stage 3); no big-bang moment exists.
2. **Conflicts with in-flight work** (migration-070 ingest wiring; agentic Phase 1)
   → 2f rebases on 070's wiring; Phase 1 starts after campaign end (Decision 5
   chose foundation-first over pivot-first for exactly this reason).
3. **Zero migrations** → no staging/prod lockstep risk in this campaign.
4. **PgBouncer JSONB string-guard allowlist (exactly 2 sites)** must survive
   injection untouched; any new JSONB read follows the documented carve-out.
5. **Mock drift** → shared mock-sql fixture mandated (§2.1); hand-rolled permissive
   mocks are a review-rejection criterion.
6. **Worktree discipline** → sibling worktrees only; nested worktrees poison local
   CI (documented CLAUDE.md footgun).

## 7. Exit criteria (measurable A+)

1. All 11 guards green and strict: existing 8 + `ci:db-imports` (strict; baseline
   deleted in Stage 3) + reviews-status extension + topic-name guard.
2. fallow: 0 cycles, 0 boundary violations, duplication ≤ 1.4%, none of the four
   extracted routes remains a critical/high hotspot.
3. Fresh five-questions re-audit: **A or better on all five, zero unaccepted
   caveats**, with grep-proof both former residuals are closed (no domain-module
   singleton imports; no LLM call outside `runLlmTask`).
4. Retrospective + docs updates landed.
