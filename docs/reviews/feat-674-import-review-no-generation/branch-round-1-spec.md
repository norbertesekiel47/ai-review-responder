# Branch review — round 1, Spec & correctness (#674)

**Scope:** `git diff 6bd45cfe..HEAD` on `feat-674-import-review-no-generation`.
**Contract reviewed against:** `.feature/intake.json` (verified byte-identical to
`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json`).
**Reviewer role:** spec & correctness. Review only — nothing was edited.

## Findings

| severity | file:line | finding |
|---|---|---|
| — | — | *(none at ≥80% confidence)* |

**Verdict: the diff faithfully implements the intake.** Every `invariants` entry
holds, every `edge_cases` entry is handled, all twelve `tests_to_add` titles
exist and each asserts what its title claims, no file falls outside
`allowed_edit_surface`, and `user_visible_behavior: none` is literally true
(`importReview` has zero production callers). The behaviour-neutrality claim for
the `insertNewReviewRow` extraction is verified below and holds.

---

## Evidence run locally

| Check | Result |
|---|---|
| `pnpm vitest run src/lib/reviews/__tests__/process-review.test.ts` | 37 passed (1 file) |
| `pnpm vitest run src/lib/reviews/__tests__/import-review.integration.test.ts` (with `TEST_DATABASE_POOL_URL` exported) | 4 passed — **ran, did not skip** |
| `pnpm typecheck` | clean |
| `pnpm ci:outbox-seam` | passed (15 helper-owned topics) |
| `pnpm ci:live-db-suites` | passed |
| `pnpm ci:static-policy` | passed (1119 files) |
| `pnpm ci:db-imports` | passed (strict) |
| `.feature/gate-status.json` | all 23 checks PASS, including `promised-tests` |
| `git status --porcelain` | clean (no uncommitted drift) |

---

## 1. Intake field-by-field walkthrough

### `goal`

> Add `importReview` … insert-only path that stores a review with sentiment
> classification and a completed `review_ingested` run-spine record, enqueues no
> `generate_response`, and never mutates an existing review row.

`src/lib/reviews/process-review.ts:513-542` implements exactly this: `sql.begin`
→ `insertNewReviewRow` → (on insert) `startReviewRun('review_ingested')` →
`completeRun(tx, runId, 'completed')` → `maybeEnqueueFirstReviewIngested`. On a
zero-row insert it returns `'unchanged'` before any other statement. **PASS**

### `non_goals` — all respected

| Non-goal | Evidence |
|---|---|
| No behaviour change to `processReview`'s other lanes | §2 below (line-by-line) |
| Cross-lane lost-draft race not fixed | `processReview`'s race-loss branch (`process-review.ts:94-122`) is byte-identical to `6bd45cfe`; hazard is documented at `process-review.ts:505-508` |
| No consolidation of `insertImportedReview` | `worker/jobs/zernio/zernio-ingest-shared.ts:364` untouched (not in the diff) |
| No caller wired | `rg importReview src worker scripts` → only the definition + the two test files |
| No consent gating / expiry / cap / list | absent |
| No migration, flag, or env var | `git diff --name-only` shows no `supabase/migrations/` and no env file |
| No PHI screening | absent — and the cited precedent is **accurate**: `worker/jobs/zernio/ZernioBackfillWorker.ts:211-225` (`processUnansweredReview`) calls `detectLikelyPhi` and opens a PHI exception *before* calling `processReview` |

### `user_visible_behavior: ["None. importReview ships with zero callers…"]`

Verified by grep: the only non-test reference to `importReview` anywhere in
`src/`, `worker/`, `scripts/` is its own `export async function` at
`process-review.ts:513`. The only other production-code change is internal
(extraction + a widened private return type). The `CONTEXT.md` addition is a
glossary bullet. **No behaviour appears that the intake did not name. PASS**

### `invariants` — 8/8

1. **No behaviour change for any existing `processReview` caller.** See §2. **PASS**
2. **Invariant #2 — one transaction, no `job_outbox` row on any path.** One
   `sql.begin` (`:519`); the three statements inside are `INSERT INTO reviews`,
   `SELECT account_id FROM businesses`, and the `first_review_ingested` account
   lookup, plus the run-spine's own `agent_runs`/`agent_run_steps` writes.
   `enqueueAnalyticsEvent` writes `analytics_events`, **not** `job_outbox`
   (`src/lib/analytics/enqueue.ts:29-53`) — so the plan's D5 rejection of the
   round-1 "that assertion is vacuous" finding is correct. Proven live by
   `import-review.integration.test.ts:161-175`. **PASS**
3. **Invariant #3 — no `responses` row, no `generate_response`.** No `responses`
   statement exists in `importReview`'s path; `enqueueGenerateResponse` is
   reachable only from `processReview`/`processExistingReview`. I additionally
   swept for an indirect path: every `generate_response` producer in the repo is
   event-driven (`process-review.ts`, the three approval modes,
   `/api/admin/flagged`, `/api/dashboard/past-replies/draft`) — **no poller or
   scheduler sweeps `reviews.status='new'` and enqueues generation**, so an
   imported row inserted with `REVIEW_STATUS.NEW` cannot be picked up and
   drafted by a background loop. **PASS**
4. **Invariant #15 — explicit `Sql` parameter.** `importReview(sql: Sql, …)`;
   `process-review.ts` does not import `@/lib/db/server` (`ci:db-imports`
   passed strict). **PASS**
5. **Sentiment at the write site (`deterministic_star_v1`).**
   `insertNewReviewRow:151` calls `classifySentiment(review.starRating)` and
   binds `score`/`label`/`source`. Live-asserted at
   `import-review.integration.test.ts:132-134` (2★ → `-0.5` / `negative` /
   `deterministic_star_v1`). **PASS**
6. **An import never mutates a row the live lane owns.** Zero-row insert returns
   at `:523-525` before any other statement. No `UPDATE`, no `review_exceptions`,
   no `NOTIFY_ADMIN`, no `SELECT … FOR UPDATE`. **PASS**
7. **Run terminal on commit — can never surface as `stalled`.**
   `completeRun(tx, runId, 'completed')` sets `status='completed'` +
   `ended_at=NOW()` (`run-spine.ts:544-552`), and `deriveRunDisplayState`
   short-circuits `status === 'completed'` *before* the 48h check
   (`src/lib/agents/read.ts:119, 125`). Live-asserted at
   `import-review.integration.test.ts:137-159`. **PASS**

   I checked the two ways this could still go wrong and neither is reachable:
   `startOrGetActiveRun` can return a *joined* run (`created:false`) whose
   completion would be someone else's — impossible here because `subject_id` is
   the freshly-minted `uuidv7` review PK, which no prior run can name. And if
   `startReviewRun` returns `null` (missing `businesses` row) no run is created
   at all, so there is nothing to leave running — the `if (runId)` guard at
   `:534` is correct, not a hole.
8. **Canonical column order, caught mechanically.** The 17 bindings in
   `insertNewReviewRow:161-165` are character-identical to the pre-diff inline
   statement. Guarded twice: positionally by
   `process-review.test.ts:879-912` (the 16-element `params.slice(1)` equality,
   with distinct values for every same-typed neighbour — `'r1'` vs
   `'zernio://loc1/reviews/r1'` vs `'zernio://loc1'`), and by column landing in
   `import-review.integration.test.ts:120-134`. **PASS**

### `edge_cases` — 6/6 handled

| Edge case | Handling |
|---|---|
| Row already exists → `'unchanged'`, zero writes, **even when the hash differs** | `:523-525`. Structurally guaranteed: `importReview` never reads `review_content_hash` at all, so a differing hash cannot reach a branch |
| Concurrent writer wins → `'unchanged'`, no re-read, no fall-through | Same return. `ON CONFLICT … DO NOTHING RETURNING id` yields 0 rows on a race loss (the semantics documented at `zernio-ingest-shared.ts:356-359`), and both cases collapse to one branch. Asserted negatively at `process-review.test.ts:995-1017` (`not.toContain('FOR UPDATE' / 'UPDATE reviews' / 'UPDATE responses' / 'review_exceptions')`) |
| First-ever review fires once; later ones do not re-fire | `maybeEnqueueFirstReviewIngested` `earlier_exists` guard (`:217-234`) + `ON CONFLICT (event_key) DO NOTHING` (`enqueue.ts:52`), keyed per-account via `makeAnalyticsEventKey('first_review_ingested', [accountId])`. The just-inserted row is excluded by `r2.id <> ${reviewId}` |
| Row exists, content changed → left for the live lane | Same zero-write skip; documented at `:486-490` |
| No downstream worker completes an imported run → completes its own | `:534-536` |
| "Successful INSERT then missing `businesses` row" rejected as impossible | Not branched around, not tested; `startReviewRun`'s defensive skip is inherited unchanged. Correct — `reviews.business_id` is a non-null FK |

### `allowed_edit_surface` — no drift

All ten changed files are covered:

| Changed file | Covering entry |
|---|---|
| `src/lib/reviews/process-review.ts` | exact |
| `src/lib/reviews/__tests__/process-review.test.ts` | exact |
| `src/lib/reviews/__tests__/import-review.integration.test.ts` | exact |
| `CONTEXT.md` | exact |
| `docs/superpowers/plans/2026-08-05-674-…md` | `docs/superpowers/plans/**` |
| `docs/superpowers/plans/…-deviations.md` | `docs/superpowers/plans/**` |
| `docs/superpowers/plans/…-handoff.md` | `docs/superpowers/plans/**` |
| `docs/superpowers/plans/…-intake.json` | `docs/superpowers/plans/**` |
| `docs/reviews/…/blast-radius.md` | `docs/reviews/**` |
| `docs/reviews/…/plan-round-{1,2,3}.md` | `docs/reviews/**` |

`docs/superpowers/specs/2026-08-05-consented-review-import-design.md` is listed
but **not** changed — correct per D12 (`main` @ `6bd45cfe` owns it via #681; the
file is present in the worktree and the `CONTEXT.md` bullet's citation of it
resolves). An unused allowance is not drift.

### `tests_to_add` — 12/12 present and substantive

| # | Title | Location | Does it assert its title? |
|---|---|---|---|
| 1 | inserts the review and writes no `job_outbox` row | `process-review.test.ts:841` | Yes — `toHaveBeenCalledTimes(3)` + `not.toContain('job_outbox')`. **Non-vacuous**: `enqueueGenerateResponse` is deliberately *not* mocked in this file (only `db/server`, `analytics/enqueue`, `agents/run-spine` are), so a stray enqueue would emit a real ``tx`INSERT INTO job_outbox` `` into `joinedSql()` *and* break the call count |
| 2 | classifies sentiment at the write site | `:859` | Yes — 1★ fixture, asserts `-1` / `'negative'` / `'deterministic_star_v1'` are among the bound params |
| 3 | records `review_ingested` and completes the run | `:913` | Yes — `startOrGetActiveRun` args, `recordStep({stepKey:'review_ingested'})`, `completeRun(tx,'run-1','completed')` |
| 4 | enqueues `first_review_ingested` for the first review | `:962` | Yes — `earlierExists=false`, asserts the `enqueueAnalyticsEvent` call shape |
| 5 | `'unchanged'` + no writes when the review exists | `:978` | Yes — `toHaveBeenCalledTimes(1)` and all four spine/analytics mocks `not.toHaveBeenCalled()` |
| 6 | `'unchanged'` when a concurrent writer wins | `:995` | Yes — same skip plus four negative SQL assertions pinning "no fall-through to the existing-row state machine" |
| 7 | binds the INSERT params in canonical order | `:879` | Yes — full 16-element positional equality |
| 8 | all work in exactly one transaction | `:940` | Yes — `begin` called once (the mock is re-created per test in `beforeEach`, so the count is per-test) and every spine writer received the same `tx` handle. Correctly uses `earlierExists=false` so the `enqueueAnalyticsEvent` assertion is reachable |
| 9 | stores against the live schema, returns `'new'` | `import-review.integration.test.ts:91` | Yes — 8 column assertions incl. `sentiment_score` |
| 10 | leaves the agent run terminal, not running | `:137` | Yes — `status='completed'`, `ended_at` non-null, and a `agent_run_steps.agent_run_id` join proving the `review_ingested` step |
| 11 | no `job_outbox` row against the live DB | `:161` | Yes — and non-vacuous: `enqueueGenerateResponse` writes `aggregate_id = reviewId` (`job-outbox-helpers.ts:246`), which is exactly what the query filters on |
| 12 | idempotent on a second call | `:177` | Yes — `'unchanged'`, exactly 1 `reviews` row, exactly 1 `agent_runs` row |

### `verification_commands`

`pnpm vitest run src/lib/reviews/__tests__/import-review.integration.test.ts`
— run by me with the URL exported: **4 passed, 0 skipped**. D15's caveat is
accurate (bare `pnpm vitest run <path>` skips because nothing hydrates
`.env.local`), and `scripts/verify-gate.sh:73-79` does export it before running
verification commands, so the gate's PASS is real rather than a silent skip.

### `db_touching: true`, `dependencies_added: []`, `rollback_plan`, `observability`

`db_touching:true` is honest — the new suite genuinely needs a provisioned DB
(the gate ran `db-provision`). No `package.json` change in the diff. No
migration, so the stated rollback (revert one commit, no flag, no data) is
accurate. `observability`: no new log line, consistent with a callerless
function.

---

## 2. Blast-radius caller analysis — is the extraction behaviour-neutral?

**Claim under test:** the three production callers
(`ZernioRecentReviewPoller.ts:195`, `ZernioBackfillWorker.ts:237`,
`ZernioReviewIngestWorker.ts:250`) are unaffected by moving `processReview`'s
inline `INSERT` into `insertNewReviewRow`.

All three consume only `processReview`'s return value (or ignore it) and pass no
new arguments, so the whole question reduces to: **is the new-review branch's
observable behaviour identical?** Four things could have broken it. I checked
each against the pre-diff file (`git show 6bd45cfe:src/lib/reviews/process-review.ts`):

1. **SQL text.** The `INSERT INTO reviews` statement — column list, `VALUES`
   list, binding order, `ON CONFLICT (provider, provider_review_name) DO NOTHING
   RETURNING id` — is character-identical apart from leading indentation.
   Whitespace is not semantic to Postgres, and no consumer in the repo matches
   this statement's exact text (the tests use `toContain`; the CI SQL audits
   `tenant-scope` / `rls-audit` / `reviews-status` all pass).
2. **Statement order and count.** No statement was added, removed, or reordered.
   `classifySentiment` still runs immediately before the INSERT, just inside the
   helper. The positional-mock premise the whole existing suite depends on is
   intact — the unmodified `describe('processReview')` block passes 29/29, and
   the diff hunk for that block is purely additive at EOF (`@@ -790,3 +791,230 @@`),
   so it is mechanically byte-for-byte unchanged.
3. **Return-value plumbing.** `inserted.count` became `insertedCount`; the
   `> 0` predicate is unchanged. The helper returns `count`, not
   `inserted[0].id`, and the caller keeps using the locally minted `reviewId` —
   identical to before, and correct, since on a winning insert the two are the
   same value.
4. **The orphaned destructure (D14).** `const { review, identity, contentHash }`
   narrowed to `const { identity }`. `review`/`contentHash` had exactly one
   remaining reader in that scope — the moved INSERT — and
   `processExistingReview` already destructured `monitored` itself
   (`:263`, unchanged from `6bd45cfe`). `tsc --noEmit` passing is proof there are
   no other readers. Behaviour-neutral.

One signature did change: `startReviewRun` now returns `Promise<string | null>`
instead of `Promise<void>`. Both `processReview` call sites (`:70`, `:325`)
discard the value, and the function is module-private. The `!biz` defensive skip
now returns `null` instead of `undefined` — unobservable to those callers.

**Additional cross-lane check the typechecker cannot do:** I verified that the
lock order `importReview` takes is the same as `processReview`'s
(`reviews` row → `agent_runs` row via `appendRunStep`'s `SELECT … FOR UPDATE`),
so wiring the import in #675 cannot introduce a deadlock cycle against the live
lane. I also checked that `reviews` has only two unique indexes
(`reviews_pkey`, `unique_provider_review` on `(provider, provider_review_name)`
— confirmed against the provisioned test DB), so the `ON CONFLICT` target is the
*only* constraint a duplicate import can hit; there is no second unique index
that would raise `23505` instead of returning `'unchanged'`.

**Conclusion: the behaviour-neutrality claim holds.**

## 3. D4 — does the code match the documented hazard?

D4 describes: `importReview` wins the identity race; the concurrent live-ingest
`processReview` finds no row on its `SELECT FOR UPDATE`, gets 0 rows from its
own INSERT, re-reads the winner, hits `existingHash === contentHash`, and returns
`'unchanged'` without enqueueing.

Traced against the code: `process-review.ts:96-122` performs exactly that
re-read and hands the winner to `processExistingReview`, whose first branch
(`:266-277`) returns `'unchanged'` when the hashes match and the status is not
`'deleted'`. **The code matches D4 precisely.** The docstring at `:505-508`
records it accurately and names #675 as the owner. Reported as documented, not
as a new finding, per instruction.

Two adjacent facts worth having on the record for #675:

- The hazard bites **only when the two lanes compute the same `contentHash`**.
  If they differ, the live lane takes the content-changed path and *does* enqueue
  (origin lane `live_ingest_update`, which is ineligible for auto-approval — so
  no invariant-#3 exposure either way).
- If the review row is `status='deleted'` when the import runs, the import's
  zero-write skip leaves it deleted; the live lane's resurrection branch
  (`:267-275`) still owns that. Consistent with "insert-only".

## 4. Low-confidence appendix (deliberately **not** in the findings table)

None of these meets the ≥80% bar; several are explicitly out of scope. Recorded
so the owner can see they were considered and dismissed rather than missed.

1. **`read.ts:127` line cite is one off.** The comments at
   `process-review.test.ts:922` and in the intake cite
   `src/lib/agents/read.ts:127` for the stalled derivation; `return 'stalled'` is
   line 126 and 127 is the closing brace. D3's own cite (`read.ts:119-131`) is
   right. Cosmetic; the production comment at `process-review.ts:501` wisely
   carries no line number.
2. **No `importReview`-specific assertion of the `first_review_ingested`
   *negative*.** Four `importReview` tests run with `earlierExists=true` but none
   asserts `enqueueAnalyticsEvent` was *not* called. The guard lives in the
   shared `maybeEnqueueFirstReviewIngested`, whose `earlier_exists:true` branch
   *is* covered by the existing `processReview` tests
   (`process-review.test.ts:663, 746`), so the behaviour is covered at the owner
   of the logic. Not worth a new test.
3. **The integration suite is order-dependent.** Tests 2–4 read state created by
   test 1; `vitest -t 'terminal'` alone would fail on the undefined row. The
   cited precedent `src/lib/agents/__tests__/read.integration.test.ts` has the
   same shape, and the file is serialized in vitest's `integration` project, so
   this is house style rather than a defect.
4. **The new suite omits `assertSchemaReady`.** CLAUDE.md names it as the
   live-DB convention, but adoption is 29 of 72 integration suites — the cited
   precedent (`read.integration.test.ts`) omits it too, and
   `ci:live-db-suites` enforces only naming and no-runtime-DDL. Genuinely
   optional today; worth raising as a *repo-wide* convention question, not as a
   defect in this branch.
5. **Test 12 re-imports an identical fixture.** A second call with a *changed*
   `contentHash` would be the stronger live proof of "existing row ⇒ zero writes
   even when content differs". Low value: `importReview` never reads the hash, so
   the property is structural rather than conditional.
6. **Downstream consequence of `status='new'` + no `responses` row — for #675/#676,
   not for this diff.** Once the import has a caller, imported reviews will count
   as unanswered in `worker/jobs/MonthlyImpactWorker.ts:168-169`
   (`reviews LEFT JOIN responses`) and in the `src/lib/kpi/*` response-rate and
   time-to-respond KPIs. Deliberately out of scope here (`non_goals` assigns the
   reviews list and its surfaces to #676–#679), and inert while the function is
   callerless — but it is the same class of "imported rows look like un-drafted
   live rows" that D3 caught for run display state, and it is worth a comment on
   #675 alongside D4.
7. **`importReview` is an unused export.** `ci:fallow` (developer-facing, gates
   nothing) will report it as dead code until #675 wires it. Expected and
   accepted by the intake's `user_visible_behavior`.
