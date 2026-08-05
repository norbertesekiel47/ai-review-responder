# Adversarial Verification — branch round 2 (#674)

**Round:** 2 of 3 — **verification-only**. No new fronts opened against unchanged code.
**Target:** the round-1 dispositions of A1 and A2, and the fix commits `a720a801` + `8cab463a`.
**Baseline:** `b6d841f8` (the commit the round-1 gate was taken at).
**Verdict:** the round-1 fixes are sound. One **low** residual: a verbatim copy of the *pre-correction* hazard text survives inside the plan's Task-6 code listing.

## Findings

| Severity | file:line | Finding |
|---|---|---|
| low | `docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:494-497` | The plan's Step 6 listing still contains the **uncorrected** JSDoc — *"if this call wins the identity race against a concurrent live-ingest `processReview`, the loser re-reads this row… so that review is stored and never drafted"* — i.e. a verbatim copy of the exact paragraph the correction replaced, sitting 435 lines below the corrected Hazards section in the same file. The plan is the artifact the #675 implementer is pointed at (line 873: *"Do not fix the cross-lane lost-draft hazard (see Hazards above). It is #675's."*), and this copy re-states the narrow race framing as fact. Same class, weaker: the decision table at `:42` still reads *"Cross-lane lost-draft **race** deferred to #675"*. Fix is two edits in one file. |

## Verification items

### 1. Is A1's corrected characterization actually correct? — **VERIFIED**

Each clause checked against the code on this branch, not against the round-1 report.

| Clause | Evidence | Verdict |
|---|---|---|
| The live lane enqueues `generate_response` only on INSERT or on content-hash change | `src/lib/reviews/process-review.ts:68-84` (enqueue guarded by `insertedCount > 0`); the only other three enqueues — `:364`, `:385`, `:463` — all sit **inside** the `existingHash !== contentHash` block that begins at `:279` | correct |
| A later `processReview` for an already-imported row returns `'unchanged'` with no enqueue | `:266` `if (existingHash === contentHash)` → `:276` `return 'unchanged'`. The one sibling branch (`:267` status `DELETED` → resurrect) also enqueues nothing, and cannot fire for an imported row: `insertNewReviewRow` writes `REVIEW_STATUS.NEW` (`:164`) | correct |
| `ZernioBackfillWorker.processUnansweredReview` routes through the same `processReview` | `worker/jobs/zernio/ZernioBackfillWorker.ts:237` — `await processReview(sql, monitored, business_id, …, { originLane: BACKFILL })`. The other two live entrypoints are the same: `ZernioReviewIngestWorker.ts:250`, `ZernioRecentReviewPoller.ts:195` | correct, and understated — all three live lanes converge, not just backfill |
| Therefore any imported review is never drafted; the race is the simultaneous instance | follows from the three above | correct |

**The absolute claim ("never drafted by any lane") was attacked specifically, per brief.** `generate_response` has a typed helper, so invariant #2's `ci:outbox-seam` rule makes `enqueueGenerateResponse` the *exhaustive* set of enqueue sites — a raw `INSERT INTO job_outbox` for this topic would fail CI. There are nine call sites; four are `process-review.ts` (above). The other five each require a pre-existing `responses` row, which an imported review does not have:

- `src/lib/approval/token-mode.ts:150` — after `lockAndConsumeTokenResponse(tx, link)`; needs an approval link → a response.
- `src/lib/approval/session-mode.ts:181` — after `lockPendingResponse(tx, responseId)`.
- `src/lib/approval/callback-mode.ts:113` — after `claimCallbackResponse`.
- `src/app/api/admin/flagged/route.ts:158` — guarded by `resp.status === 'pending_approval'` on the flagged response.
- `src/app/api/dashboard/past-replies/draft/route.ts:232` — the one owner-triggered path that starts from a *review id*, and the one worth checking. `assertCanEditReply` (`src/lib/responses/edit-existing.ts:70`) does **not** require a response, so the gate is further down: `validateOptimisticConcurrency` (`edit-existing.ts:147-152`) selects the `status='posted'` response and throws `ResponseChangedError` when there is none. An imported review cannot reach the enqueue.

No poller, scheduler or status-based sweep drafts an undrafted review either — `pnpm`-side, nothing selects "reviews with no response" to enqueue generation; the deleted `ReconciliationPoller`/`ReviewSyncWorker` were the historical candidates.

**One boundary, reported for completeness, deliberately not a finding.** There is a path by which an imported review *eventually* receives an AI draft: `reconcileExternallyAnsweredReview` can attach a `status='posted'` response onto an existing review row (`worker/jobs/zernio/zernio-ingest-shared.ts:293-294`), which then satisfies the `validateOptimisticConcurrency` gate above and makes Past Replies **regenerate** reachable. It requires the owner to answer the review directly on Google first, and it is doubly flag-gated (`EXTERNAL_REPLY_IMPORT_ENABLED`, plus `PAST_REPLIES_VIEW` + `EDIT_REPLIES`). It therefore never rescues an imported review that is still unanswered — the case the hazard is about — and it does not make the deferral or the #675 carry statement wrong. Naming it in the #675 comment would be precision, not correction.

Net: the corrected characterization is right, and is the statement #675 should inherit. It is also *stronger* than round 1 claimed on one axis (all three Zernio lanes, not just backfill).

### 2. Did the correction land in all three claimed places, and are they consistent? — **VERIFIED** (with the low finding above)

| Place | Landed | Text |
|---|---|---|
| D4 | `docs/superpowers/plans/feat-674-import-review-no-generation-deviations.md:157-193` | `### CORRECTION (branch review round 1, 2026-08-05) — the hazard is much broader than "a race"`, with the three-clause verification trace and *"any review `importReview` stores will never be drafted by any lane, unless the reviewer later edits their text"* |
| plan Hazards | `docs/superpowers/plans/2026-08-05-674-import-review-no-generation.md:59-61` | same claim, same three clauses, plus the #675 carry instruction |
| JSDoc | `src/lib/reviews/process-review.ts:507-517` | same claim, scoped *"never drafted by the live lane"* |

**Mutually consistent.** The JSDoc's "live lane" is the weaker statement and is entailed by the other two's "any lane"; the mechanism sentence ("only when it INSERTS … or when the content hash CHANGES") is identical in all three, so the "unless the reviewer edits their text" exception is derivable in each even where it is only spelled out in D4.

Two sub-observations **below the ≥80% findings bar**, recorded so they are not re-discovered:

- D4's pre-correction body still says the fix *"lives in `processReview`'s **race-loss** branch"* (`:151`). The CORRECTION restates it as the **existing-row** branch and explicitly subsumes the race (*"merely the simultaneous instance"*), and the deviations log is append-only by convention, so a top-down reader ends on the corrected version. Acceptable as-is.
- `.feature/intake.json:8` still says *"the cross-lane lost-draft **race**"*, but the intake is a locked input artifact and the phrase points at *"the plan's Hazards section"*, which is corrected.

The finding in the table is a different case from both: it is not append-only history and not a locked artifact — it is a live instruction block that a re-reader would take as the text to write.

### 3. Did the fix introduce anything new? — **VERIFIED**

`git diff b6d841f8..HEAD -- src/ worker/ scripts/ supabase/` touches exactly two files:

- `src/lib/reviews/process-review.ts` — **comment-only**: −4/+13 lines, entirely inside the `/** … */` block above `importReview`. No statement, signature, or import changed.
- `src/lib/reviews/__tests__/import-review.integration.test.ts` — +9 lines: the S2 fix (`assertSchemaReady(db, [MIGRATION_071_RUN_SPINE])` in `beforeAll`). Test-only, disclosed in the commit message, and triaged in round 1 as ACCEPT–FIXED. `MIGRATION_071_RUN_SPINE` asserts `agent_runs`/`agent_run_steps`/`agent_outcomes` (`src/lib/shared/__tests__/helpers/schema-ready.ts:177`); it is the highest-numbered migration the suite depends on (sentiment is 052, `analytics_events` is 046), so it is an adequate proof for the whole suite.

No production behaviour changed. Re-run first-hand on this worktree:

- `npx vitest run src/lib/reviews/__tests__/process-review.test.ts` → **37 passed**.
- `TEST_DATABASE_POOL_URL=… npx vitest run src/lib/reviews/__tests__/import-review.integration.test.ts` → **4 passed** (i.e. the new schema assertion does not break the live-DB suite).
- `.feature/gate-status.json` timestamp `1785941720` = 2026-08-05 14:55:20 UTC, which is **after** both fix commits (`a720a801` 11:01 UTC, `8cab463a` 14:52 UTC) — so the recorded GREEN gate already covers the round-1 edits, including `integration-src-lib-reviews---tests---import-review-: PASS`.

### 4. Is D16's record of the A2 owner decision faithful? — **VERIFIED**

`docs/superpowers/plans/feat-674-import-review-no-generation-deviations.md:534-569`. Checked against what Codex actually wrote in `branch-round-1-adversarial.md:77-118`:

- States the problem in the reviewer's own terms, not softened: *"a review with no triage, draft, moderation, notification, post or outcome positively reports success."* Verified against `deriveRunDisplayState` (`src/lib/agents/read.ts:117` — `if (run.status === 'completed') return 'completed';`), which is exactly the direct mapping Codex named.
- **Strengthens** rather than minimizes the compounding: *"the reviews being reported `completed` are exactly the ones that will never be drafted, so the run status actively conceals the gap it sits on top of."* Round 1 said the two findings compound; D16 says the run status conceals the gap — a harder statement.
- Records the counter-argument to D3 honestly (*"D3 … traded a false-negative signal for a false-positive one, and … the trade is worse than it looked"*) instead of presenting D3 as vindicated.
- Reproduces the four-option cost table intact. The one wording change from the round-1 table — "Create no run at all" gains *"contradicts a locked intake invariant"* — is accurate, not embellishment: `.feature/intake.json` `goal` locks *"a completed `review_ingested` run-spine record"*, and `invariants[6]` locks that the run is terminal on commit.
- Its load-bearing justification is factually true: `importReview` has **zero** production callers on this branch (`rg importReview` returns only the definition, tests, and `CONTEXT.md`), so nothing is misreported today.
- The quoted `observability` fingerprint matches `.feature/intake.json` `observability[0]` verbatim.

One clause of A2 is not carried into D16: *"A later owner-generated response must open another run, fragmenting the audit trail."* It is a secondary consequence, and the shipped JSDoc addresses the same mechanic from the other side (`process-review.ts:503` — *"#678's on-demand Generate opens a fresh run per owner action"*), so the fact is not lost from the branch. Not enough to call the record unfaithful; worth one sentence in the #675 comment.

## Appendix — untriaged, unrelated to round 1 (NOT findings)

Noticed while tracing; outside round 2's scope and not verified to the findings bar. Recorded only so the orchestrator can decide, not to be acted on from this report.

1. `worker/jobs/zernio/zernio-ingest-shared.ts:364` `insertImportedReview` is a second, older insert-without-generation path that computes its own `review_content_hash` inline (`sha256("${star}|${text}")`) rather than sharing the normalizer. The intake already records the near-duplication as a #675 note (`non_goals[2]`); the *hash-derivation* divergence is the part that would matter if #675's import caller and the live lane ever disagreed on a hash — a disagreement would silently convert the D4 hazard into a spurious content-change update instead.
2. The `EXTERNAL_REPLY_IMPORT_ENABLED` → Past-Replies-regenerate chain described under item 1 gives an *externally answered* imported review a path back into LLM spend. Benign today (both flags off), but it is the only route by which an imported review consumes generation budget, which #675's cost modelling may want to know.
