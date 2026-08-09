# feat-728-content-freshness-gate — deviations log

- [2026-08-09] **Token owner relocated (plan round 1, codex BLOCKER — ACCEPT).**
  ADR 0017's letter cited the `SKIP_REASON_ARCHIVED_LOCATION` precedent in
  `worker-types.ts`, but that precedent is for log-only skip reasons. Our skip
  reason is written to `job_outbox.completion_reason`, whose declared single
  owner is `OUTBOX_COMPLETION_REASON` (`src/lib/shared/outbox-completion-reason.ts`
  — `markOutboxCompletedWithReason` is typed against it, so the plan's original
  shape could not typecheck). Token becomes
  `OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT` (spelling `stale_review_content`
  unchanged, per owner sign-off); `worker-types.ts` drops out of the change.
  Locus correction, not a decision reversal — one owner per fact preserved.
- [2026-08-09] **Surface amendment #1 (owner-approved via AskUserQuestion).**
  Added `src/lib/shared/outbox-completion-reason.ts` (blocker fix) and
  `worker/jobs/publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts`
  (consumes persist's string return at :430-454, :475-516 — mechanical unwrap
  for the discriminated-union return). Removed `src/lib/shared/worker-types.ts`
  (token no longer lives there) and `worker/jobs/__tests__/correlation-chain.test.ts`
  (miscited path; the real `worker/__tests__/correlation-chain.test.ts` never
  calls persist and needs no edit). Amendment budget: 1 of 2.
- [2026-08-09] **tests_to_add additions (owner-approved deviations, not
  amendments — #643 rule).** Three titles added from codex round-1 findings:
  the two-client FOR-UPDATE lock-serialization test (an implementation reading
  the hash before the lock passes every original test), the all-lanes unit test
  (a gate conditional on `on_demand_generate` would have passed the eval), and
  the structured-log-line test (intake observability had no assertion).
  `estimated_test_lines` 500 → 650 accordingly.
- [2026-08-09] **Rejected codex finding (recorded per round protocol):**
  "plan must run `pnpm build` and explicit tenant-scope/rls commands." The
  verify-gate contract runs every `ci:*` audit on every gate (tenant-scope +
  rls-audit observed PASS in this branch's docs-only run) and runs `pnpm build`
  only when the surface includes ui; this feature is backend-surface. The
  gate script, not the plan, owns verification enumeration.
- [2026-08-09] **Task 1 mechanical adaptations (no semantic drift).**
  (a) The plan's gate-block fixture `baseInput(overrides)` (default lane
  `ON_DEMAND_GENERATE`) collides with persist.test.ts's existing module-scope
  `baseInput` (default lane `live_ingest_new`); named the block-local wrapper
  `gateInput` — it delegates to the file's `baseInput` — instead of shadowing.
  It also defaults `reviewId: 'review-1'` so the log test's `review_id`
  expectation matches the input the gate logs (the plan's queue rows and log
  assertion both use 'review-1' while the file fixture uses 'rev-1').
  (b) Integration slot-free test asserts the responses rows via
  `toHaveLength(1)` + `toMatchObject({ version: 1 })` rather than
  `toEqual([{ version: 1 }])` — postgres.js RowList arrays carry enumerable
  non-index properties that can break whole-array `toEqual`.
  (c) Lock-serialization test wraps the blocked-race assertion in
  `try/finally { resolveReleaseGate(); await bDone; }` and carries a per-test
  `{ timeout: 10_000 }` (dispatch instruction: fail fast, never hang) — a
  failed assertion must not leave B's open tx holding the review row lock and
  wedge afterAll cleanup.
- [2026-08-09] **Task 4 harness fix.** The new integration suite queried
  `agent_run_steps`/`agent_outcomes` by `run_id`; the schema column is
  `agent_run_id`. Fixed in the suite's spine assertions + afterAll cleanup
  (4 sites). Gate semantics untouched.
- [2026-08-09] **verify-gate env gap (workaround applied; out-of-surface
  follow-up).** The gate resolves `TEST_DATABASE_POOL_URL` but not
  `DATABASE_POOL_URL`, so a changed integration suite that transitively
  imports the `src/lib/db/server` singleton (the autopilot-entitlement suite
  via stripe `subscription-updated` ingress → `resolveAccountReference`) gets
  vitest.setup's dummy `localhost:5432` and times out (30s + unhandled
  ECONNREFUSED). Pre-existing suite requirement surfaced because Task 1's
  mechanical unwrap made the suite "changed". Worked around by invoking the
  gate with both vars exported to the test DB. `scripts/verify-gate.sh` is
  outside this feature's surface — promote at step 8 (lab-notes + follow-up
  ticket for the gate script).

## Step 6 read-back verdicts (orchestrator, 2026-08-09)

- Token owner relocation — **ACCEPT** (typed vocabulary made the original shape untypecheckable; one-owner preserved; owner signed the spelling).
- Surface amendment #1 — **ACCEPT** (owner-approved; budget 1 of 2).
- tests_to_add additions — **ACCEPT** (all three shipped verbatim and are green).
- Rejected build/audit finding — **ACCEPT** (codex round 2 conceded with the gate-contract citation).
- Task 1 adaptations (a)(b)(c) — **ACCEPT** (fixture-collision rename delegates rather than shadows; RowList quirk is a documented postgres.js behavior; the finally-release guard prevents a wedged afterAll — none touches gate semantics).
- Task 4 harness fix — **ACCEPT** (column-name correction in test-only code).
- verify-gate env gap — **ACCEPT** as workaround; carries a step-8 promotion obligation (lab-notes + gate-script ticket). Nothing invalidates a locked intake decision; no RE-PLAN entries.

## Step 7 round-1 triage (orchestrator, 2026-08-09)

- [2026-08-09] **Adversarial CRITICAL (codex): same-version generation cache
  defeats the gate — ACCEPT; owner chose Option A (fix now).** The
  `(reviewId, version)` cache key carries no content provenance; live-ingest's
  replacement job shares the version, so a stale H1-cached draft is served to
  the H2-loaded replacement, whose gate sees H2==H2 and persists the stale
  text. Pre-existing vector (predates this branch) but it falsifies ADR 0017's
  convergence claim. **Owner explicitly overrode the 2nd-amendment abort
  trigger via AskUserQuestion ("A: amend surface, fix now")** — surface
  amendment #2 recorded below; abort criteria satisfied by owner decision, not
  ignored. Fix: bind cache provenance — `CachedGeneration` gains
  `reviewContentHash`; cache-read accepts ONLY strict equality with the
  current attempt's loaded hash (null===null for legacy); provenance-less/
  mismatched entries rejected + cleared best-effort (corrupt-payload
  precedent); `generate-draft.ts` threads `ctx.loadedReviewContentHash` into
  `GenerationOptions`. `tracker.ts` needs NO edit (payload is opaque to it) —
  amendment narrower than the owner-approved description.
- [2026-08-09] **Surface amendment #2 (owner-approved, Option A):** added
  `worker/jobs/response-generation/generate-draft.ts`,
  `src/lib/responses/generator.ts`, `src/lib/responses/types.ts`,
  `src/lib/responses/__tests__/**`. Amendment budget: 2 of 2 — any further
  amendment is a hard abort.
- [2026-08-09] **Spec MEDIUM (retry-window warm cache) — ACCEPT, resolved via
  the provenance fix**, not via clear-on-skip: a handler re-run that reloads
  H2 now rejects the H1-tagged cache and regenerates fresh, so the persisted
  text is current. clearCachedGeneration on the skip branch was deliberately
  NOT added — the provenance check is the one owner of cache validity, and a
  redundant second guard is exactly the two-owner drift CLAUDE.md warns about.
- [2026-08-09] **Standards LOW ×2 — ACCEPT both.** (1) persist.ts returns a
  typed outcome from the `sql.begin` callback (canonical precedent
  `auto-policy-publish.ts` InitialPhaseOutcome) instead of the
  `staleContentSkip` outer flag. (2) Handler gate-skip test pins
  `mockSql, 'outbox-gen-1'` per house style.
- [2026-08-09] **tests_to_add additions (owner-implied by Option A):** three
  cache-provenance titles added to the intake; `estimated_prod_lines` 90→140,
  `estimated_test_lines` 650→800 (both under the 2× reclassify bar against
  actuals).
