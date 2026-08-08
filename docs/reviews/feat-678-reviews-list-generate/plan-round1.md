# Plan review — round 1 (adversarial, codex, read-only)

**VERDICT: REVISE** · 9 findings (5 High, 4 Medium) · dispatched via direct `codex exec --sandbox read-only`
Raw transcript: `scratchpad/codex-plan-round1.jsonl` (session not resumable across `/clear` — findings are reproduced in full below).

Primary question asked: *can the 37-title eval pass while the feature is still wrong?* Answer: **yes** — auto-approval regression, cross-tenant poller leak, duplicate generation jobs, duplicated orphan rows, and fail-closed UI all slip through.

## Findings table

| # | Sev | Locus | Finding | Verdict |
|---|---|---|---|---|
| 1 | High | `on-demand-lane.property.test.ts` | Property test copies `isAutoApprovalCandidate` into the test — test and `persist.ts:86` drift independently | **ACCEPT** |
| 2 | High | `src/lib/reviews/process-review.ts:325` | Generate racing live-ingest content-change enqueues a **second** `generate_response` job — no in-flight dedup in the enqueue helper | **ACCEPT (test) / DEFER (fix)** |
| 3 | High | `load-replies.ts:143` | `LEFT JOIN` makes the orphan query **overlap** the main query — its `NOT EXISTS` disjointness guarantee dies with the inner join. Plan asserted the opposite. | **ACCEPT** |
| 4 | High | `.feature/intake.json` | **Zero** of the 37 locked titles test `GET draft-status`. Task 3's "the poller titles" is a fabricated reference. | **ACCEPT** |
| 5 | High | `draft-status/route.ts` | Poller returns any non-terminal response as `ready` **including moderation-held drafts** — invariant #4 violation, surfaces held text + `Approve & post` | **ACCEPT** |
| 6 | Med | `PastReplyCard` | Fail-open tested at the producer only; card could read "no map entry" as "0 remaining" and disable every button | **ACCEPT** |
| 7 | Med | `load-replies.ts` ORDER BY | `(resp.id IS NOT NULL), review_date DESC` is not a **total** order — equal dates at an OFFSET boundary duplicate/drop rows across pages | **ACCEPT** |
| 8 | Med | `src/lib/past-replies/flags.ts` | Collapsing to one function requires edits to 6 files **outside `allowed_edit_surface`** | **ACCEPT — owner decision required** |
| 9 | Med | C1 chain | Discard→Generate version bump provable only via live DB; a mocked `MAX(version)=2` passes vacuously | **ACCEPT** |

## Accepted — plan revisions to apply in round 2

**F1.** Replace the hand-copied predicate with a test through the real `persistResponseAndNotify`.
New title: `persistResponseAndNotify keeps an on_demand_generate v1 draft owner-only when AUTO_APPROVAL_ENABLED is true even if suppress_notification is false` — setting `suppress_notification: false` isolates `origin_lane` as the guard under test. Keep the two fast-check properties as cheap regression on the lane *set* (they are the invariant-per-declared-invariant requirement), but they are no longer the primary evidence.

**F2.** Add the race tests. Note the existing safety net the reviewer did not credit: the partial unique index (migrations 023+026+029) allows at most one non-terminal response per review, so the duplicate job **fails to persist** rather than producing two drafts — the cost is wasted LLM spend on the losing job, not corruption. The fix belongs in `process-review.ts` (out of surface) → see owner decision B.

**F3.** The orphan query must move with the JOIN (this is #671 landmine 3, which the plan quoted and then contradicted). Fix: make the **main** query the single row source — add the orphan sidecar as a third LATERAL rather than a separate merged query, or exclude orphan-review ids from the main query. Either way `deriveRowState`'s `is_orphan` stops depending on caller discipline, which also closes the plan's own self-declared "known gap". Also: the orphan query's `LIMIT 50` with **no OFFSET** would merge into *every* page.

**F4.** Add poller titles to `tests_to_add` in **both** intake copies (a `tests_to_add` change is a deviations-file entry, not a surface amendment — no budget burned):
- `GET draft-status returns 404 without querying draft text for a review owned by another account`
- `GET draft-status returns generating, ready, failed, and idle from the authoritative review state`
- `GET draft-status resumes a draft in another active location owned by the same account regardless of current-location cookie`

**F5.** Both the poller and the list query must treat a moderation-held response as **not** `draft_ready` / **not** `ready`. Use `hasOpenFlag` (`src/lib/moderation/held-draft.ts`) — already imported by `http-routes.ts`, so this is the established owner of the fact.
New title: `GET draft-status never returns response_text or ready for a moderation-held response`

**F6.** New title: `PastReplyCard leaves Regenerate enabled and hides the counter when the budget map has no entry`

**F7.** Add `r.id DESC` as the tie-breaker: `ORDER BY (resp.id IS NOT NULL), r.review_date DESC, r.id DESC`.
New title: `Reviews-list pagination uses review_id as a deterministic tie-breaker when review dates are equal`

**F9.** Make the C1 test live-DB: `discarding a v1 Generate draft retains it and the next POST generate enqueues v2`.

## Cited-artifact check — PASS with 4 corrections

All mandatory artifacts exist with the claimed APIs. Corrections to fold into the plan:
- "the poller titles" — **fabricated**, zero such titles exist (= F4).
- The orphan-disjointness claim is **false** post-`LEFT JOIN` (= F3).
- `past-replies/draft/route.ts` is **253** lines, not 254.
- The `version > 1` guard is `generate-draft.ts:**107**`, not :106 — the ticket and spec §6.3b are one line stale; cite 107 and note the drift.

Independently confirmed by the orchestrator before codex reported: `persist.ts:86-90` predicate, `job-outbox-status.ts` ordering, `statusArraySql`, `APPROVAL_METHOD`, `enqueueGenerateResponse(tx, input)`, `QUEUE_NAMES.GENERATE_RESPONSE`, no `origin_lane` CHECK in migrations, `ioredis` `.mget()` availability.

## Orchestrator-found, pre-codex

**F0 (Medium, fixed in plan already).** The plan's separate `getOffboardingState` + `isProcessingBlocked` call in the Generate route is redundant — `assertWritableSubscriptionForAccount` resolves offboarding in the **same query** (`LEFT JOIN account_offboardings`) and returns `403 account_offboarding_blocked`. Removed.

## Orchestrator-found, pre-round-2 (F3 was described, not applied)

Found while building the round-2 brief, before dispatch. The round-1 commit
(`7300c480`) recorded F3 as a **rationale paragraph** under Task 4 but never
edited the artifacts a subagent actually executes:

- Task 4 Step 1's SQL block still had only `fail_sidecar` / `draft` / `pending_gen`
  — no orphan LATERAL, no `is_orphan` column — while its header said "two LATERALs".
- The Self-review "Known gap for the reviewer" still asserted the **pre-fix**
  design (`is_orphan` set by caller discipline, orphan rows from a separate
  query), directly contradicting the F3 paragraph 270 lines above it.
- The file-structure table row still carried the pre-F7 `ORDER BY`.

Impact had it shipped: Task 4 produces the `LEFT JOIN` **without** deleting the
separate orphan query, which is precisely the double-render + un-offset-`LIMIT 50`
defect F3 was raised to prevent — F3 would have been marked addressed while the
bug remained. Verified against source before fixing: the orphan query is live at
`load-replies.ts:162-205`, and `OrphanRow`/`toOrphanCardRow` live in
`replies-view.ts:28,:100` (the plan said `types.ts`).

Applied: Step 1 gains `orphan_sidecar` + `orphan_superseded` LATERALs and the
`is_orphan` column; new Step 2a deletes the separate query, the `bucketReplies`
merge, and the stale import; Task 5 Step 2b drops `groupReplies`' second
parameter; the "known gap" note is retired; the table row is corrected.

**Lesson (same class as F4's fabricated citation):** a review fix that lands as
prose *about* the change, rather than as an edit *to* the executable step, reads
as addressed at every later checkpoint. Round 2's brief asks specifically whether
each fix reached the artifact a subagent runs, not whether the plan discusses it.

## Noted, not accepted

Codex emitted `"The gate is running now"` after its `verify-gate.sh` invocation was **declined** by its own sandbox policy (correctly — the gate provisions the test DB and would drop the schema under a read-only audit). No gate ran during this review. It self-corrected in its final message. Recorded so no later reader mistakes that line for gate evidence.

## Round budget

Plan review rounds: **1 of 3 used.** Round 2 is verification-only — the reviewer checks these fixes landed and may flag defects a fix introduced, but may not open new fronts against unchanged plan sections.
