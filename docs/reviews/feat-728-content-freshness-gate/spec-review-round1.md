# Spec & correctness review — round 1 — `feat-728-content-freshness-gate`

Reviewed diff: `ae110dfd...HEAD` (11 commits). Inputs: `.feature/intake.json`,
`blast-radius.md`, `feat-728-content-freshness-gate-deviations.md`, ADR 0017.
Method: field-by-field intake check, end-to-end skip-path trace (persist →
handler → outbox completion → crash/retry), blast-radius semantic check, test
title + body verification, and a local run of the changed unit suites (80/80
pass) plus the new live-DB integration suite (3/3 pass against the local test
DB).

## Verdict

One confirmed finding (F1, medium): the gate's skip leaves the stale draft in
the Redis idempotent-generation cache, so a handler re-run inside the retry
window persists the stale text as if fresh — the gate re-runs but is blind.
Everything else passes: all seven intake invariants hold, all 12 tests are
present verbatim with substantive bodies, no file outside the allowed edit
surface was touched, and the code matches ADR 0017's Decision items 1–4.

---

## 1. Allowed edit surface — PASS

Every file in `git diff --name-only ae110dfd...HEAD` matched an
`allowed_edit_surface` glob:

| File | Glob |
|---|---|
| `worker/jobs/response-generation/persist.ts` | exact |
| `worker/jobs/response-generation/__tests__/persist.test.ts`, `__tests__/content-freshness-gate.integration.test.ts` | `worker/jobs/response-generation/__tests__/**` |
| `worker/jobs/ResponseGeneratorWorker.ts` | exact |
| `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts` | exact |
| `worker/jobs/publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts` | exact |
| `src/lib/shared/outbox-completion-reason.ts` | exact |
| `CONTEXT.md` | exact |
| `docs/superpowers/plans/*` (plan, deviations, handoff, intake copy) | `docs/superpowers/plans/**` |
| `docs/reviews/feat-728-content-freshness-gate/plan-review-round{1,2,3}.md` | `docs/reviews/**` |

No stray paths. `src/lib/shared/worker-types.ts` correctly dropped out of the
surface (deviation: token owner relocation). `package.json` untouched
(`fast-check` was already a dependency).

## 2. user_visible_behavior — PASS (all three shipped, none extra)

1. **Stale draft never persisted** — gate at `persist.ts:126` skips the INSERT
   before any lane-specific work; the colliding fresh job's slot stays free
   (integration tests 1–3). *Qualified by F1: holds on the first attempt; a
   crash-window re-run can still persist stale text via the generation cache.*
2. **Job completes (not fails) with `stale_review_content`** —
   `ResponseGeneratorWorker.ts:125-132` calls `markOutboxCompletedWithReason`
   with `OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT`; unit-tested.
3. **Structured log line** — `persist.ts:127-133` logs `reason`, `review_id`,
   `business_id`, `version`, `origin_lane`; unit test also asserts no raw
   hashes in the fields.

No behavior in the diff beyond these three (the `PersistResponseOutcome`
union and the CONTEXT.md glossary entry are internal/doc changes).

## 3. Invariants — field-by-field

| Intake invariant | Verdict | Evidence |
|---|---|---|
| `evaluateAutoApprovalCandidate` byte-identical; auto-approval chain untouched | **PASS** | `git diff ae110dfd...HEAD -- worker/jobs/response-generation/auto-approval.ts` is empty; the call site in persist.ts is unchanged |
| ZERO DB writes in the persist tx on skip | **PASS** | Skip path executes only the lock preamble (review `FOR UPDATE`; plus businesses `FOR UPDATE` + entitlement advisory lock for structural candidates — locks, not writes) then `return`s; unit test asserts `mockTx` called exactly once (non-candidate) / 3× (candidate) and `mockSql` never as a tagged template; integration test 1 asserts no responses row, no `api_costs` link/moderation metadata, no spine steps/outcomes, run still `running`, `send_notification` outbox count unchanged |
| Null hash on EITHER side passes | **PASS** | `hasStaleReviewContent` (`persist.ts:79-86`) requires both non-null; unit tests for loaded-null, current-null, match; fast-check iff property |
| Review `FOR UPDATE` stays the tx's FIRST statement; re-read rides it | **PASS** | `acquirePersistLocks` is still the first call inside `sql.begin`; the hash is a projection of the same `SELECT ... FOR UPDATE` (`persist.ts:323-327`), not a second statement; the two-client integration test proves the read blocks on a concurrent content-change tx and then skips |
| Gate before the lane split, covering all five lanes | **PASS** | Gate is unconditional in `persistResponseAndNotify` before the INSERT and all lane work; `GENERATE_RESPONSE_ORIGIN_LANES` has exactly the 5 lanes and the all-lanes unit test iterates them (candidate lane with `AUTO_APPROVAL_ENABLED=true` concretely). A `null` (unknown-legacy) lane is also covered by construction |
| Invariant #4 moderation-hold path unchanged for persisted drafts | **PASS** | `recordModerationAndHold` untouched; still runs post-INSERT in the same tx. A skipped draft is never persisted/notified, so no hold applies — matches the intake's "for persisted drafts" scoping |
| Orphan-review posture unchanged; unknown current hash passes | **PASS** | Sentry-warn-and-proceed block untouched; `reviewLock?.review_content_hash ?? null` normalizes the no-row case to `null` → gate passes. The `?? null` is load-bearing: without it `undefined !== null` would make an orphan review skip, changing the posture |

## 4. Edge cases — all handled or explicitly out of scope

1. **Fresh persisted first at shared version** → stale worker's loaded hash no
   longer matches current → gate skips before hitting the unique violation.
   Covered by the gate being unconditional + slot-free test (both orders
   converge; the #678 race test covers the reverse interleaving).
2. **Stale persists before the change commits** → no mismatch at persist time;
   live-ingest committed-draft repair covers it. Out of gate scope per intake;
   nothing in the diff touches it. PASS by scoping.
3. **Legacy edit-draft residual** → accepted (ADR 0017 Accepted costs); no code
   pretends otherwise. PASS by scoping.
4. **Null/null/equal hash combos** → unit + property tests. PASS.
5. **Crash between gate-skip tx and outbox completion** → the gate itself
   re-runs and performs no double writes, and `markOutboxCompletedWithReason`
   is an attempt-guarded CAS (idempotent). **But see F1** — "re-runs the gate
   idempotently" is only half the story: the re-run can persist stale content
   via the warm generation cache.

## 5. tests_to_add — 12/12 present verbatim, bodies substantive

| # | Title | Location | Body check |
|---|---|---|---|
| 1 | persist gate skips the INSERT when review content changed after load (stale-content direction) | integration:183 | Real DB; asserts outcome + zero responses rows + cost row unlinked/unflagged + no spine writes + run still running + notification-outbox baseline diff |
| 2 | persist gate leaves the (review_id, version) slot free for the colliding fresh job | integration:218 | Skip then fresh persist at SAME version succeeds; exactly 1 row, version 1 |
| 3 | skips persist and returns skipped_stale_content when loaded and current hashes are both non-null and differ | persist.test | Asserts the discriminated outcome |
| 4 | gate skip performs no writes: no responses INSERT, no api_costs link, no spine steps, no notification enqueue | persist.test | Statement-count assertion (`mockTx` ×1) + top-level-handle assertion (`mockSql` never) + spine mocks never; passes `retryCostId` so a cost-link write can't hide |
| 5–7 | persists when loaded hash is null / current hash is null / hashes match | persist.test | Each asserts `persisted` outcome AND the `INSERT INTO responses` text ran |
| 8 | completes the outbox with stale_review_content and skips first_response_drafted on a gate skip | ResponseGeneratorWorker.test:292 | Asserts `markOutboxCompletedWithReason` with the constant, plain `markOutboxCompleted` NOT called, `enqueueAnalyticsEvent` NOT called |
| 9 | content-freshness gate skips iff both hashes are non-null and differ | persist.test | fast-check property over `option(string)²` against the spelled-out predicate |
| 10 | persist gate re-reads review_content_hash under the review FOR UPDATE lock (blocks on a concurrent content-change tx, then skips) | integration:232 | Two clients; lock-acquired signal before A starts; asserts A blocks (250ms race) then skips after B commits; try/finally releases B; 10s timeout |
| 11 | content-freshness gate skips every generate-response origin lane before lane-specific work | persist.test | Iterates all 5 `GENERATE_RESPONSE_ORIGIN_LANES`; candidate lane runs with flag enabled and its full 3-statement preamble; per-lane statement-count + `findActiveReviewRun` never |
| 12 | gate skip logs stale_review_content with review_id, business_id, version, and origin_lane without raw hashes | persist.test | Field-level `objectContaining` + JSON-serialized fields must not contain either hash |

None hollow. Locally verified: `persist.test.ts` + `ResponseGeneratorWorker.test.ts`
= 80/80 pass; `content-freshness-gate.integration.test.ts` = 3/3 pass against
the live test DB. `ci:outbox-status`, `ci:live-db-suites`, `ci:static-policy`
all pass on the branch.

## 6. Blast radius — semantic check of importers

- **`outbox-completion-reason.ts` (16 importers):** all production readers of
  `completion_reason` filter on a specific value scoped to their own topic —
  `NotificationFailoverPoller` + health-alert `checks.ts` use
  `OWNER_UNREACHABLE` on `send_notification` rows (`IS DISTINCT FROM`, so a
  new value is inert), `job-eligibility.ts` uses `IMPORT_CONSENT_BLOCKED` on
  `zernio_initial_backfill`. No exhaustive switch over the vocabulary exists.
  New member is additive-safe.
- **`persist.ts` (6 importers):** the only production caller is
  `ResponseGeneratorWorker` (updated). `on-demand-lane.property.test.ts`
  ignores the return value and its queued lock rows carry no
  `review_content_hash` → normalizes to `null` → gate passes → its assertions
  still exercise the paths they claim. The autopilot-entitlement suite got the
  mechanical unwrap (throws on non-persisted, preserving its old semantics).
- **"Anything counting on a response row existing after a `generate_response`
  job completes":** swept `src/` for readers. Past Replies / reviews-list
  `generating` state derives from an IN-FLIGHT `generate_response` outbox row
  (`load-replies.ts:248`), not from completion — after a gate skip the
  colliding fresh job's own outbox row keeps the state alive; in the
  no-replacement legacy lane the badge clears with no draft, which is exactly
  ADR 0017's accepted cost. `correlation.ts` reads the most recent
  `generate_response` row regardless of reason. No caller assumes
  completed ⇒ row exists.
- **`ResponseGeneratorWorker.ts` (3 importers):** `worker/index.ts`
  registration unchanged; `terminal-failure-checkpoints.integration.test.ts`
  exercises `checkpointTerminalGeneration`, which this diff does not touch.

## 7. Deviations log vs code — all ACCEPT verdicts match the code

- Token owner relocation → `OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT`
  shipped; `worker-types.ts` untouched. ✓
- Surface amendment #1 → both added files touched, both removed files
  untouched. ✓
- Three added test titles → shipped verbatim, green. ✓
- Task 1 adaptations → `gateInput` delegates to `baseInput` (no shadowing);
  slot-free test uses `toHaveLength(1)` + `toMatchObject`; lock test carries
  `try/finally` + per-test 10s timeout. ✓
- Task 4 harness fix → integration suite queries/cleans by `agent_run_id`. ✓

## 8. ADR 0017 Decision section vs code

- **Item 1** (re-read under the existing first-statement FOR UPDATE): ✓ — same
  statement, projection added, comment updated in place.
- **Item 2** (skip INSERT; complete with queryable token + structured log): ✓ —
  with the ACCEPTED locus change: the ADR letter still cites the
  `SKIP_REASON_ARCHIVED_LOCATION` precedent in `worker-types.ts`, but the
  token lives in `OUTBOX_COMPLETION_REASON` (the typed
  `job_outbox.completion_reason` owner). Settled by the deviations log;
  `docs/adr/` is outside this branch's surface, so the ADR text itself still
  misstates the locus — recommend a one-line amendment in the post-merge docs
  sweep.
- **Item 3** (null on either side passes; auto lane's stricter null-blocks
  unchanged): ✓.
- **Item 4** (unconditional, before the lane split; `evaluateAutoApprovalCandidate`
  byte-identical): ✓.
- **Skip-the-INSERT rationale**: honored — no row in any status is written on
  skip; the slot-free integration test proves the fresh job is not starved.

## 9. Bug hunt — skip-path trace

**Persist → handler → outbox:** gate skip commits a zero-write tx →
handler branches on `kind` → `markOutboxCompletedWithReason` (attempt-guarded
CAS, idempotent, no-ops on a superseded attempt) → return. No
`maybeEnqueueFirstResponseDrafted`, no `markOutboxCompleted`, no
`checkpointTerminalGeneration`.

**Run spine:** nothing on the skip path completes or fails the run.
`completeRun` is reachable only via `checkpointTerminalGeneration` (terminal
generation failure), which the skip path never calls. The active run stays
`running` for the colliding fresh job's spine writes (integration-asserted).
The only lane where the run could idle with no successor is the accepted
legacy edit-draft residual.

**`?? null` orphan normalization:** correct and load-bearing (see invariant
table).

**Crash/retry — FINDING F1 below.**

---

## Findings

### F1 (medium, correctness): gate skip leaves the stale draft in the idempotent-generation cache — a retry-window re-run persists stale text as fresh

`worker/jobs/ResponseGeneratorWorker.ts:125` / `worker/jobs/response-generation/persist.ts:126`

Concrete scenario:

1. Job J (review R, version 1) loads content hash H1, generates; the draft is
   written to the Redis idempotent-generation cache keyed **(reviewId,
   version)** with a **24h TTL** (`tracker.ts:39`, `setCachedGeneration`) —
   the key carries no content hash.
2. Live-ingest commits the content change (hash H2) and enqueues the colliding
   fresh job F at the same version.
3. J's persist: gate fires (H1 ≠ H2), skips with zero writes. ✓
4. J is re-run before completing cleanly — any of: worker crash between the
   skip tx and `markOutboxCompletedWithReason` (BullMQ stalled-job retry), a
   transient DB error thrown by that very completion UPDATE (BullMQ retry), a
   crash between outbox completion and BullMQ ack, or the outbox watchdog
   re-dispatching the still-`dispatched` row. All are windows the codebase
   elsewhere treats as normal (the idempotency check in `load-context.ts:144`
   exists precisely for them).
5. The re-run reloads the review → `loadedReviewContentHash` is now **H2**.
   `generateDraft` → `runProductionMode` hits the warm cache
   (`generator.ts:121-139`) and returns the **stale text generated from H1**.
6. Gate compares H2 vs H2 → **passes** → the stale draft persists as
   `pending_approval` and the owner is notified with a reply to text the
   customer already changed. F later no-ops as `already_exists` and the stale
   row survives — exactly the defect the feature exists to close, now labeled
   fresh.

The intake's edge case 5 ("BullMQ retry re-runs the gate idempotently") is
true for writes but the re-run gate is *blind*: its loaded-hash input was
refreshed while the draft text was not, so `user_visible_behavior` claim 1
("never persisted") does not hold across the retry window. Pre-branch the same
window persisted stale text on the *first* attempt, so this is a residual hole
rather than a regression — but the intake states the absolute.

**Suggested fix (small):** on the `skipped_stale_content` branch, best-effort
`clearCachedGeneration(reviewId, version)` (the helper already exists,
`tracker.ts:236`, and is already used best-effort at `generator.ts:221`) —
outside the tx, log-and-swallow per the "best-effort work after the primary
side effect" rule. A re-run then regenerates from the current text (cost-guard
bounded) and persists a genuinely fresh draft; the version-slot semantics are
unchanged (F no-ops as `already_exists` against a *fresh* row, which is fine).
Add one unit test: handler clears the cache on the skip branch.

---

## Low-confidence appendix (speculative; NOT findings)

- The gate's structured log line fires inside the open tx before commit; if
  the zero-write commit itself failed (connection drop), a "skipped" line
  would exist for an attempt that will be retried. Harmless (no writes either
  way), noted only because the line is the designated observability signal and
  could double-count a single logical skip across retries. The
  `job_outbox` completion reason, the queryable signal, is not affected.
- For a structural auto-approval candidate the skip path still takes the
  businesses `FOR UPDATE` + tier-entitlement advisory lock before the gate.
  Correct per the WS8 lock-order law (and the all-lanes test documents it);
  the only cost is brief extra lock traffic on a path that then writes
  nothing. Reordering would violate the lock-order law — do not "fix".
- `markOutboxCompletedWithReason` re-marking on a later retry overwrites
  `completed_at`/`completion_reason` on an already-completed row (CAS matches
  `dispatchedRow`; whether a completed row still matches depends on
  `dispatchedRow`'s status predicate — not re-verified here). Its doc comment
  explicitly blesses "idempotent re-marking on a later retry", so at most this
  is a stale-attempt nuance already handled by the attempt guard.
- The ADR's "Traced orderings all converge on a fresh draft" section does not
  enumerate the F1 interleaving; if F1 is fixed, that section could gain the
  fourth ordering in the same docs-sweep amendment as the token-locus
  correction.

---

## Round 2 verification

Verified commits `70d56c89` (cache provenance) + `c13011e1` (typed outcome
refactor) against the round-1 finding. Triage chose CACHE PROVENANCE over the
round-1 suggested clear-on-skip (deviations log "Step 7 round-1 triage": one
owner of cache validity); no `clearCachedGeneration` was added to the skip
branch — verified absent from the handler's `skipped_stale_content` branch
(`ResponseGeneratorWorker.ts:125-132`), matching the triage decision. The
provenance mechanism is strictly stronger than the suggested fix: it also
closes the first-attempt vector (fresh replacement job F served J's stale
cache *before* J's persist ever skips), which clear-on-skip could not reach.

### (1) F1 scenario re-walk against the fixed code — RESOLVED

Same six-step scenario, fixed code:

1. Job J loads H1, generates; `tryWriteCache` (`generator.ts:250-271`) now
   stamps the payload with `reviewContentHash: H1`
   (`options.loadedReviewContentHash ?? null`, threaded from
   `ctx.loadedReviewContentHash` at `generate-draft.ts:132`).
2. Live-ingest commits H2, enqueues colliding fresh job F at the same version.
3. J's persist: gate fires (H1 ≠ H2), skips with zero writes — unchanged.
4. J re-runs inside the retry window. `loadGenerationContext` re-reads
   `review_text` AND `review_content_hash` in the SAME `SELECT`
   (`load-context.ts:101-106`, projected at `:237`) — content and hash are
   coherent: `normalizedReview` carries H2 text, `loadedReviewContentHash`
   is H2.
5. `runProductionMode` hits the warm cache but the accept is now
   strict-equality (`generator.ts:141`): `parsed.reviewContentHash` (H1)
   `!== 'H2'` → **rejected**, cleared best-effort (`generator.ts:155`),
   regenerated from the H2 `normalizedReview`, re-cached under H2.
6. Gate compares loaded H2 vs current H2 → passes → the persisted text is the
   **current-content** draft. If content moved again to H3 mid-flight, the
   gate fires (H2 ≠ H3) and the H3 replacement rejects the H2-tagged cache —
   the two mechanisms compose with no gap in either direction.

Null/undefined handling is correct: a provenance-less legacy cache entry
parses with `reviewContentHash === undefined`, and `undefined === (x ?? null)`
is false for both null and string loaded hashes → rejected + cleared + fresh
regeneration (paid, cost-guard bounded). Only `null === null` (post-fix legacy
entry, legacy review) is served — exactly the intake invariant. Both
production `setCachedGeneration` sites carry the stamp: the generator's own
write and the avoid-facts guardrail overwrite
(`generate-draft.ts:270-278` — without it, the documented "retry hits the
idempotent cache" economy would break; the deviations log records this
adaptation). Repo-wide grep confirms no third write site. The only other
`generateResponse` caller is demo mode (no cache); `mock-generator.ts`
touches no cache.

### (2) New invariant + three tests — CONFIRMED

Intake (`.feature/intake.json`, byte-identical to the
`docs/superpowers/plans/` copy) gained invariant 8 ("served only on exact
review_content_hash provenance match … strict equality; null matches null …
rejected, cleared best-effort, and regenerated") and exactly three
tests_to_add titles. All three exist **verbatim** and assert the invariant:

| Title | Location | Body |
|---|---|---|
| generation cache is accepted only when the cached review_content_hash strictly equals the loaded hash (null matches null for legacy pre-hash reviews) | `src/lib/responses/__tests__/generator.test.ts:274` | Hash-match hit + legacy null/null hit; asserts costUsd 0, no LLM call, no `reserveCost`, no clear |
| generation cache rejects a stale-tagged or provenance-less cached draft, clears it, and regenerates | `generator.test.ts:318` | (a) H1-tagged vs H2-loaded and (b) provenance-less vs null-loaded; asserts fresh text, `clearCachedGeneration` ×2 with args, LLM ×2, full cost lifecycle (`reserveCost` ×2) |
| replacement job at the same version regenerates against current content instead of serving the stale cached draft | `worker/jobs/response-generation/__tests__/generate-draft-cache-provenance.test.ts:159` | Worker-level: REAL `generateResponse` + real cost-guard over a Map-backed cache store, mocked LLM SDKs — proves `ctx.loadedReviewContentHash` threads from `generateDraft` into cache identity; asserts H1 write stamp, H2 replacement regenerates (LLM ×2), re-cache under H2, and a same-H2 retry IS served from cache (rejection was provenance-driven, not a broken cache path) |

The pre-existing cache-hit test's fixture gained `reviewContentHash: null` (a
valid legacy entry), preserving its original subject — matches deviations-log
adaptation (b). The separate file for test 3 is justified in its header:
`generate-draft.test.ts` mocks `generateResponse` at module scope and cannot
honestly exercise the accept path. Ran all four affected suites
(`generator.test.ts`, `generate-draft-cache-provenance.test.ts`,
`persist.test.ts`, `ResponseGeneratorWorker.test.ts`): **104/104 pass**.

### (3) Edit surface + refactor neutrality — CONFIRMED

`git diff --name-only 4967d9ec..HEAD` (everything after the round-1 report):
11 files, every one matched by the amended `allowed_edit_surface` — the four
amendment-#2 additions (`generate-draft.ts`, `generator.ts`, `types.ts`,
`src/lib/responses/__tests__/**`), the original exact entries
(`persist.ts`, `ResponseGeneratorWorker.test.ts`), and the doc globs. No
stray paths; `src/lib/costs/tracker.ts` correctly untouched (payload is
opaque to it, as the triage scoped).

`c13011e1` is behavior-neutral. Pre-refactor: outer `staleContentSkip` flag,
bare `return`s inside the tx callback, post-tx ternary. Post-refactor: the
callback returns `PersistResponseOutcome` directly and the function returns
`sql.begin(...)` (postgres.js resolves `begin` with the callback's return
value). Return-site mapping is exact — gate skip → `skipped_stale_content`
(was flag=true → ternary's skip arm); auto-approved / suppress-or-held /
notification fall-through → `{ persisted, responseId }` (was flag=false →
persisted arm, `responseId` computed in the outer scope at `persist.ts:95`
both before and after). Throw paths unchanged (reject → BullMQ retry). The
test edit only tightens assertions (`expect.anything()` →
`mockSql, 'outbox-gen-1'`, the fixture's actual outbox id at
`ResponseGeneratorWorker.test.ts:162`).

### Round-2 appendix (speculative; NOT findings)

- `clearCachedGeneration(...).catch(() => {})` at `generator.ts:155` is
  fire-and-forget: in principle a Redis DEL delayed by connection-retry
  queueing could land after the fresh `tryWriteCache` SET issued seconds
  later, deleting the fresh entry. Worst case is a cache miss → bounded
  regeneration spend, never stale text (the provenance check still guards
  every read). Cost-only, remote probability — not a finding.
- `tryParseCachedGeneration` still casts without field validation, so a
  cache payload of literal JSON `null` falls through the `if (parsed)` guard
  without clearing. Pre-existing behavior, unchanged by these commits.

### Verdict

**F1 | RESOLVED** — cache identity now binds to `review_content_hash`
provenance; the retry-window re-run rejects the stale-tagged entry and
persists a current-content draft.

**AXIS VERDICT: CLEAN**
