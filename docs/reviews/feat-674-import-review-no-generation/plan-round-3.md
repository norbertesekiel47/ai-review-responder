# Adversarial Review: Ticket #674 Plan — Round 3 (Final Verification)

## 1. One-transaction test self-consistency

- **Fixed test check**: Status: FIXED. The test now calls `mockInsertWon(false)` and explains why (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:255-260`). A correct implementation inserts the review, starts and completes the run, queries `earlier_exists`, reaches `enqueueAnalyticsEvent` when false, and returns `'new'` (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:500-528`; `src/lib/reviews/process-review.ts:188-225`). Consequently, the assertions for one `sql.begin` and the same `tx` passed to all spine and analytics writers are internally consistent (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:262-275`). Confidence: 100%.

- **Other mockInsertWon() calls audit**:
  - `importReview inserts the review and writes no job_outbox row`: default `true` is consistent; the test makes no analytics-enqueue assertion (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:156-172`). Confidence: 100%.
  - `importReview classifies sentiment at the write site`: default `true` is consistent; only INSERT SQL and parameters are inspected (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:174-192`). Confidence: 100%.
  - `importReview binds the review INSERT parameters in the canonical order`: default `true` is consistent; only the first transaction call is inspected (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:194-226`). Confidence: 100%.
  - `importReview records the review_ingested run-spine step and completes the run`: default `true` is consistent; its assertions concern only spine calls (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:228-253`). Confidence: 100%.
  - `importReview does all of its work in exactly one transaction`: explicit `false` is required and now consistent with its analytics assertion (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:255-275`). Confidence: 100%.
  - `importReview enqueues first_review_ingested for the account's first review`: explicit `false` correctly reaches the analytics enqueue (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:277-291`). Confidence: 100%.
  - `importReview returns unchanged and performs no writes when the review already exists`: it does not call `mockInsertWon`; the explicit zero-row INSERT result correctly causes the early return and no downstream calls (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:293-308`). Confidence: 100%.
  - `importReview returns unchanged when a concurrent writer wins the insert race`: it also supplies an explicit zero-row INSERT result, consistent with every skip-path assertion (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:310-334`). Confidence: 100%.

## 2. New live-DB suite (Task 4) — detailed verification

- **1. Live-DB conventions**
  - Status: CONCERN
  - Evidence: The planned path ends exactly in `.integration.test.ts`, imports `describeWithDb`, and contains no migration import or `.unsafe()` execution (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:591-603`, `docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:615-675`). That places it in the serialized integration project (`vitest.config.ts:16-18`, `vitest.config.ts:82-91`). The audit detects `TEST_DATABASE_POOL_URL`/`describeWithDb`, enforces the suffix, and rejects runtime migration SQL only when both a migration-directory marker and `.unsafe()` are present (`scripts/ci/live-db-suites-audit.ts:91-145`); the planned file satisfies those rules.
    
    However, Task 4 runs `pnpm ci:live-db-suites` before committing the newly created file (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:814-827`), while the audit enumerates only `git ls-files` output (`scripts/ci/live-db-suites-audit.ts:148-158`). At that point the untracked new suite will not be inspected, so the planned PASS is vacuous unless the file is staged first or the audit is rerun after commit.
  - Confidence: 99%

- **2. Helper API signatures**
  - Status: PASS
  - Evidence: `describeWithDb` supports exactly `(name, options, factory)`, with optional `timeout` (`src/__tests__/helpers/describe-with-db.ts:18-41`), matching the planned call (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:675`). `seedTenantAccount` accepts `(db: Sql, overrides?)` and returns `{ userId, accountId, ownerEmail }` (`src/lib/shared/__tests__/live-db-tenant.ts:22-68`), matching lines 678-681. `cleanupTenantAccount` accepts `(db, Pick<TenantSeed, 'userId' | 'accountId'>)` (`src/lib/shared/__tests__/live-db-tenant.ts:71-84`), so passing the complete `tenant` object at plan line 703 is structurally valid.
  - Confidence: 100%

- **3. Database fixtures and `MonitoredReview` shape**
  - Status: PASS
  - Evidence: The current no-default required business columns are `id`, `name`, `owner_name`, `owner_email`, and—after migration 034—`account_id` (`supabase/migrations/001_initial_schema.sql:63-108`; `supabase/migrations/002_prompt2_fixes.sql:30-34`; `supabase/migrations/034_multi_location_schema.sql:273-282`). Task 4 supplies all five; it also supplies `subscription_status`, although that column has a default (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:683-690`). Later non-null business fields have defaults, including `place_id_verified`, summary flags, `tracked_keywords`, `owner_email_bounced`, and `is_primary` (`supabase/migrations/007_place_id_verification.sql:1-5`; `supabase/migrations/014_retention_expansion.sql:92-121`; `supabase/migrations/017_sprint6_scale.sql:46-48`; `supabase/migrations/034_multi_location_schema.sql:87-97`).
    
    The required no-default review columns are `id`, `business_id`, `provider_review_id`, `provider_review_name`, and `provider_location_name`; `provider` is non-null but has a default (`supabase/migrations/001_initial_schema.sql:155-182`; `supabase/migrations/002_prompt2_fixes.sql:30-35`). The planned `insertNewReviewRow` supplies all of them, plus the content and sentiment fields (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:385-410`). Later sentiment and triage columns are nullable (`supabase/migrations/052_reviews_sentiment.sql:8-27`; `supabase/migrations/072_review_triage.sql:17-46`).
    
    The fixture exactly supplies every field required by `NormalizedReview`, `ReviewIdentity`, and `MonitoredReview` (`src/lib/reviews/types.ts:5-13`, `src/lib/reviews/types.ts:40-58`; `docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:654-672`). The `as MonitoredReview` assertion is unnecessary. Although it papers over normal return-expression structural and excess-property checking—for example, it could allow a future fixture to omit `providerReviewName` or hide a misspelled extra property—the current literal has no mismatch.
  - Confidence: 99%

- **4. Shared-state test ordering**
  - Status: PASS
  - Evidence: The integration project disables file parallelism and does not enable test shuffling (`vitest.config.ts:82-91`). The installed Vitest configuration documents `sequence.shuffle` and `sequence.concurrent` as false by default (`node_modules/vitest/dist/chunks/cac.BuBILSID.js:949-962`). All four blocks use ordinary `it`, not `it.concurrent`, and are declared in the intended order: create, inspect run, inspect outbox, then re-import (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:708-800`). The final one-row/one-run assertions therefore legitimately depend on the first test having created exactly one review and run; the middle two tests are read-only.
  - Confidence: 98%

- **5. Referenced database column names**
  - Status: FAIL
  - Evidence: The review columns queried by the first test exist in the base schema or sentiment migration (`supabase/migrations/001_initial_schema.sql:155-182`; `supabase/migrations/052_reviews_sentiment.sql:8-11`). `agent_runs.account_id`, `kind`, `status`, and `ended_at` also exist (`supabase/migrations/071_agent_run_spine.sql:15-36`), and `analytics_events.account_id` exists (`supabase/migrations/046_analytics_events.sql:6-39`).
    
    But `agent_run_steps` has `agent_run_id`, not `run_id` (`supabase/migrations/071_agent_run_spine.sql:49-62`; the production writer also uses `agent_run_id` at `src/lib/agents/run-spine.ts:476-485`). Task 4 incorrectly uses `run_id` both in `afterAll` and in the second test (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:697-699`, `docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:761-764`). The second test will fail with “column run_id does not exist,” and cleanup will fail on the same error before deleting rows or closing the database connection.
  - Confidence: 100%

- **6. Cleanup foreign-key order**
  - Status: PASS
  - Evidence: Ignoring the `run_id` spelling failure already reported in check 5, the intended deletion order is FK-safe (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:693-705`). `agent_run_steps.agent_run_id` references `agent_runs` with `ON DELETE CASCADE`, so deleting steps before runs is safe (`supabase/migrations/071_agent_run_spine.sql:49-62`). Runs reference accounts and businesses with cascading deletion (`supabase/migrations/071_agent_run_spine.sql:15-18`). Reviews reference businesses with cascading deletion, and responses reference reviews and businesses with cascading deletion (`supabase/migrations/001_initial_schema.sql:155-158`, `supabase/migrations/001_initial_schema.sql:187-191`). Analytics references accounts/businesses with `ON DELETE SET NULL`, and is deleted first anyway (`supabase/migrations/046_analytics_events.sql:25-30`). Businesses are deleted before their account, satisfying the restrictive business-to-account FK (`supabase/migrations/034_multi_location_schema.sql:285-296`). Finally, the account/user pair is deleted under deferred circular constraints by the shared cleanup helper (`src/lib/shared/__tests__/live-db-tenant.ts:71-84`; `supabase/migrations/036_defer_circular_fks.sql:1-13`).
  - Confidence: 99%

- **7. Two-star sentiment**
  - Status: CONCERN
  - Evidence: `classifySentiment(2)` clamps to `2`, computes `(2 - 3) / 2 = -0.5`, and labels it `negative`; the source is `deterministic_star_v1` (`src/lib/reviews/sentiment.ts:15-33`). The fixture uses two stars, and its label/source assertions are correct (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:654-672`, `docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:742-744`). However, the live query neither selects nor asserts `sentiment_score` (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:713-744`). It therefore does not verify the expected `-0.5` score, despite claiming the live test proves every binding landed correctly.
  - Confidence: 100%

## 3. Provenance-of-decisions table accuracy

| Provenance-table row (paraphrased) | Attribution claimed (spec / ticket decision) | Verified? (yes/no/misattributed) | Evidence |
|---|---|---|---|
| Insert-and-stop path; sentiment at write site; nothing auto-drafted | spec | yes | §6.2 says inventory storage needs “a path that inserts and stops” and that sentiment remains classified at the write site (`docs/superpowers/specs/2026-08-05-consented-review-import-design.md:184-189`). D2 explicitly says the import stores reviews and writes no replies (`docs/superpowers/specs/2026-08-05-consented-review-import-design.md:35-43`), reinforced by the non-goal against any auto-generation (`docs/superpowers/specs/2026-08-05-consented-review-import-design.md:231-235`). |
| Separate `importReview` entry point instead of a flag | ticket decision | yes | The spec requires a path but names no API or flag (`docs/superpowers/specs/2026-08-05-consented-review-import-design.md:184-189`). A separate entry point does not conflict with it. |
| Existing row means zero writes and never enters update state machine | ticket decision | yes | The spec only states that already-live reviews dedupe by provider identity via `ON CONFLICT` without duplicates (`docs/superpowers/specs/2026-08-05-consented-review-import-design.md:217-227`). It neither mandates an update nor contradicts a zero-write skip. |
| `'new'`/`'unchanged'` return contract; race collapses to unchanged | ticket decision | yes | The spec contains no function return contract or concurrency-race result; §6.2 only specifies insert-and-stop behavior (`docs/superpowers/specs/2026-08-05-consented-review-import-design.md:184-189`). |
| No `SELECT … FOR UPDATE` probe | ticket decision | yes | The spec contains no lock-policy requirement. Its only persistence-level concurrency statement is identity deduplication through `ON CONFLICT` (`docs/superpowers/specs/2026-08-05-consented-review-import-design.md:217-227`), which does not require a preliminary lock. |
| Run spine written and completed in the insert transaction | ticket decision | yes | The spec contains no `agent_runs`, run-spine, or terminal-status requirement (`docs/superpowers/specs/2026-08-05-consented-review-import-design.md:172-190`). Completing the attribution run does not create a reply or contradict insert-and-stop. |
| `first_review_ingested` analytics fires from import | ticket decision | yes | The spec contains no analytics-event policy. An analytics event is not a reply or draft and therefore does not contradict D2 (`docs/superpowers/specs/2026-08-05-consented-review-import-design.md:35-43`). |
| Cross-lane race fix deferred to #675 | ticket decision | yes | The spec requires that new reviews continue being handled automatically (`docs/superpowers/specs/2026-08-05-consented-review-import-design.md:101-110`) but does not prescribe ticket sequencing. The table accurately attributes the deferral to this ticket rather than the spec; #674 ships the entry point with no caller, so the deferral itself does not contradict current spec-visible behavior. The fix-or-defer decision was not re-argued. |

## 4. Appendix (untriaged) — new issues noticed but out of round-3 scope

These observations are excluded from the verdict below.

- The worktree’s actual HEAD was `94ba5522`, not the stated `d1f4e184`. `d1f4e184` is its immediate parent; the only intervening change adds a handoff document, with no changes to the reviewed plan or intake.

## 5. Verdict

VERDICT: REVISE

The Task 1 fix is now self-consistent, and the provenance table is accurate. The new live-DB suite nevertheless cannot run successfully because both its run-step assertion and cleanup reference the nonexistent `agent_run_steps.run_id` column instead of `agent_run_id`; it also omits the promised `sentiment_score = -0.5` verification. This is a concrete schema error in the round’s load-bearing suite, not a stylistic concern.