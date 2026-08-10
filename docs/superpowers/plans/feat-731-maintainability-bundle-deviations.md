# feat-731-maintainability-bundle — deviations

Entries are things the plan did not anticipate. Every entry gets a triage verdict
(ACCEPT / RE-PLAN) at step 6, before any review agent is dispatched.

---

## D1 — Surface overlap with #740 (`feat-719-drip-dropped-column`): ACCEPTED, no merge-order constraint

`scripts/feature-setup.sh` flagged one code-pair collision:
`scripts/ci/tenant-scope-allowlist.ts`, also declared by the armed worktree
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-719-drip-dropped-column`
(PR #740, `fix(#719)` onboarding drip dropped-column repair).

Investigated at intake, before planning. The two edits are **region-disjoint and
semantically independent**:

| | #740 (PR open, `CONFLICTING`) | #731 (this branch) |
|---|---|---|
| Region | `ONBOARDING_DRIP_CANDIDATES_SQL`, ~line 128–140 | ledger comment ~line 51–69, `ALLOWLIST_BASELINE` line 70, three `load-replies.ts` entries ~line 1284–1304 |
| Entry count | unchanged | 3 entries → 1 (**shrink**) |
| `ALLOWLIST_BASELINE` | **not touched** (verified: `git diff <merge-base> HEAD -- scripts/ci/tenant-scope-allowlist.ts` contains no `ALLOWLIST_BASELINE` line) | 409 → 408 |

Because only one side moves the baseline, neither branch has to re-derive the
other's number — the failure mode the earlier charting note worried about
("both must regenerate the SAME three pinned entries") does **not** materialise:
#740 regenerates a *different* constant (`ONBOARDING_DRIP_CANDIDATES_SQL`), and
#731 regenerates the three `load-replies.ts` entries. The two regions are ~58
lines apart, well outside git's 3-line merge context.

**Agreed order: either, recommended #731 first.** #740 is currently
`mergeable: CONFLICTING` and needs a rebase for unrelated reasons, so it will
rebase onto a `main` that already carries #731; that rebase is textual and clean.
Nobody is actively working #740 (parked pending rebase), so no live coordination
is needed. Surfaced to the owner at step 3 so the fact travels with #740 when it
is resumed — **not** written into #740's own deviations file, because editing
another armed worktree from this session would cross that worktree's
edit-surface guard.

**Verdict: ACCEPT.** No surface narrowing, no amendment, no amendment-budget
charge (`allowed_edit_surface` is unchanged from the locked intake).

---

## D2 — PR #747 (`codex/authenticated-dashboard-design-audit`) is NOT a collision

Recorded because it looked like one and the next reader will hit the same trap.

The parent checkout sat on `codex/authenticated-dashboard-design-audit` (PR #747)
whose `git diff origin/main -- src/lib/past-replies/load-replies.ts` shows a
15-line diff that **inverts #730's `openFlagExistsSql` composition** — it appears
to revert merged work on a file this bundle edits.

It is pure branch staleness, not a revert. #747's merge base is `76b40b7b`,
which predates #730; diffing a stale branch against a moved `main` renders the
newer commit's change backwards. Against its own merge base the branch touches
**none** of this bundle's files:
`git diff $(git merge-base origin/main HEAD) HEAD -- src/lib/past-replies/ src/lib/costs/ src/lib/shared/ scripts/ci/ worker/` is empty, and the PR reports
`mergeable: MERGEABLE`.

**Lesson (promote at step 8):** when checking a feature's file-set collisions
against open PRs, diff each branch against **its own merge base**, never against
current `main`. The latter reports every commit the branch simply hasn't merged
yet as an outgoing change, which reads exactly like a revert.

**Verdict: ACCEPT** (no action; documentation only).

---

## D3 — Task 1 (EVAL): three defects in the plan's verbatim step code

All three found while authoring the 14 locked titles. The **titles** are
untouched (`ALL 14 PRESENT` passes); only the plan's surrounding code was wrong.

**(a) `REVIEW_STATUS.RESPONDED` does not exist** — Step 6, title *"a review with a
posted reply counts once as answered…"*. The canonical vocabulary
(`src/lib/reviews/status.ts:23-32`) is `new | generating | pending_approval |
approved | awaiting_manual_post | posted | failed | deleted`. Used
`REVIEW_STATUS.POSTED`, which is what every existing answered fixture in the same
suite already seeds (`:200-201`). Left unfixed this was a `TS2339` plus an
`undefined` bind, not a silent pass.

**(b) Step 6's "Two posted rows for ONE review" is schema-impossible** — the plan's
own code inserts exactly one, and `responses_one_posted_per_review`
(`supabase/migrations/031_edit_existing_replies.sql:41-43`, `UNIQUE (review_id)
WHERE status = 'posted'`) forbids a second. Intake edge case *"A review with
MULTIPLE posted responses (defensive)"* is therefore **structurally
unreachable**, not merely untested. Kept the plan's one-row code and rewrote the
comment to state the index and to re-ground the EXISTS-not-join rationale on the
review's non-posted siblings. **No new assertion was invented.**

**(c) Step 9's red prediction is wrong: 2 of the 4 `enforceRegenBudgetForReview`
titles are GREEN today, for the wrong reason.** The plan expected all four to fail
with `TypeError: peekRegenBudget is not a function`. That TypeError *is* thrown —
but `dashboard-regen-rate-limit.ts:93-102` **catches it** and returns `null`
(fail-open). So every title whose only assertion is `toBeNull()` passes:

| Title | Plan | Observed | Why |
|---|---|---|---|
| …reports remaining above zero | FAIL | **FAIL** | `toHaveBeenCalledWith([REVIEW_ID])` — 0 calls |
| …returns 429 …zero remaining | FAIL | **FAIL** | `expected null to be an instance of NextResponse` |
| …returns no entry for the review | FAIL | **PASS** | swallowed TypeError also returns `null` |
| never leaks the raw review id (kept) | FAIL | **PASS** | assertion is conditional on a log |

The two greens are *coincidental*, not evidence: nothing today calls the batched
peek at all. Item 3 still has genuine red cover from the first two titles, and all
four go green through the intended path once Task 4 rewires the enforcer.

Deliberately **not** "fixed" by adding a call-assertion to the third title: that
would edit a locked title's body beyond the plan, and title 1 already pins the
call shape. Flagging for triage instead — the orchestrator may want Task 4's
verification step to assert `mockPeekRegenBudgetBatch` was called on all three,
since two of them cannot distinguish rewired-correctly from
still-broken-but-swallowing.

**Also worth carrying forward (not a deviation):** this suite reads
`process.env.TEST_DATABASE_POOL_URL` at module scope and vitest loads no dotenv,
so `.env.local:301` alone does **not** wake it — the var must be exported on the
command line, exactly as Task 3 Step 5 already notes. A bare
`pnpm vitest run …integration.test.ts` self-skips.

---

## D4 — Task 2 Step 4: the `Required<>` proof command greps for a string TypeScript never emits

**The guarantee itself holds.** Deleting the `failed_response_id` line from
`orphanReplyFacts` produces, as promised:

```
src/lib/past-replies/replies-view.ts(257,3): error TS2741: Property
'failed_response_id' is missing in type '{ response_id: string | null;
approved_text: string | null; approval_method: null; posted_at: null;
version: null; failed_posting_error: string | null; }' but required in type
'Required<Pick<ReviewsListRow, "response_id" | … | "failed_posting_error">>'.
```

**Observed code: TS2741** (the single-property form; the plan's alternative
TS2739 is the ≥2-missing-properties form, so it would appear only if a mapper
dropped two fields at once). The line was restored immediately.

**But the plan's verification command reports nothing.** Step 4 says to run
`pnpm typecheck 2>&1 | grep -A2 'orphanReplyFacts'`. TypeScript anchors an
assignability error at the **returned object literal's position** and describes
the two structural types — it never names the enclosing function. So that grep
emits zero lines, which under Step 4's own stop condition ("if it does not
appear the `Required<>` wrapper is not doing its job and this refactor is
unsafe") reads as a mandatory STOP on a refactor that is in fact correct. A
worker following the command literally aborts the task.

Correct command — grep the file and the code, not the function name:

```bash
pnpm typecheck 2>&1 | grep -E 'replies-view\.ts.*TS27(39|41)'
```

Nothing was changed in production code because of this; recording it so the
same false STOP does not fire the next time the guarantee is re-verified (e.g.
if a reviewer asks for the proof, or if a future field joins `ReplyFacts`).

**Concurrent-task noise seen at Step 5, for the record:** `pnpm vitest run
src/lib/past-replies src/components/dashboard/reviews` failed 14 then 2 tests
across two runs, every failure inside `reviews-list.test.ts` and originating at
`load-replies.ts:341` (`ReferenceError: unansweredCountRows is not defined`,
then the AVG-query assertions) — Task 3's file caught mid-refactor, not a
regression from the split. `replies-view.test.ts` was 37/37 and all nine
`src/components/dashboard/reviews` suites were green in every run. Worth a line
in the plan's concurrency note: Task 2's Step 5 command reaches into Task 3's
file set, so its "all PASS" expectation cannot hold while the two run in
parallel. Task 2's honest boundary is `replies-view.test.ts` +
`src/components/dashboard/reviews`.

---
