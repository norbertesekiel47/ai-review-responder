# feat-860 — round 1 triage

Round 1 of 3 (`branchReviewRounds=1`). Three axes, RISK = high.
Verdicts below are the orchestrator's, each verified against the code by hand —
not accepted on a reviewer's word. Reports: `spec-correctness.md`,
`standards-maintainability.md`, `adversarial-approach.md`.

## Convergence

Two defects were found INDEPENDENTLY by all three axes. Convergence across
axes that could not see each other is the strongest signal available here:

- **Panel remount** — spec #1/#2, standards (implicitly via test-quality), adversarial A3.
- **Redis MGET inside the read transaction** — spec #4, standards #1, adversarial A8.

## ACCEPTED — fix on this branch

| ID | Sev | Verdict |
|---|---|---|
| R1 | **High** | `ApprovalPanel` unmounts on every accepted regeneration (`retry()` → `LOADING` → `<LoadingCard/>`), resetting `excludedAsks`. **Silently re-selects every deselected ask.** VERIFIED by tracing regenerate → perform → onChanged → onLaneChanged → retry → setState(LOADING) → render switch. This is round-1 finding 6's user-visible harm arriving through a different door: the `askId` re-keying is correct and simply never gets the chance to matter. |
| R2 | **High** | Same remount destroys `pendingRegen` (a panel-local `useRef`), so `user_visible_behavior[6]` — "says nothing changed on a worker-side refusal" — is **unreachable in production**. Its two tests pass only because they `rerender` instead of remounting: hollow tests. VERIFIED. |
| R3 | **Med-High** | `peekAskRegenBudgetBatch` is awaited inside `readLatestBatch`'s `sql.begin` / `REPEATABLE READ`, holding an admission-gated pooled connection across an Upstash round trip on every built-batch GET and 2s poll. VERIFIED. Decisive: the cited precedent `load-replies.ts` does this peek OUTSIDE any transaction, so the branch deviated from its own stated pattern. Interacts with the #773 admission chokepoint. |
| R4 | **Medium** | The `budget_exhausted` guard (`approval.ts:623`) has **zero** coverage — every live-DB case passes `budgetRemaining: 3`, the route suite mocks the status. VERIFIED. On a feature whose premise is bounded LLM spend, the line enforcing the bound is untested; converting the `throw` to a `return` would commit the outbox row and spend money, suite still green. |
| R5 | **Medium** | `already_in_flight` returns at `approval.ts:578`, **before** `lockBatchForAction` proves ownership at :580. A foreign batch id that is regenerating answers 409; an unknown one answers 404 — a cross-tenant state oracle breaking the intake's uniform-404 invariant. VERIFIED: `withScopedBatch` only UUID-validates the caller-supplied `batchId`. **Spec-correctness cleared this incorrectly; adversarial A5 caught it.** No data leak (ON CONFLICT wrote nothing; the non-conflict path rolls back) — existence and activity leak. |
| R6 | Medium | `LANE_REFUSAL_COPY.not_regenerable` asserts "This batch has been approved" for `halted`/`expired`/`closed` too. The correcting `state` is already on the wire and discarded. Both spec #6 and standards #3. |
| R7 | Medium | Built batches now poll, making `stalled` reachable for a built approvable batch: after the 5-min ceiling the panel and every rendered message are replaced by the "Still processing" ghost and Approve disappears. Spec #3. |
| R8 | Medium | `aria-label` on the regenerate control overrides the button text, so "Writing a new version…" is invisible to assistive tech and "Regenerate" is absent from the accessible name (WCAG 2.5.3, Level A). The test uses `toHaveTextContent`, which passes regardless. Standards #6. |
| R9 | Medium | `docs/directory.md:900` still says "the **two** OWNER verbs"; `:706` still says "both … entrypoints". Same-diff drift — CLAUDE.md requires cross-references be fixed in the same change. Standards #5. |
| R10 | Medium | **Ask regeneration**'s `_Avoid_` terms used in ~6 places, incl. a comment at `dashboard-regen-rate-limit.ts:119` manufacturing a "rewrite" carve-out that `AskList.tsx:54` explicitly denies. Standards #7. |
| R11 | Low | `askRegenBudgetKey` interpolates the ask id verbatim with no canonicalisation (unlike `canonicalBatchId`), so a case-variant `askId` gets a fresh 3/day counter at BOTH the peek and the worker's authoritative INCR. Spec #5. A budget bypass, cheap to close. |
| R12 | Low | ADR 0020 names a `regenerate_solicitation_ask` topic that does not exist, contradicting `CONTEXT.md`'s LOCKED entry — the SHARED topic is exactly why per-batch dedup works. Standards #8, adversarial A7. |
| R13 | Low | No cross-origin test on the regenerate route; approve and halt both have one, and halt's exists precisely so no destructive verb is unasserted. Standards #9. |
| R14 | Low | `ask-generation.integration.test.ts:169`'s comment states a false reason for its raw topic literal; the real reason (sidestepping the in-flight partial unique index with a fictitious topic) is undisclosed. Standards #10. |

## ESCALATED TO OWNER — not mine to decide

| ID | Sev | Why escalated |
|---|---|---|
| A1 | **High** | Adversarial claims ADR 0020's prescribed recourse (halt + rebuild) forfeits the whole cohort for **30 days**, because `over_contacted` keys on `solicitation_asks.status='send'` and halt never clears it — and for 7 of 8 verticals the visit goes stale first, making the loss permanent rather than delayed. If true, the "accepted ergonomic cost" ADR 0020 recorded is materially understated. NOT independently verified yet. |
| A2 | **High** | Adversarial proposes post-approval per-ask **withdrawal** (cancel one outreach row inside the veto window) — an option ADR 0020 never considered. It is NOT post-approval regeneration, so it does not collide with the intake's `non_goals`, and it reportedly needs no per-ask approval state, no migration, and no coordination `haltBatch` does not already force. |

**Why these are escalated:** reversing or amending ADR 0020 is a locked decision
(intake `non_goals`: "this is the decision, not a deferral"), and the feature
workflow states an approach-level finding may mean revisiting step 3 rather than
patching code. RISK = high, so the remaining disagreement goes to the owner.

## REJECTED

| ID | Verdict |
|---|---|
| A4 | **Reject for this branch, record as follow-up.** Inverting the lock order inside `regenerateAsk`'s swap would dissolve the ABBA at its source and is arguably right — but it rewrites the WORKER's swap semantics, which the intake lists under `non_goals` ("Any change under `worker/`… already dispatches on `ask_id`"). Deliberately re-opening the worker's lock order during round-1 triage of a high-risk branch trades a verified-working arrangement for an unverified one. The enqueue-first order is mutation-checked and documented. |
| A6 | **Reject.** "Counts attempts charged, not versions produced" is the DOCUMENTED design — `CONTEXT.md` → **Ask regeneration** states the budget is charged per logical request and enforced in the worker, precisely so outbox replay cannot mint free spend. Adversarial disagrees with a recorded decision without showing it is wrong. |
| A7 | **Reject as stated, accept its factual half as R12.** That the shared topic makes "regenerate all" impossible is recorded in the intake as a structural fact and in `CONTEXT.md` as LOCKED. Re-keying the dedup is a different feature. The ADR's phantom topic name IS a real error → R12. |
