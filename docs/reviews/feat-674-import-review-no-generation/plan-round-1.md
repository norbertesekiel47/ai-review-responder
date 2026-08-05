# Adversarial Review: Ticket #674 Plan — Round 1

## 1. Primary finding: can the eval pass while the feature is wrong?

Yes. All seven proposed tests can pass while production behavior is wrong. The suite mocks PostgreSQL, the run spine, and analytics; it therefore proves only selected top-level calls, not persisted state, transaction atomicity, concurrency, or the complete absence of downstream work.

- **Missing test 1: Exact persisted review row**
  - Failure mode: The INSERT can be syntactically invalid, violate a constraint, bind same-typed fields to the wrong columns, or persist incorrect identity/content/status data while every positional mock remains green.
  - Proposed test: `importReview persists every MonitoredReview field in the correct column`. Against PostgreSQL, use distinctive values and assert exact `business_id`, provider identity/name/location, Google name, reviewer, rating, text, date, language, hash, `status='new'`, sentiment, and timestamps.
  - Which plan claim it falsifies: “stores a review with sentiment classification” and “The SQL is moved verbatim… do not reorder columns” (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:5,268-305`).
  - Confidence: 99%

- **Missing test 2: Real existing-row immutability**
  - Failure mode: A bare INSERT, wrong conflict target, or `ON CONFLICT … DO UPDATE` can mutate or reject an existing review even though the mock is manually told to return `count=0`. `DO UPDATE` would not be caught by Test 6’s search for the distinct string `UPDATE reviews`.
  - Proposed test: `importReview leaves an existing review and all child rows byte-for-byte unchanged`. Seed a review with different content and sentiment plus response/exception rows; call import; assert `'unchanged'`, unchanged seeded rows, and no new run, step, analytics, response, exception, or outbox row.
  - Which plan claim it falsifies: “An existing review row is left completely untouched” (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:346-357`) and intake invariant “an existing row means zero writes” (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:23`).
  - Confidence: 99%

- **Missing test 3: Two real concurrent imports**
  - Failure mode: The fake “race” supplies the same zero-row mock as the already-existing case; it cannot expose blocking, constraint inference, duplicate side effects, or a transaction error under two writers.
  - Proposed test: `two concurrent importReview calls produce exactly one import`. Use two database connections and a barrier; assert results are exactly one `'new'` and one `'unchanged'`, one review, one import run/step, at most one analytics fact, zero responses, and zero outbox rows.
  - Which plan claim it falsifies: “Concurrent writer wins the ON CONFLICT race → return `'unchanged'`” (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:27`).
  - Confidence: 99%

- **Missing test 4: Import must not suppress live-ingest generation**
  - Failure mode: If import wins the unique-key race, a same-content `processReview` loser re-reads the imported row and returns `'unchanged'`; no `generate_response` is ever created. That changes live-ingest behavior.
  - Proposed test: `importReview winning the provider-identity race preserves the live-ingest generation obligation`. Force import to commit first, then let `processReview` continue for identical content; assert one review and exactly one `generate_response` outbox row.
  - Which plan claim it falsifies: “No behaviour change for any existing processReview caller” (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:18`) and “the live-ingest lane… drafts a reply for every new review” (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:19`).
  - Confidence: 99%

- **Missing test 5: Import run terminates**
  - Failure mode: The proposed path starts a `review_handler` run and records a step but never calls `completeRun`. It remains `running`; with no response to put it into `waiting_on_owner`, it displays as `stalled` after 48 hours (`src/lib/agents/read.ts:25-38,120-129`).
  - Proposed test: `importReview leaves no running review_handler run after it returns`. Assert the run is terminal with `ended_at` populated—or that no run is created if the intended contract is changed.
  - Which plan claim it falsifies: The observability claim that the run and `review_ingested` step are valid proof of a completed import (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:60-63`) and “insert and stop” (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:338-344`).
  - Confidence: 99%

- **Missing test 6: Later live activity gets a fresh run**
  - Failure mode: A later changed-content live ingest reuses the import’s still-running run because `startOrGetActiveRun` returns the existing active run (`src/lib/agents/run-spine.ts:107-147`). The live `review_updated` step and downstream work inherit the import run/correlation.
  - Proposed test: `a live update after import starts a distinct review_handler run`. Import with correlation A, then process changed content with correlation B; assert the import run is terminal and the live update belongs to a new run carrying B.
  - Which plan claim it falsifies: “The live-ingest, update, and regenerate lanes are unaffected” (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:18`).
  - Confidence: 98%

- **Missing test 7: Exactly one physical transaction**
  - Failure mode: The implementation can split the review insert and instrumentation across two `sql.begin` calls. The harness supplies the same `tx` mock to every begin and never asserts begin count, so the same three positional calls still pass.
  - Proposed test: `importReview opens exactly one transaction and passes that transaction to every writer`. Return a distinct tx per `begin`, assert `begin` is called once, and assert insertion, run spine, and analytics share that tx.
  - Which plan claim it falsifies: “review insert and its run-spine + analytics writes happen in ONE sql.begin transaction” (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:19`).
  - Confidence: 99%

- **Missing test 8: Rollback after late failure**
  - Failure mode: Run-spine or analytics failure can leave a committed review or partial spine if work is split, errors are swallowed, or a collaborator receives the wrong client. The callback mock cannot observe rollback.
  - Proposed test: `instrumentation failure rolls back the complete import`. Table-drive failures from `startOrGetActiveRun`, `recordStep`, and `enqueueAnalyticsEvent`; assert rejection and zero persisted review/run/step/event/outbox rows.
  - Which plan claim it falsifies: The same one-transaction invariant (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:19`) and the run-spine contract that a spine failure fails the state change (`src/lib/agents/run-spine.ts:5-7`).
  - Confidence: 99%

- **Missing test 9: Inserted-ID continuity**
  - Failure mode: `insertNewReviewRow` can ignore its `reviewId` argument and generate a second UUID. All tests still pass: the existing process test compares run subject to outbox payload, not to the INSERT ID, and proposed Tests 3–4 omit `subjectId` and analytics `properties.review_id`.
  - Proposed test: `the persisted review ID is the run subject and analytics review ID`. Capture/query the INSERT ID and assert equality with `startOrGetActiveRun.subjectId`, analytics `properties.review_id`, and—in `processReview`—the generation payload’s `review_id`.
  - Which plan claim it falsifies: Behavior-neutrality inferred from identical transaction call count/order (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:309-328`).
  - Confidence: 99%

- **Missing test 10: Exact processReview extraction parity**
  - Failure mode: A concrete extraction edit can swap `${identity.providerReviewId}` and `${identity.providerReviewName}` in the VALUES list. Both are strings; call count/order remains identical; all current and proposed tests pass; production identity and dedup behavior change.
  - Proposed test: `processReview extraction preserves the complete ordered INSERT binding`. Execute the pre/post extraction path against PostgreSQL with distinctive fields and compare the persisted row, or snapshot the complete template plus ordered bindings before implementation.
  - Which plan claim it falsifies: “SQL is moved verbatim” and “no behaviour change for any existing caller” (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:268-320`).
  - Confidence: 100%

- **Missing test 11: Durable absence of responses and outbox work**
  - Failure mode: The string search sees only direct `tx.mock.calls` and the unmocked generation helper. SQL issued by mocked seams is invisible, and the tests never query `responses` or `job_outbox`.
  - Proposed test: `successful import creates inventory only`. With real run-spine and analytics helpers, test at least a first-account review, a later review, and a 1-star review; assert the review and analytics facts exist but no `responses` or `job_outbox` row exists for any imported review.
  - Which plan claim it falsifies: “writes no job_outbox row at all” and “produces no responses row” (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:19-20`).
  - Confidence: 99%

- **Missing test 12: Complete first-review analytics contract**
  - Failure mode: Analytics can fire for every import, fire twice, carry the wrong deterministic key/distinct ID, or reference the wrong review. Test 4 checks only a partial positive call; none of the default `earlierExists=true` tests asserts that analytics was not called.
  - Proposed test: `first_review_ingested fires exactly once per account with the inserted review ID`. Import two distinct reviews for businesses in the same account; assert one event total, exact `eventKey`, `distinctId`, account/business IDs, and `properties.review_id`, with no call for the later review.
  - Which plan claim it falsifies: “first_review_ingested fires once; later reviews in the same import do not re-fire” (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:29`).
  - Confidence: 99%

- **Missing test 13: Missing business follows the actual FK contract**
  - Failure mode: Proposed Test 7 fabricates a state PostgreSQL cannot produce: a successful review INSERT followed by a missing `businesses` row. `reviews.business_id` is a non-null FK, and the INSERT’s key-share lock prevents the business disappearing mid-transaction.
  - Proposed test: `importReview rejects atomically for a nonexistent businessId`. Use a valid but absent UUID; assert FK rejection and no persisted review/run/event.
  - Which plan claim it falsifies: “businesses row missing… run-spine write is skipped rather than failing the insert” (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:28`; `docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:222-236`).
  - Confidence: 100%

- **Missing test 14: Complete existing-lane characterization**
  - Failure mode: The hard no-change requirement exceeds current coverage. The suite lacks direct characterization of content-change handling for `pending_approval`, the generic `approved`/`edited` supersede branch, and a race-loss winner with changed content. Accidental edits to those branches can pass all current and seven new tests.
  - Proposed test: `processReview preserves every active-response transition through extraction`. Table-drive `pending_approval`, `approved`, and `edited`, plus a changed-content insert-race loser; assert review update, response transition, next version, run step, and the exact generation origin lane.
  - Which plan claim it falsifies: “live-ingest, update, and regenerate lanes are unaffected” (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:18`).
  - Confidence: 96%

## 2. Answers to the five specific interrogation questions

1. **What can the mocked harness never observe, and what matters here?**

   It cannot observe PostgreSQL parsing/planning, parameter-to-column mapping, casts, CHECK/FK/unique constraints, real `ON CONFLICT` behavior, defaults/timestamps, commit/rollback, connection identity, lock acquisition, blocking, isolation snapshots, deadlocks, or actual concurrent results. It also cannot see SQL inside mocked run-spine and analytics seams (`src/lib/reviews/__tests__/process-review.test.ts:16-35`).

   For this change, the material blind spots are exact row persistence, real `DO NOTHING` immutability, identity uniqueness, transaction atomicity, import/import and import/live races, ID coherence, run lifecycle, and durable absence of `responses`/`job_outbox`. The database constraints being relied upon are real: `reviews.business_id` is an FK and provider identity is unique at `supabase/migrations/001_initial_schema.sql:155-182`.

2. **Is identical tx call count/order sufficient for behavior-neutral extraction?**

   No. Swap the two same-typed bindings:

   ```typescript
   ${identity.providerReviewName}, ${identity.providerReviewId}
   ```

   where the unchanged SQL columns remain `provider_review_id, provider_review_name`. The tagged-template call still occurs at the same position, with the same count and SQL shape. Current tests assert sentiment and Google-name containment but not ordered provider bindings (`src/lib/reviews/__tests__/process-review.test.ts:521-595`); the seven new tests do not inspect them either. Production identity storage and dedup behavior change despite every test passing.

3. **Does `not.toContain('job_outbox')` guarantee no outbox write?**

   No. It guards direct tx calls and the real, unmocked `enqueueGenerateResponse`, whose tagged SQL is visible at `src/lib/shared/job-outbox-helpers.ts:222-250`. But `enqueueAnalyticsEvent` is replaced with a no-op mock at `src/lib/reviews/__tests__/process-review.test.ts:26-28`; its production SQL is therefore absent from `joinedSql()`. Today it writes `analytics_events`, not outbox (`src/lib/analytics/enqueue.ts:20-54`), but if that helper or a transitive dependency wrote `job_outbox`, the assertion would remain green. A durable database assertion with real collaborators is required.

4. **Are Tests 5 and 6 duplicates?**

   They execute the same mocked `count=0` path and do not simulate different states or concurrency. Test 6 nevertheless pins something Test 5 does not: Test 5 proves `'unchanged'`, one top-level tx call, and no mocked run/analytics calls; it never establishes what that one statement was. Test 6 excludes `FOR UPDATE`, direct `UPDATE reviews`, `UPDATE responses`, and `review_exceptions` (`docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:196-220`). Its `review_updated` assertion is redundant because Test 5 already requires no `recordStep` call at all. Test 6 still does not assert `ON CONFLICT … DO NOTHING`, exercise PostgreSQL, or prove a race.

5. **Does omitting the import-side `FOR UPDATE` create a wrong concurrency outcome?**

   The established production order is review first, response second:

   - `processReview`: review lock at `src/lib/reviews/process-review.ts:47-59`, response lock at `src/lib/reviews/process-review.ts:310-327`.
   - Failed hook: documented order at `worker/jobs/publisher/failed-hook.ts:270-278`, review lock at `worker/jobs/publisher/failed-hook.ts:307-312`, response lock at `worker/jobs/publisher/failed-hook.ts:324-330`.
   - Edit publisher: reversal is identified as a deadlock risk at `worker/jobs/publisher/edit-publish.ts:199-205`, followed by the response lock at `worker/jobs/publisher/edit-publish.ts:215-229`.

   For an already-existing review, import’s `DO NOTHING` path neither mutates the review nor reaches responses, so it does not create a duplicate, lost update, wrong sentiment, or orphaned response. Publisher concurrency is also safe because a response cannot predate its review FK (`supabase/migrations/001_initial_schema.sql:187-191`).

   There is, however, a wrong cross-lane outcome:

   1. Import inserts and commits the previously absent identity.
   2. Concurrent live ingest loses its INSERT and re-reads the import winner (`src/lib/reviews/process-review.ts:110-138`).
   3. If content hashes match, `processExistingReview` returns `'unchanged'` (`src/lib/reviews/process-review.ts:244-254`).
   4. No `generate_response` is ever created.

   This is a lost live-ingest generation obligation. Restoring an initial `SELECT … FOR UPDATE` to import would not fix it: a missing-row probe locks no row. The plan needs an explicit cross-lane ownership/provenance rule, not merely a lock probe.

## 3. Cited-artifact check

| Citation | Verified? (yes/no/stale) | What you actually found (with file:line) |
|---|---|---|
| Plan file | Yes, but untracked | `docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md` exists with 459 lines. `git status --short` reports it as untracked. |
| Locked intake | Yes | `docs/superpowers/plans/feat-674-import-review-no-generation-intake.json` exists with 66 lines. |
| `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §6.2 | **No / stale dependency** | The file does not exist on disk or in HEAD. It exists only on local branch `docs/668-consented-import-rollout-posture` at commit `bcde4da9`, which is not an ancestor of this HEAD. |
| Design §6.2 content | **Unverifiable in current worktree** | Historical `bcde4da9:docs/superpowers/specs/2026-08-05-consented-review-import-design.md:187-192` says only: `processReview` couples insert and generation; inventory needs a path that inserts and stops; sentiment remains at the write site. It does not specify the `importReview` name, run spine, analytics, conflict semantics, zero outbox rows, or lock policy. Historical D2 at lines 35-48 says import stores reviews and writes no replies. |
| `src/lib/reviews/process-review.ts:61-108` | Yes | Lines 61-82 contain UUID, sentiment, and `INSERT … ON CONFLICT … DO NOTHING RETURNING id`; lines 84-108 start the run, enqueue generation, check first-review analytics, and return `'new'`. |
| `src/lib/reviews/process-review.ts:63-84` | Yes | UUID at 63, sentiment at 64, INSERT at 66-82, branch at 84. |
| SQL “moved verbatim from lines 66-82” | Yes as a current-source location | The cited INSERT is exactly at `src/lib/reviews/process-review.ts:66-82`. Whether implementation later moves it verbatim is prospective. |
| Agent-run banner at line 153 | Yes | `src/lib/reviews/process-review.ts:153` is the Agent run spine banner. |
| `src/lib/reviews/process-review.ts:160-186` | Yes | `startReviewRun`; business lookup at 169-171, defensive return at 172-175, run/step calls at 177-185. |
| `src/lib/reviews/process-review.ts:188-226` | Yes | `maybeEnqueueFirstReviewIngested`; account-scoped lookup at 195-210, negative guard at 212, enqueue at 214-225. |
| `src/lib/reviews/__tests__/process-review.test.ts:1-125` | Yes | Mock declarations at 16-35, fixtures at 46-80, positional tx harness at 84-107, first test at 109-125. |
| Import at test line 38 | Yes | `src/lib/reviews/__tests__/process-review.test.ts:38` is `import { processReview } from '../process-review';`. |
| `enqueueGenerateResponse` is not mocked | Yes | The only module mocks are DB, analytics, and run spine at `src/lib/reviews/__tests__/process-review.test.ts:16-35`. The real generation helper performs its tagged-template outbox INSERT at `src/lib/shared/job-outbox-helpers.ts:222-250`. |
| `enqueueAnalyticsEvent` behavior | Yes; exposes test blind spot | It is mocked at `src/lib/reviews/__tests__/process-review.test.ts:26-28`; production writes `analytics_events` at `src/lib/analytics/enqueue.ts:20-54`. Its SQL and tx-call count are invisible to this suite. |
| `classifySentiment(1)` exact result | Yes | Source constant at `src/lib/reviews/sentiment.ts:15`; score and label calculation at 28-33 yield `{ score: -1, label: 'negative', source: 'deterministic_star_v1' }`. |
| `worker/jobs/zernio/zernio-ingest-shared.ts:364-409` | Yes | Exact private `insertImportedReview`; PHI check at 371-375, hash/sentiment at 377-382, INSERT at 384-406, ID return at 408. |
| `insertImportedReview` uses `DO UPDATE`, external timestamp, no run spine | Yes | `external_reply_ingested_at` at `worker/jobs/zernio/zernio-ingest-shared.ts:389-401`; conflict update at 403-405. No run-spine symbol occurs in the file. |
| `insertImportedReview` has a live caller | Yes | Called at `worker/jobs/zernio/zernio-ingest-shared.ts:227`, followed by response insertion at 242-248. |
| `ZernioBackfillWorker.processUnansweredReview` | **Stale naming** | No class method has that qualified name. It is a nested function inside `handleZernioBackfill` at `worker/jobs/zernio/ZernioBackfillWorker.ts:210-246`; PHI screening is 211-225, normalization 227-236, and `processReview` call 237-240. |
| `CONTEXT.md` is a flat `- **Term**: definition` glossary | **No / stale** | It has an H1 at `CONTEXT.md:1`, H2 sections at 25, 36, 45, 61, 71, 78, 86, and 101, standalone prose at 47-49 and 88-90, and em-dash entries at 21 and 23. Later entries do use the proposed colon/`_Avoid_`/provenance style, e.g. 92-99. |
| No existing “Review import” term | Yes | A case-insensitive search returned no match in `CONTEXT.md`. |
| `src/lib/agents/run-spine.ts` exists and owns spine writes | Yes | Ownership and transaction contract at `src/lib/agents/run-spine.ts:1-17`; `review_ingested` mapping at 55-71; run creation at 107-147; step locking/insertion at 457-490. |
| Run terminal lifecycle relevant to the plan | Yes; plan omission | `completeRun` is the terminal transition at `src/lib/agents/run-spine.ts:531-571`. Proposed `importReview` never invokes it. A non-owner-waiting review run becomes displayed as stalled after 48 hours at `src/lib/agents/read.ts:25-38,120-129`. |
| `docs/directory.md` | Yes | Exists; its authoritative directory-role statement is at `docs/directory.md:1-7`. “Needs no entry” is prospective because no new file is planned. |
| `zernio_initial_backfill` mechanism name | Yes | Canonical constant at `src/lib/shared/queue-names.ts:12-20`, specifically line 14. |
| `zernio_backfill_runs` table | Yes | Created at `supabase/migrations/028_zernio_backfill_runs.sql:10-37`. |
| `origin_lane='backfill'` | Yes | Canonical value at `src/lib/shared/worker-types.ts:24-34`; current backfill caller passes it at `worker/jobs/zernio/ZernioBackfillWorker.ts:237-240`. |
| Invariant #2 | Yes | Transactional-outbox rule at `.claude/CLAUDE.md:42-48`. |
| Invariant #3 | Yes | No-unapproved-posting rule at `.claude/CLAUDE.md:50-52`. |
| Invariant #15 | Yes | Explicit DB-client injection rule at `.claude/CLAUDE.md:76`. |
| Three current `processReview` callers named in the review request | Yes | `worker/jobs/zernio/ZernioReviewIngestWorker.ts:250`, `worker/jobs/zernio/ZernioBackfillWorker.ts:237`, and `worker/background/pollers/ZernioRecentReviewPoller.ts:195`. |
| Absolute repository path used by commands | Yes | It matches the reviewed worktree path. |
| GitHub issue links #674/#667 | Locally unverifiable | They are external URLs, not repository artifacts; no network lookup was performed. |

## 4. Secondary findings (plan-level, subordinate)

- **[100%]** Intake metadata says `"db_touching": false` and “Not db_touching” (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:4,59`), but the feature inserts `reviews`, run-spine rows, and analytics. “No migration” would be accurate; “not DB-touching” is not.

- **[100%]** The intake says `processReview` is “byte-for-byte unaffected” (`docs/superpowers/plans/feat-674-import-review-no-generation-intake.json:7`), while Task 2 explicitly replaces `process-review.ts:63-84`. Only behavioral neutrality can be claimed.

- **[99%]** The plan cites a design-of-record not present in this branch. Even the historical §6.2 is materially narrower than the plan’s choices, so run-spine, analytics, conflict behavior, and lock policy need an independent authoritative basis.

- **[98%]** The proposed run-spine usage conflicts with the module’s literal lock-order contract requiring the review lock before run-row locks (`src/lib/agents/run-spine.ts:9-17`). A newly inserted, uncommitted review appears operationally safe, but that is an undocumented carve-out and the mocks cannot establish it.

- **[98%]** Verification omits the repository-required `pnpm build` for behavior-affecting work (`.claude/CLAUDE.md:81`). Because this is DB-writing code, the plan should also explain whether the tenant-scope/RLS audits are applicable rather than classifying the work as non-DB-touching.

- **[95%]** The simplest way to make “existing callers untouched” structurally true is to leave `processReview` unchanged and duplicate the small INSERT in `importReview`, accepting localized duplication. If sharing is mandatory, first add a real persisted-row characterization test for `processReview`, then extract.

- **[95%]** The seven tests initially all fail for the same missing export, so the red phase does not demonstrate that each behavioral assertion is independently capable of failing. A live-DB import suite would provide substantially stronger evidence with fewer synthetic positional tests.

## 5. Verdict

VERDICT: REVISE

The eval can pass with incorrect persisted fields, non-atomic writes, mutated conflicts, stale runs, and—most severely—a lost live-ingest generation when import wins the identity race. The cited design is also absent from the current worktree, and one proposed edge-case test asserts a database state prohibited by the existing FK.