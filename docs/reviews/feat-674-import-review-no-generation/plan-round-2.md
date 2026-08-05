# Adversarial Review: Ticket #674 Plan — Round 2 (Verification)

## 1. Round-1 findings: fix verification

- **Finding 1: Design-of-record availability and content**
  - Status: PARTIALLY FIXED
  - Evidence: The design file now exists, is tracked, and was committed in `c0cd0ad8`; the intake also adds it to `allowed_edit_surface` (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:44-50`). However, actual §6.2 only requires “a path that inserts and stops” while retaining write-site sentiment classification (`docs/superpowers/specs/2026-08-05-consented-review-import-design.md:184-189`). It does not name `importReview`, define its `'new' | 'unchanged'` contract, specify run completion or analytics, or define the plan’s conflict/no-lock semantics (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:436-479`). The only other conflict reference says existing `processReview` dedupes via `ON CONFLICT`; it does not specify `importReview` behavior (`docs/superpowers/specs/2026-08-05-consented-review-import-design.md:217-226`). This remains materially narrower than deviations D1 says the committed version would be (`docs/superpowers/plans/feat-674-import-review-no-generation-deviations.md:12-25`).
  - Confidence: 99%

- **Finding 2: Imported runs are completed without changing existing callers**
  - Status: FIXED
  - Evidence: The plan changes `startReviewRun` to return `Promise<string | null>` while leaving both existing `processReview` call sites untouched (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:403-421`). Those are the only two call sites, and both merely `await` and discard the result (`src/lib/reviews/process-review.ts:84-100`, `src/lib/reviews/process-review.ts:283-308`). The existing defensive-branch test asserts the enclosing `processReview` result and spine calls, not `startReviewRun`’s return value (`src/lib/reviews/__tests__/process-review.test.ts:735-756`).
    
    `completeRun` has no `recordOutcome` precondition: it only changes a running `agent_runs` row to terminal and probes for existence on a no-op (`src/lib/agents/run-spine.ts:531-572`). The applicable database constraint is exactly `CHECK ((status = 'running') = (ended_at IS NULL))` (`supabase/migrations/071_agent_run_spine.sql:28-29`), which the simultaneous `status`/`ended_at` update satisfies. `agent_outcomes.agent_run_id` is nullable and points from an optional outcome to a run; there is no inverse requirement that a completed run have an outcome (`supabase/migrations/071_agent_run_spine.sql:67-87`). The module’s separate lock-order invariant requires a review-row lock before run-row locks (`src/lib/agents/run-spine.ts:5-17`); the proposed path inserts and therefore owns the new review row before starting, recording, and completing its run in the same transaction (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:480-499`).
    
    A later live update will not reuse the completed run: both the partial conflict target and fallback lookup consider only `status = 'running'` (`src/lib/agents/run-spine.ts:107-147`), matching the partial unique index (`supabase/migrations/071_agent_run_spine.sql:38-42`). A completed import run is excluded, so a fresh running run can be inserted.
  - Confidence: 98%

- **Finding 3: Canonical INSERT parameter-order test**
  - Status: FIXED
  - Evidence: The fixture defaults are provider `zernio`, review ID `r1`, names `zernio://loc1/reviews/r1` and `zernio://loc1`, Google name `null`, reviewer `Alice`, rating `5`, text `Great!`, date `2026-04-28`, language `en`, and hash `hash-abc` (`src/lib/reviews/__tests__/process-review.test.ts:46-74`). `REVIEW_STATUS.NEW` is `'new'` (`src/lib/reviews/status.ts:23-32`), and `classifySentiment(5)` produces `{ score: 1, label: 'positive', source: 'deterministic_star_v1' }` (`src/lib/reviews/sentiment.ts:15-33`). Recomputing the proposed helper’s bindings (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:359-384`) yields exactly the plan’s expected 16-value suffix after the independently checked UUID, for 17 total bindings (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:171-202`). No mismatch was found.
  - Confidence: 100%

- **Finding 4: Exactly-one-transaction assertion**
  - Status: FIX INTRODUCES NEW DEFECT
  - Evidence: The revised test now directly obtains `sql.begin` and asserts it was called exactly once, correctly addressing the round-1 gap (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:232-247`). However, the same test calls `mockInsertWon()` with its default `earlierExists = true` (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:120-125`, `docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:232-236`) and then expects `enqueueAnalyticsEvent` to have been called (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:248`). The actual helper returns immediately when `earlier_exists` is true (`src/lib/reviews/process-review.ts:188-225`). A correct implementation will therefore fail this new test. The setup must use `mockInsertWon(false)` or remove that analytics assertion.
  - Confidence: 100%
  - New defect the fix introduced: The one-transaction test contains a contradictory fixture and assertion, so Task 1 cannot go green against the planned correct implementation.

- **Finding 5: FK-impossible missing-business test**
  - Status: FIXED
  - Evidence: Task 1 now contains eight tests at `docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:133-308`; none tests a successful review insert followed by a missing business. The intake’s test list likewise contains only those eight tests (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:52-60`). The impossible case remains only as an explicitly rejected edge case, not a test (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:28-34`).
  - Confidence: 100%

- **Finding 6: `processUnansweredReview` symbol correction**
  - Status: FIXED
  - Evidence: The plan now calls it the `processUnansweredReview` closure inside `handleZernioBackfill` (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:471-472`), and the intake uses the same wording (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:13`). The actual exported handler begins at `worker/jobs/zernio/ZernioBackfillWorker.ts:44`, while `processUnansweredReview` is declared as a nested function at `worker/jobs/zernio/ZernioBackfillWorker.ts:210-246`.
  - Confidence: 100%

## 2. Rejected-reasoning verification

- **CONTEXT.md format and insertion point**
  - Status: CONFIRMED CORRECT
  - Evidence: `CONTEXT.md:3-14` is exactly a sequence of `- **Term**: definition` bullets. Additional opening glossary bullets continue through line 23, and the first `##` heading is at line 25 (`CONTEXT.md:1-25`). The revised instruction—insert as the last opening-list entry immediately before the first `##`—unambiguously lands the new bullet between lines 23 and 25 (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:541-553`).
  - Confidence: 100%

- **`job_outbox` assertion**
  - Status: CONFIRMED CORRECT
  - Evidence: `enqueueAnalyticsEvent` writes `INSERT INTO analytics_events`, not `job_outbox` (`src/lib/analytics/enqueue.ts:20-54`). The test suite mocks the database, analytics enqueue, and run-spine seams only (`src/lib/reviews/__tests__/process-review.test.ts:16-35`); it does not mock `enqueueGenerateResponse`. That real helper is imported and called by `processReview` (`src/lib/reviews/process-review.ts:11`, `src/lib/reviews/process-review.ts:93-100`), and existing tests observe its real tagged-template `INSERT INTO job_outbox` call (`src/lib/reviews/__tests__/process-review.test.ts:109-133`). The proposed negative SQL assertion is therefore meaningful for detecting a stray generation enqueue.
  - Confidence: 99%

## 3. Deferred item: Hazards write-up accuracy check

- **Cross-lane lost-draft interleaving**
  - Status: ACCURATE
  - Evidence: `processReview` first probes the identity under `FOR UPDATE` (`src/lib/reviews/process-review.ts:47-59`), then attempts `INSERT … ON CONFLICT DO NOTHING` if absent (`src/lib/reviews/process-review.ts:61-82`). On losing that insert race it re-reads the winner under `FOR UPDATE` and enters `processExistingReview` (`src/lib/reviews/process-review.ts:110-138`). A matching content hash returns `'unchanged'` without generation (`src/lib/reviews/process-review.ts:241-254`). That matches the sequence and consequence documented in the plan and deviations (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:35-37`; `docs/superpowers/plans/feat-674-import-review-no-generation-deviations.md:89-108`).
  - Confidence: 98%
  - The owner’s fix-now-versus-#675 decision is out of scope and was not re-argued.

## 4. Fix-introduced defect checks

- **Insert-path and skip-path transaction-call counts**
  - Status: CONFIRMED CORRECT
  - Evidence: The planned successful path makes three visible tagged-template calls: review INSERT, business lookup in `startReviewRun`, and first-review lookup (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:112-125`). `startOrGetActiveRun`, `recordStep`, `completeRun`, and analytics enqueue are mocked with no implementations that invoke `tx` (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:52-64`), so completion does not increase the harness count. The zero-row conflict path returns immediately after the review INSERT (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:480-499`), leaving exactly one visible call. These counts are correct. The contradictory analytics expectation in the one-transaction test is separately recorded in §1 Finding 4.
  - Confidence: 100%

- **Additive `completeRun` mock**
  - Status: CONFIRMED CORRECT
  - Evidence: The current run-spine factory exports only `startOrGetActiveRun` and `recordStep` (`src/lib/reviews/__tests__/process-review.test.ts:30-35`). The revision preserves those exact exports and implementations while adding `completeRun: vi.fn()` (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:52-64`). Existing `processReview` uses only `startReviewRun`, whose internals call the preserved start/step exports (`src/lib/reviews/process-review.ts:160-186`); it does not call `completeRun`. The mock change is additive and cannot alter existing test behavior by replacing an existing export.
  - Confidence: 100%

- **Revised live-database verification command**
  - Status: FIX INTRODUCES NEW DEFECT
  - Evidence: The exact file exists at `worker/jobs/zernio/__tests__/zernio-end-to-end.integration.test.ts`, but its own header explicitly says it uses unit-test-style mocking and is “not a real-Postgres test harness” (`worker/jobs/zernio/__tests__/zernio-end-to-end.integration.test.ts:1-14`). It creates a mocked SQL tagged-template function and mocked `sql.begin` (`worker/jobs/zernio/__tests__/zernio-end-to-end.integration.test.ts:19-39`), then mocks the entire `process-review` module (`worker/jobs/zernio/__tests__/zernio-end-to-end.integration.test.ts:42-46`). Its positive ingest test only asserts that the mocked `processReview` was called with normalized identity data (`worker/jobs/zernio/__tests__/zernio-end-to-end.integration.test.ts:96-132`). Consequently, it neither reaches nor verifies the review INSERT being extracted. The intake’s claims that this command needs a provisioned test database and “exercises the refactored INSERT” are factually wrong (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:39-43`, `docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:62-68`).
  - Confidence: 100%

## 5. Appendix (untriaged) — new issues noticed but out of round-2 scope

The contents of this section are explicitly excluded from the verdict below.

None noticed.

## 6. Verdict

VERDICT: REVISE

The revision fixes most round-1 findings, but the design-of-record remains materially narrower than represented, the new one-transaction test cannot pass a correct implementation as written, and the newly designated database verification suite mocks both SQL and `processReview` and never exercises the refactored INSERT.