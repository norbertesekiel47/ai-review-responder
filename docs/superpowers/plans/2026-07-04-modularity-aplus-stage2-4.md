# Modularity A+ Campaign — Stage 2–4 Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Finish the campaign: empty both ratchet baselines via 9 per-domain sweeps (domain modules take `sql`/`supabaseServer` as explicit parameters; reviews-status literals adopt `REVIEW_STATUS`), extract the four fat routes, flip the ratchets to strict, and pass the Stage-4 exit re-audit at A/A+ on all five questions.

**Prerequisites (all on `main` as of #438–#443):** spec `docs/superpowers/specs/2026-07-01-modularity-aplus-campaign-design.md` (§2.1 injection convention is the authority); guards `ci:db-imports` (baseline: 105 files in `scripts/ci/db-imports-baseline.ts`), `ci:reviews-status` (7 files), `ci:outbox-topics` (strict); the LLM task seam `src/lib/llm/`; Stage 0+1 retrospective context in the PR trail #439–#443.

**Architecture:** Behavior-preserving throughout. One sibling worktree + one PR per sweep (`pnpm worktree:new aplus/2a-auth main`, etc.), full June pipeline each (§5). Each sweep = injection recipe (§2) over its baseline slice + the sweep's named extras + baseline regeneration. The baselines are the single source of the work queue — file lists below are DERIVED at sweep time, never copied ahead (they shrink as sweeps land).

---

## §1 Sweep order and PR map

| PR | Branch | Domain slice (baseline prefixes) | ~Files | Worker-touching → staging ride? |
|---|---|---|---|---|
| 2z | `aplus/2z-jsonb-purity` | Pre-sweep leverage: `jsonb`/pure-helper extraction (§3.0) | ~0–30 drop | no |
| 2a | `aplus/2a-auth` | `src/lib/auth/`, `src/lib/approval/` | ~7 | no |
| 2b | `aplus/2b-admin` | `src/lib/admin/`, `src/lib/accounts/` | ~10 | no |
| 2c | `aplus/2c-billing-onboarding` | `src/lib/onboarding/`, `src/lib/payments/`, `src/lib/costs/`, `src/lib/audit/`, `src/lib/analytics/`, `src/lib/demos/`, `src/lib/auto-approval/`, `worker/jobs/billing/` | ~10 | yes |
| 2d | `aplus/2d-kpi-dashboard` | `src/lib/dashboard/`, `src/lib/kpi/`, `src/lib/past-replies/` | ~5 | no |
| 2e | `aplus/2e-channels-notifications` | `src/lib/channels/`, `src/lib/notifications/`, `worker/jobs/notification/`, `worker/jobs/auto-post-notice/` | ~9 | yes |
| 2f | `aplus/2f-reviews-responses` | `src/lib/reviews/`, `src/lib/responses/`, `src/lib/zernio/`, `worker/jobs/response-generation/`, `worker/jobs/zernio/` | ~12 | yes |
| 2g | `aplus/2g-publishing` | `src/lib/publishing/`, `worker/jobs/publisher/` | ~14 | yes |
| 2h | `aplus/2h-offboarding-locations` | `src/lib/account-offboarding/`, `worker/jobs/account-offboarding/`, `src/lib/locations/` | ~22 | yes |
| 2i | `aplus/2i-shared-tail` | `src/lib/shared/`, `src/lib/db/{account-guard,auth}.ts`, `src/app/**/_shared/`, `worker/background/pollers/{billing-reconciliation,health-alert}/`, `worker/jobs/summary-report-helpers.ts` + whatever the baseline still holds | rest → **0** | yes |
| 3 | `aplus/3-ratchet-strict` | Stage 3: flip guards to strict (§4) | — | no |
| 4 | `aplus/4-exit-audit` | Stage 4: exit re-audit + retrospective (§4) | — | no |

Order rationale: 2z first (may shrink the queue for free); 2a–2d are src-lib-heavy and low-risk (build recipe muscle); 2e–2h are worker-touching and ride staging; 2i sweeps the tail to zero. Sequential execution (one sweep merged before the next starts — the baseline file is shared state).

**Derive a sweep's file list** (run inside the sweep's fresh worktree — never trust this plan's counts over the live baseline):

```bash
grep -oE "'[^']+'" scripts/ci/db-imports-baseline.ts | tr -d "'" | grep -E '^(<prefixes-for-this-sweep>)'
```

---

## §2 The injection recipe (applies to EVERY baseline file; specified once)

Per spec §2.1: domain modules receive the DB client as an explicit parameter; only composition roots import `src/lib/db/server`. For each file in the sweep's slice:

- [ ] **Step 1 — classify each `db/server` import** the file makes:
  - `sql` (Postgres.js client) → becomes a parameter.
  - `supabaseServer` → becomes a parameter (`supabase: SupabaseClient` — match the type the singleton exports; check `src/lib/db/server.ts` for the exact exported type and reuse it via `import type`).
  - `jsonb` → after PR 2z (§3.0) import it from its new pure home; if 2z proved it singleton-bound, thread it with `sql` (it hangs off the client) — never leave a value-import of `db/server`.
  - Type-only needs → `import type { ... } from '@/lib/db/server'` (guard-exempt — type imports carry no runtime dependency).

- [ ] **Step 2 — thread the parameter.** The file's PUBLIC entry functions gain a leading `sql: Sql` parameter (`import type { Sql } from 'postgres'`; use `TransactionSql` where the function is documented tx-scoped — many helpers already take `tx`, keep their existing convention). Internal/private helpers receive it from the public function. Do NOT create a `{sql, supabase}` bag; pass exactly what each function needs (spec §2.1).

- [ ] **Step 3 — update every caller.** Find callers with `rg` (or codebase-memory `search_graph`). Composition roots (routes/pages/layouts, `worker/index.ts`, top-level job handlers, poller/scheduler boot files, ingress) import the singleton and pass it down — that is their sanctioned role. A caller that is itself a baseline domain module passes through the parameter it received (if that caller is in a LATER sweep, it imports the singleton temporarily and stays on the baseline — its own sweep removes it; the ratchet tolerates existing entries, only NEW importers fail).

- [ ] **Step 4 — migrate tests.** Tests replace `vi.mock('@/lib/db/server')` with passing the shared mock-sql fixture (single-sourced since #426 — find it: `rg -l "mock-sql" src/lib/__fixtures__ src --glob '*.ts' | head`). MANDATED: use the shared fixture, never a hand-rolled permissive mock. Test count may not drop.

- [ ] **Step 5 — regenerate the baseline**: `pnpm tsx scripts/ci/db-imports-audit.ts --emit-baseline` (atomic, in-process). `git diff scripts/ci/db-imports-baseline.ts` must show EXACTLY the sweep's files removed — any unexpected add/survivor is investigated before commit.

- [ ] **Step 6 — verify** (every sweep): `pnpm vitest run <touched dirs>` → then full `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm build` · ALL `ci:*` audits (11) · `FALLOW_BASE=main pnpm ci:fallow` exit 0.

**Recipe judgment calls (decided now, don't re-litigate per sweep):**
- A file whose ONLY export is a constant/type (no DB use at runtime despite the import) → delete the dead import instead of threading a param.
- `SELECT … FOR UPDATE` helpers: preserve the documented `sql.begin()` wrapping exactly (CLAUDE.md gotcha) — injection must not move any statement across a transaction boundary.
- The 2 PgBouncer JSONB string-guard carve-out sites (`worker/jobs/RankingTrackingWorker.ts`, `src/app/api/admin/payment-success/route.ts`) keep their `JSON.parse` guards byte-identical.
- Never reorder await points or change error propagation while threading — behavior-preserving means the diff is signatures + plumbing only.

---

## §3 Per-sweep extras (beyond the recipe)

### 3.0 PR 2z — jsonb/pure-helper leverage (do FIRST)

- [ ] Read `src/lib/db/server.ts`. Determine whether `jsonb` (and any other pure helper it exports) depends on the `sql` client instance or is instance-independent (e.g. constructs a typed parameter directly).
- [ ] If instance-independent: move it to a new side-effect-free `src/lib/db/jsonb.ts`; `db/server.ts` re-exports it for back-compat (a value re-export from db/server still counts for the guard — so retarget ALL importers of `jsonb` to the new module in this same PR: mechanical find/replace, no signature changes). Regenerate the baseline; report how many entries dropped (files that imported ONLY `jsonb`).
- [ ] If instance-bound: document that in `db/server.ts`'s header (one line) and skip — sweeps thread it with `sql`.
- [ ] This PR must NOT thread any parameters — it is import-retargeting only.

### 3.1 PR 2a — auth + approval

- [ ] **Extract `provisionAuthUser`** from `src/app/api/auth/signup/route.ts:93-183` into `src/lib/auth/provision-auth-user.ts` (the ~90 lines: advisory-lock duplicate pre-check, Supabase signUp + timestamp-recovery query, anti-enumeration `identities: []` disambiguation via `admin.getUserById`, error triage, compensating `deleteUser`). TDD: decision-table tests on the extracted module FIRST (June `auth-flow.ts` pattern); the route's own test suite stays green unchanged. The new module takes `sql` + the supabase admin client as parameters (it's born injected).
- [ ] **Single-owner email-enrollment**: extract the `channel_enrollments` INSERT shared by `src/app/api/auth/finish-signup/route.ts:190-227` and `/api/auth/verify-otp` into ONE module (suggested `src/lib/notifications/channels/enroll-email-owner.ts` — check `docs/directory.md` for the channels area layout first); **delete the dead pre-migration-034 fallback branch** (its own comment admits it can only error) and replace it with a regression test asserting the precondition (`createBusinessTx` always sets `account_id`).
- [ ] Recipe over the `src/lib/auth/` + `src/lib/approval/` baseline slice. Note: `src/lib/approval/http-routes.ts` is ALSO in the reviews-status baseline — adopt `REVIEW_STATUS` there in this sweep and regenerate BOTH baselines.

### 3.2 PR 2b — admin + accounts

- [ ] **Extract `src/lib/admin/overview-service.ts`** from `src/app/api/admin/overview/route.ts:70-292` (7 inline SQL queries + churn CTE + trend derivation + email-health thresholds) — mirror `cost-report-service.ts`'s shape; the route becomes parse → call → return. Born injected.
- [ ] **Dedup the 8× rollup-boundary predicate** in `src/lib/admin/cost-report-service.ts:117-428` via Postgres.js sql-fragment composition (characterization tests pinned on current outputs FIRST — coverage there is thin).
- [ ] **Dedup the verbatim 4-DELETE rollback** in `src/lib/onboarding/admin-onboarding-service.ts:322-327` vs `:419-424` → `rollbackProvisionedBusiness(tx, …)`. (File lives in the 2c slice but the dedup pairs naturally with this sweep's admin focus — do it wherever the file gets injected; just do it exactly once.)
- [ ] Recipe over `src/lib/admin/` + `src/lib/accounts/`.

### 3.3 PR 2c — billing/onboarding/payments (+ scattered singles)

- [ ] **Extract select-plan business logic** from `src/app/api/onboarding/select-plan/route.ts:186-292`: the lock-then-read tier-snapshot transaction + trial-eligibility policy (`trialEnabled() && onboarded_by === null`) into the payments/billing module layer (check `src/lib/payments/` layout; keep the route's guard stack — flag/CSRF/auth/rate-limits — in the route, that part is legitimate).
- [ ] Recipe over the slice (billing worker file rides staging).

### 3.4 PR 2d — KPI/dashboard/past-replies

- [ ] **Collapse the doubled per-scope KPI SQL**: `getLocationKpiSummary` vs `getAccountKpiSummary` (`src/lib/kpi/service.ts:81-168` vs `:169-260`) — five near-copy queries differing only in scope join → parameterize the scope join (sql-fragment or a scope descriptor). The existing KPI tests + the #433 window tests are the behavior pin.
- [ ] reviews-status adoption in this slice: `src/lib/dashboard/{aggregate-service,service}.ts`, `src/lib/kpi/service.ts`, `src/lib/past-replies/load-replies.ts` (4 of the 7 entries) — import `REVIEW_STATUS`, keep byte-stable SQL predicates pragma'd ONLY where they genuinely sit in `ON CONFLICT`-class positions (expected: none here — these are read predicates; convert them).
- [ ] Recipe over the slice; regenerate BOTH baselines.

### 3.5 PR 2e — channels/notifications

- [ ] **Derive every channel enumeration from `CHANNEL_IDS`/`MobileChannel`** (the doc comment already claims it): `src/lib/channels/override.ts:21`, `src/lib/notifications/channels/enrollment-reducer.ts:24`, `src/app/(authenticated)/settings/channels/ChannelsClient.tsx:8`, + the `'telegram'|'whatsapp'` inline unions (~6 files — `rg "'telegram' \| 'whatsapp'|'whatsapp' \| 'telegram'" src worker`).
- [ ] **Extract the 8× `channel_enrollments` UPDATE block** in `worker/jobs/notification/dispatch.ts:84-198` (4 failure kinds × 2 location variants → one parameterized helper). Characterization tests FIRST (pin each variant's SQL semantics via the mock-sql values).
- [ ] **Single-source the channel→flag map** in `worker/jobs/notification/eligibility.ts:46-47` (+ the display-label ternary at `:84-88`) — derive from the channel registry.
- [ ] Recipe over the slice. Staging ride.

### 3.6 PR 2f — reviews/responses/zernio (the seam-completion sweep)

- [ ] **REVIEW_STATUS adoption at the remaining sites**: `src/lib/reviews/process-review.ts` + `worker/background/pollers/ZernioRecentReviewPoller.ts` (poller is a composition root for db — but it IS in the reviews-status baseline; adopt the constants) → reviews-status baseline reaches **0**. Then flip `ci:reviews-status` from baseline mode to strict (delete the baseline file, audit fails on ANY new finding) — small, do it in this PR.
- [ ] **`review-summary.ts` becomes the LLM seam's second tenant**: register an `insights`-appropriate task (or reuse the vocabulary slot the design reserved) in `src/lib/llm/tasks.ts` with PINNED model IDs; replace its bare `'gpt-4o-mini'` alias + option-less `new OpenAI()`/`new Anthropic()` clients + local fallback with `runLlmTask`. Extend `model-pinning.test.ts` to the new registry entry, add the caller to the cost-guard tripwire allowlist WITH its guard story verified (does review-summary have cost-guard coverage today? read it — if it lacks reserve/finalize, wrap it via `withCostGuard` following the cost-guard skill, as its own reviewed step, NOT silently).
- [ ] **Retire the generator back-compat re-exports** where consumers allow: retarget `src/lib/costs/audit.ts` (+ any remaining importer of `OPENAI_MODEL`/`ANTHROPIC_MODEL`/`LLM_CLIENT_OPTIONS`/`TransientLLMError` via generator) to `@/lib/llm/*`; delete the re-exports; update `client-options.test.ts` import.
- [ ] **Widen `response-status-audit` to db-tagged templates** by consuming `scripts/ci/lib/sql-tag-scan.ts` (the deferred Stage-2f item — its known-gap comment names this sweep). If widening surfaces findings, fix them with the same convert-or-pragma rule.
- [ ] `console.error` in `src/lib/llm/run-task.ts` → `createWorkerLogger` (the deferred logging item), preserving `redactProviderError`.
- [ ] Recipe over the slice (12 files; generate-draft's retry-classification chain is the sensitive part — the #255 semantics tests are the pin). Staging ride + `pnpm eval:llm`.

### 3.7 PR 2g — publishing (biggest slice, 14 files)

- [ ] **Dedup the candidate-lost UPDATE** repeated inline 3× in `worker/jobs/publisher/edit-publish-errors.ts:100,123,148` into the `edit-publish-tx.ts` leaf.
- [ ] Recipe over `src/lib/publishing/` + `worker/jobs/publisher/`. The ReviewPublisher seam interface does NOT change — only how its modules receive the client. The 195-test publisher suite is the behavior pin. Staging ride.

### 3.8 PR 2h — offboarding + locations (largest count, ~22 files)

- [ ] **Migrate the 5-function offboarding enqueue cluster** (~200 lines) out of `src/lib/shared/job-outbox-helpers.ts` into the offboarding domain (`src/lib/account-offboarding/outbox.ts` or per `docs/directory.md` conventions) — the watch-item from the Q3 audit. Callers retargeted; `job-outbox-helpers.ts` shrinks.
- [ ] Recipe over the slice. Extra care: purge/teardown paths have irreversible side effects — the integration suites (now loud-skip via `describeWithDb`) must RUN locally (`TEST_DATABASE_POOL_URL` set) for this sweep, not skip. Staging ride.
- [ ] Convert the two silent-ternary integration stragglers if their blockers are solvable here: `worker/jobs/account-offboarding/__tests__/integration-lifecycle.test.ts` needs a 3-arg describe (add an options overload to `describeWithDb`) + call-time env works now (fixed in 0b); `worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts` same pattern. If the .env.local-hydration ordering still blocks, document why and leave.

### 3.9 PR 2i — shared/app tail → baseline ZERO

- [ ] Recipe over everything left: `src/lib/shared/{job-outbox-helpers,outbox,response-status-sql,writable-subscription}.ts`, `src/lib/db/{account-guard,auth}.ts` (judgment: these are db-layer helpers — if they are thin wrappers over the singleton serving many callers, consider classifying them INTO the db module family via the spec's composition-root list + a spec amendment note, OR inject like any module; decide by reading them, document the call), the 7 `src/app/**/_shared/*` route-helper modules (inject — their route.ts callers are roots), `worker/background/pollers/{billing-reconciliation/reconcile-account,health-alert/checks}.ts`, `worker/jobs/summary-report-helpers.ts` (delete its `NON_ROOT_EXCEPTIONS` entry once injected).
- [ ] **Consolidate the ratchet harness**: extract `scripts/ci/lib/ratchet-harness.ts` (collectFiles walker + SKIP sets + evaluateFindings + baseline emit) consumed by all four audit scripts (the walker exists 6× — final-review finding). Byte-identical behavior; the audits' own unit tests are the pin.
- [ ] Regenerate: `db-imports` baseline must be **EMPTY**. Do NOT flip to strict here — that's Stage 3's PR (keep the flip reviewable in isolation).

---

## §4 Stage 3 + Stage 4

### PR 3 — ratchet strict

- [x] `ci:db-imports`: delete the baseline file + baseline logic; the audit fails on ANY non-composition-root importer. Revisit `NON_ROOT_EXCEPTIONS` (should be empty after 2i — delete the mechanism if so, or deepen per the final-review note: derive job-root status from `worker/index.ts` registration if any exception remains). **DONE (PR 3):** baseline file + `--emit-baseline` deleted; strict. `NON_ROOT_EXCEPTIONS` DEEPENED, not just deleted — the positional `worker/jobs|background/…` rules were replaced with roots DERIVED from `worker/index.ts` registration (F15), so no top-level helper can silently regain root status.
- [x] Widen `ci:process-env` scanning to `src/app` + `src/components` (expect only exempt indicators/NEXT_PUBLIC literals; baseline anything genuine and empty it here). **DONE (PR 3):** widened; `NEXT_PUBLIC_*` made an exempt indicator; baseline 14 → 10 (2 genuine admin-channel reads added, 6 NEXT_PUBLIC-only readers dropped as newly-exempt).
- [x] Update spec §2.1's "ratchet" framing + lab-notes + CLAUDE.md if any wording references baselines. **DONE (PR 3):** spec §2.1 + lab-notes updated for the strict flip + F15 + process-env widening + fallow `--coverage`; CLAUDE.md carried no baseline wording, so no change needed. (Also landed in PR 3: real `fallow --coverage` in CI — plan §3.9's deferred item.)

### PR 4 — exit re-audit + retrospective

- [ ] Re-run the five-questions audit exactly as on 2026-07-01: fallow statics + all CI guards + five independent question-agents + verification. **Exit bar: A or better on all five, zero unaccepted caveats**, grep-proof both former residuals closed (no domain-module singleton imports; no LLM call outside `runLlmTask`).
- [ ] Write the campaign retrospective to `docs/audits/` (June-campaign format: before→after table, per-stage PR list, residuals if any); update `docs/progresstracking.md`, `docs/currents.md`, `.claude/CLAUDE.md` (delete the two now-closed "deliberate residual" notes; add the injection convention as a stated invariant), `docs/directory.md` sweep.

---

## §5 Per-PR pipeline (unchanged from Stage 0+1 — owner's standing decision: FULL pipeline, every PR)

> sibling worktree (`pnpm worktree:new <branch> main`) → recon (derive file list from live baseline) → TDD → full local verify gate (lint · typecheck · full test · build · ALL `ci:*` audits · `FALLOW_BASE=main pnpm ci:fallow`) → spec-compliance review (subagent) → code-quality review (subagent, re-review loop until APPROVED) → Codex adversarial review (`codex exec --sandbox read-only`, iterate to VERDICT: APPROVED; controller arbitrates) → push + PR → CI green → staging ride for worker-touching sweeps (push branch to `staging`, Railway worker boots clean, DB pollers cycle) → owner merges → ff `staging` onto `main` → remove worktree.

**Operational lessons already paid for (do not relearn):** never run two full test suites concurrently against the shared TEST_DATABASE_POOL_URL (stale-row poisoning — see lab-notes); `pnpm lint` ≠ CI lint job (run audits explicitly); fallow false-fires on comment prose containing `import '...'` patterns and on `— prose` after pragma directives; use `--no-verify` only for docs-only pushes; Codex sometimes resumes a stale session — always `codex exec` fresh with an explicit diff-scoped prompt.

## §6 Self-review

- Spec coverage: every §3 Stage-2 row of the campaign spec maps to a sweep; the four Q3 route extractions land in 2a/2b/2c; both baselines reach 0 (2i + 2f); Stage 3/4 match spec §4-7. Deferred-by-design items carried: harness consolidation (2i), response-status widening (2f), silent-skip stragglers (2h), NON_ROOT_EXCEPTIONS deepening (PR 3). Temperature-forwarding stays out (needs a temperature-sensitive Anthropic task — post-campaign).
- No placeholders: every sweep names its extras with file:line anchors from the merged audits; mechanical steps reference the §2 recipe + derive-commands rather than duplicating the baseline (single source).
- Consistency: baseline counts quoted (105/7) match `main` at plan time; sweeps re-derive at execution.
