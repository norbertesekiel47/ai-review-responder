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

## D7 — Task 5: Step 2's `rg` gate contradicts Step 1.3's own verbatim comment

Step 1.3 supplies replacement comment text that **names the retired flag**
("…retired the companion UI flag `PAST_REPLIES_VIEW_ENABLED`…"), and Step 2 then
expects `rg -n "PAST_REPLIES_VIEW_ENABLED" worker/` to print **nothing**. Both
cannot hold. Followed Step 1.3 literally, so the grep prints exactly one hit —
line 74, inside that comment. The gate's *intent* (no surviving set/restore
site) is met and provable with a comment-excluding grep:

```bash
rg -n "PAST_REPLIES_VIEW_ENABLED" worker/ | rg -v '^\S+:[0-9]+:\s*//'   # → no output, exit 1
```

Recorded rather than silently reworded because the comment is the change's
documentation value: it is the thing that stops the flag being re-added, and it
must agree with CONTEXT.md:30. A future reader running Step 2 verbatim will see
the same single hit and should not treat it as an incomplete removal.

**Two incidentals, no action needed.** (a) The `afterAll` comment "Restore the
three env vars that `vi.hoisted()` overwrote" was *stale before* this change
(four were overwritten) and is now **accurate** — three overwrites survive
(`DATABASE_POOL_URL`, `ALLOW_E2E_DB_WRITES`, `EDIT_REPLIES_ENABLED`);
`TEST_DATABASE_POOL_URL` is set-if-absent by the `.env.local` loop, not
overwritten. Left as-is. (b) Committed with the pathspec form
(`git commit -m … -- <file>`) instead of Step 4's `git add` + `git commit`:
identical result here (`git diff --cached` was empty), but `git commit` commits
the whole **index**, so with Tasks 2-4 editing the same worktree a sibling agent
staging a file between this task's `add` and `commit` would have been swept into
this commit. The pathspec form cannot do that. Worth promoting into the plan
template's concurrency note for any future parallel-task bundle.

---

## D6 — Task 4: Step 3's verbatim doc comment fights Step 5's own grep gate

**(a) The plan's replacement comment re-introduces the name Step 5 forbids.**
Step 3's verbatim text opens ``#731 deleted the single-key sibling
`peekRegenBudget`.`` — a prose mention, but `rg -n "peekRegenBudget\b"` cannot
tell prose from a call, so following Step 3 literally guarantees Step 5 reports
one hit *in production code*, whose stated triage is "the intake's caller
analysis was wrong — STOP and report". Resolved by keeping the fact and dropping
the identifier ("deleted the single-key sibling"): the gate stays clean and stays
a true signal for the next reader, and the identifier survives where it belongs —
the commit subject (`delete peekRegenBudget, one advisory-peek contract
survives`) and therefore `git log -S`. Nothing else in Step 3's text changed.

**(b) Two comment references lived outside the file Step 2 names.**
`regen-budget-batch.test.ts:3` ("the batched sibling of `peekRegenBudget`") and
`:102` ("the same UTC-date-scoped keys `peekRegenBudget` uses") both named the
deleted function. Step 2 names only `tracker.test.ts`'s `describe` block, so the
plan's triage rule — "a hit in a test file means Step 2 missed something" — would
have sent the next reader hunting for a deletion that was never incomplete. Both
rewritten to describe the surviving contract (`:3` now records that this suite
owns the whole used/limit/remaining derivation since the single-key peek went
away). Same class as D7(a) in Task 5: the gate was specified against *call sites*
while the change also moves *prose*.

**(c) D3(c)'s prediction held exactly, and the extra assertion was needed.**
Observed before the rewire: titles 1 and 2 RED, titles 3 and 4 GREEN via the
swallowed `TypeError`. After: all four green through the intended path. Title 3
now carries the authorised
`expect(mockPeekRegenBudgetBatch).toHaveBeenCalledWith([REVIEW_ID])`, so it can
distinguish rewired-correctly from returns-null-for-some-other-reason; title 4
(`never leaks the raw review id`) stays assertion-conditional-on-a-log by design
and is still not evidence of the wiring on its own. All four title texts
unchanged.

**Verified while there, no action.** The new doc comment's "Two callers" claim is
accurate — `src/lib/past-replies/load-replies.ts` is the batch caller and the
enforcer is now the single-id caller. `createWorkerLogger` is still live at
`dashboard-regen-rate-limit.ts:58` for `rate_limit_exceeded`, so deleting the
budget path's `catch` did not orphan the import. On the sibling entry's
incidental (b) above: this task did use `git add <paths>` + `git commit`, but
checked `git status --porcelain` between the two and confirmed only its own five
paths were staged (Task 3's two `past-replies` files were dirty-but-unstaged at
that instant). The pathspec form is still the better default.

---

## D5 — Task 3: a FOURTH landmine in `reviews-list.test.ts`, and Step 6's snippet source does not exist

**(a) The merge breaks a pre-existing #678 title the plan never names — a third
assertion in that file, not just landmines 2 and 3.**
`'loadPastRepliesPageView averages star rating over all reviews, not only replied
ones'` (`reviews-list.test.ts:399`) locates the AVG query by `/AVG\(/i` and then
asserts `expect(avgQuery.text).not.toContain("'posted'")`. Post-merge the AVG
lives in the same template as the partitioning `CROSS JOIN LATERAL (… p.status =
'posted' …)`, so the literal is present and the title fails — the only red in
Step 4's run:

```
AssertionError: expected '\n      SELECT\n        COUNT(*) FILT…' not to contain '\'posted\''
 ❯ src/lib/past-replies/__tests__/reviews-list.test.ts:407:31
```

The title's *claim* survives the merge intact (nothing restricts the AVG's own
row set: `FROM reviews r` + `WHERE r.business_id = …`, single conjunct). Only its
*mechanism* — "the string `'posted'` appears nowhere in this query" — was an
artefact of the AVG having had a template to itself. Fixed by stripping the
partitioning LATERAL and re-applying **both** original assertions verbatim to the
remainder, plus two positive pins on the surviving FROM/WHERE so the title still
fails if a future edit narrows the AVG's row set:

```ts
const outsideLateral = avgQuery.text.replace(/CROSS JOIN LATERAL \([\s\S]*?\) posted/i, '');
expect(outsideLateral).not.toMatch(/JOIN\s+responses/i);
expect(outsideLateral).not.toContain("'posted'");
expect(outsideLateral).toMatch(/FROM\s+reviews\s+r\b/i);
expect(outsideLateral).toMatch(/WHERE\s+r\.business_id\s*=/i);
```

No assertion was deleted and no title text changed. Worth promoting into the plan
template's landmine method: the recon enumerated assertions that count queries
(landmine 2) and assertions that dispatch on query text (landmine 3), but missed
assertions that **identify** a query by text and then constrain it — a merge
changes what a text-matched query *contains*, not only how many there are.

**(b) Step 6's "take the exact expected text from the failure output" is
impossible — `ci:tenant-scope` never prints SQL.** The audit reports only
`file: table: reason` triples:

```
src/lib/past-replies/load-replies.ts: responses: unused tenant scope allowlist entry   (×2, the orphaned COUNTs)
src/lib/past-replies/load-replies.ts: responses: missing account_id or business_id scope  (the unexempted merge)
```

`TenantScopeFinding` (`scripts/ci/tenant-scope-audit.ts:12`) carries no SQL
field, so there is nothing to paste — and the step's own warning ("a guessed
snippet is the #1 way this step burns a round") is exactly right, which makes the
missing output a real dead end rather than a cosmetic one. Derived it instead by
reusing the audit's own extractor and normaliser, which is what the match
actually keys on (`getAllowlistEntry`: `normalizeSql(stripSqlComments(x))` on
both sides):

```ts
// scratchpad, throwaway
const { extractSqlTemplates } = await import(`${ROOT}/scripts/ci/tenant-scope-audit.ts`);
for (const t of extractSqlTemplates(readFileSync(target, 'utf8'))) {
  const norm = t.sqlText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ').replace(/\s+/g, ' ').trim();
  if (/unanswered_total/i.test(norm)) console.log(norm);
}
```

First try, no burned round: `pnpm ci:tenant-scope` → `passed — entries: 408
(baseline: 408)`. `normalizeSql` and `stripSqlComments` are module-private, so
the two-line re-spelling above is the whole cost; the durable fix is either to
export them or to put the normalised SQL on the finding. Recommend the latter —
every future allowlist regeneration (this is the fourth: 420→418→414→412→409→408)
hits the same wall.

---

## D8 — `origin/main` moved mid-run (#747 merged), and the orchestrator fell into D2's trap while measuring

**What happened.** PR #747 (`Harden authenticated dashboard design system`) was
merged to `main` as `3887707d` by a different session *while Tasks 2-5 were
running*. My fork point stayed `352d5c1d`.

**The trap.** Measuring the reclassify buckets, I ran `git diff origin/main
--numstat` and got **3,075 changed production lines** against a 200-line
estimate — a 15× overshoot that would have fired the re-classification trigger
and, under the abort criteria, argued for tearing the branch down. The diff
listed ~60 files I had never touched: `_styles/*.css`, `SettingsModal.tsx`,
`Sidebar.tsx`, `TopBar.tsx`, a deleted `src/lib/client-response.ts`.

It was #747's work rendered **backwards**, because my branch did not yet contain
it — **precisely the failure mode I had written up as D2 two hours earlier and
warned the next reader about.** Knowing the trap in the abstract did not stop me
walking into it, because the symptom (a huge unexplained diff) does not resemble
the cause (a moved baseline).

**Correct measurement**, against the merge base:

| Bucket | Estimate | Actual | Ratio | 2× threshold |
|---|---|---|---|---|
| Production (`src/`, `scripts/`, `worker/`, excl. tests) | 200 | **290** | 1.45× | under |
| Test (`**/__tests__/**`) | 230 | **430** | 1.87× | under |

Both under threshold, so **no reclassify fires** — consistent with the gate
emitting no `reclassify` WARN row. The lane was correctly chosen.

**Interaction risk, checked rather than assumed.** #747 touched
`dashboard/reviews/history/page.tsx` and `PastRepliesClient.tsx` — the *only two
production consumers* of `PastRepliesPageView`, i.e. exactly the surface Task 3
reshapes. Inspected: a hex literal → `var(--rw-app-text-soft)`,
`role="tablist"` → `role="group"` + `aria-pressed`, and one CSS import. Nothing
reads `unansweredTotal` / `answeredTotal` / `avgStarRating` differently, and the
`'3 of 47'` / `'2 of 3'` assertions are client-side filtering over props,
indifferent to which query produced the denominators.

`comm -12` over the two branches' changed-file lists returns **empty** — the file
sets are wholly disjoint — and `git merge origin/main` applied with no conflicts.

**Verdict: ACCEPT.** No amendment (surface unchanged), no gate-fail round. The
merge is in the branch and the gate was re-run on the merged tree.

**Durable lesson (promote at step 8, and it supersedes D2's weaker phrasing):**
*never measure a feature's diff against `origin/main` — always against
`git merge-base origin/main HEAD`.* On a long-running branch `main` can move
underneath you mid-run, and the resulting inflation is indistinguishable from
genuine scope creep at exactly the moment the workflow asks you to judge scope
creep. `scripts/verify-gate.sh`'s own `reclassify` row already does this
correctly; the hand-run measurement is what needs the discipline. Worth wiring
the merge-base form into the plan template so it is not re-derived per feature.

---

## D9 — `reclassify` WARN fired on the TEST bucket after the fix round; step 0 re-run, lane UNCHANGED

The gate's `reclassify` row went WARN after the round-1 fix round:

```
RECLASSIFY: test 490 > 2x estimated_test_lines (230) changed lines
(workflow artifacts excluded) — re-run step 0 (re-classification trigger).
```

This is a mandatory STOP-and-re-derive trigger, so step 0 was re-run against the
real figures rather than the WARN being noted and walked past.

| Bucket | Estimate | Actual | Ratio | Trigger |
|---|---|---|---|---|
| Production (`src/`, `scripts/`, `worker/`, excl. tests) | 200 | 323 | 1.62× | no |
| Test (`**/__tests__/**`) | 230 | **490** | **2.13×** | **yes** |

**Step 0 re-derivation, from the shipped diff rather than from the plan:**

- **RISK — still `normal`.** No migration and no schema change; nothing under
  `worker/` except a test file; no billing/Stripe surface; no auth surface; no
  write to an approval method; the authoritative per-review-daily-cap gate (the
  worker's Lua INCR) untouched. Every RISK=high trigger is absent, and the fix
  round changed a read query's join shape and added test coverage — neither
  moves the risk domain.
- **SURFACE — `mixed` as declared, and deliberately not narrowed.** The shipped
  diff touches no `src/app/` or `src/components/` file, so the literal reading is
  `backend`; the intake declared `mixed` because the page view feeds a server
  component. Consequence of leaving it: the gate also ran `build`. That is a
  superset of what `backend` would have run, so the declaration cost extra rigour
  and bought no blind spot — not worth an amendment to correct downward.
- **SIZE — still `normal`.** 813 changed lines over 7 source + 7 test files, one
  seam per item. Every *epic* trigger is negative: the surface was declared tight
  at intake and **never amended** (0 amendments), it spans one risk domain, it
  decomposed into 6 tasks (not >8), and no investigation question was left open.

**Conclusion: the lane was right; my test estimate was wrong** — and wrong in the
specific way this workflow already warns about. I estimated 230 test lines
against 200 production, a ratio of ~1.15:1, and the intake guidance says
verbatim that *"estimating tests at 1:1 fires the reclassify trigger on exactly
the features whose test rigour is most worth having, the #643 lesson."* I read
that line, wrote the two estimates separately as instructed, and still anchored
the test figure to the production one. The actual ratio is 490/323 ≈ **1.52:1**,
which is unremarkable for a feature whose deliverable is 14 pinned titles across
five suites plus a live-Postgres partition guard.

Where the overshoot came from also matters: the largest single contributor is the
**fix round** (`regen-budget-batch.test.ts` +99, `dashboard-regen-rate-limit.test.ts`
reshaped), i.e. tests added *because the review found a coverage hole*. A trigger
that pushes toward a heavier lane for having fixed a review finding is reading
the signal backwards, so the honest response is to correct the estimate, not the
lane.

**Escalation to the RISK=high lane was considered and declined.** That lane's
distinguishing control is a staging ride, and staging exists to exercise the
worker, the queue, webhooks and migrations in lockstep — **none of which this
branch touches**. A staging ride here would burn a deploy cycle to observe
nothing. Flagged to the owner in the final report so the call is visible and
overridable rather than buried in a WARN row.

**Verdict: ACCEPT, no lane change, no amendment.** Recorded because a WARN that
is reasoned past without a written record is indistinguishable from a WARN that
was ignored.

**Durable lesson (promote at step 8):** estimate the test bucket from the
*number of pinned titles and the suites they span*, not as a ratio of the
production estimate. For this branch a bottom-up count — 14 titles × ~25 lines
of body/fixture, plus harness reshaping in 5 suites — lands near 450 and would
not have tripped anything.

---

# Step 6 triage — orchestrator verdicts (2026-08-09)

Read end to end before any review dispatch. D1 and D2 carry their verdicts
inline above (both ACCEPT, both recorded pre-implementation).

**Every D3–D7 entry is a defect in MY plan, not in the implementation.** Each was
found by the agent executing the step, fixed without deleting an assertion,
widening a surface, or changing a locked title. That is the eval-first
discipline working as designed, and it is worth saying plainly: five of the seven
entries exist because the plan's *verification commands* were wrong while its
*substance* was right.

| # | Verdict | Reasoning |
|---|---|---|
| D3(a) | **ACCEPT** | `REVIEW_STATUS.RESPONDED` was my invention; `POSTED` is the real vocabulary and is what the suite's own fixtures seed. Would have been a `TS2339`, not a silent pass. |
| D3(b) | **ACCEPT** | `responses_one_posted_per_review` makes "multiple posted responses" **structurally unreachable**, so the intake `edge_cases` entry naming it is VOID — not untested. The agent kept the one-row fixture and documented the index instead of branching around an impossible state, which is the correct call (`.claude/CLAUDE.md`: assert impossible states, don't branch around them). No new assertion was invented to fill the gap; good. |
| D3(c) | **ACCEPT — actioned** | Two of four titles passed coincidentally because the pre-change `try/catch` swallowed the `TypeError` and returned `null`. I folded a `toHaveBeenCalledWith([REVIEW_ID])` requirement into Task 4's dispatch; Task 4 confirms all four now pass **through the intended path**. Hole closed. |
| D4 | **ACCEPT** | Step 4's `grep -A2 'orphanReplyFacts'` cannot match — TS anchors the error at the object literal and names the structural types, never the enclosing function. My stop condition would have fired a **false STOP on a correct refactor**. The substance held: TS2741 at `replies-view.ts(257,3)` naming `failed_response_id` was observed, so the `Required<>` guarantee is proven, which was the whole point of Task 2. |
| D5(a) | **ACCEPT — highest signal on the branch** | A **fourth** landmine my recon missed. I enumerated assertions that *count* queries and assertions that *dispatch* on query text, but not assertions that **identify** a query by text and then constrain its contents. `'…averages star rating over all reviews…'` asserts `not.toContain("'posted'")` on the text-matched AVG, which the merge breaks by putting the partitioning LATERAL in the same template. The fix strips the LATERAL and re-applies both original assertions verbatim to the remainder plus two positive FROM/WHERE pins — strictly stronger than what it replaced, and no title text or assertion was deleted. |
| D5(b) | **ACCEPT** | Step 6 instructed pasting SQL from `ci:tenant-scope`'s output; `TenantScopeFinding` has no SQL field, so the audit prints only file/table/reason. The step was a dead end as written — and its own warning about guessed snippets was right, which is what makes it a dead end rather than a nuisance. Deriving the snippet by reusing the audit's own `extractSqlTemplates` + normaliser is the correct workaround and landed 408 first try. |
| D6 | **ACCEPT** | My Step 3 replacement comment named `peekRegenBudget` in prose, which Step 5's own `rg` gate would then have reported as a production hit and demanded a STOP for. Plan self-contradiction; the agent kept the fact and dropped the identifier. |
| D7 | **ACCEPT** | Same class as D6 in Task 5: Step 1.3's replacement comment names `PAST_REPLIES_VIEW_ENABLED` while Step 2 demands the grep print nothing. Resolved the OPPOSITE way to D6 — the name was **kept** — and that asymmetry is deliberate and correct, not drift: this comment's whole job is to warn a future reader off reintroducing a retired flag, which requires naming it (`CONTEXT.md:30` names it for the same reason), whereas D6's comment explains a completed consolidation whose fact survives without the identifier. |

**Abort-criteria check:** 0 gate-fail rounds, **0 amendments to
`allowed_edit_surface`** (the five paths were declared at intake, per the
ticket's own instruction), and no entry invalidates a locked intake *decision* —
D3(b) voids an *edge case*, which is a correction, not an invalidation. Nowhere
near teardown. Proceed to the gate and then review.

## Durable lessons — promote at step 8

1. **A grep gate that forbids a string forbids it in prose too.** D6 and D7 are
   the same defect twice: a plan step said "this identifier must not appear" and
   then a sibling step wrote a comment that legitimately names it. Scope such a
   gate to code (`rg … | rg -v '^\S+:[0-9]+:\s*//'`) or expect a false positive.
2. **Landmine enumeration needs a third category.** Before merging or reshaping a
   query, find assertions that (i) count queries, (ii) dispatch on query text,
   **and (iii) identify a query by text then constrain its contents.** (iii) is
   the one that bites, because a merge changes what a text-matched query
   *contains*, not just how many exist. (D5(a))
3. **`ci:tenant-scope` cannot tell you the snippet it wants.** Four
   regenerations (420→418→414→412→409→408) have each hit this. Either export
   `normalizeSql`/`stripSqlComments` or put the normalised SQL on
   `TenantScopeFinding`. Worth its own ticket.
4. **Never verify a type-level guarantee by grepping for the enclosing function
   name.** TypeScript reports structural-assignability errors at the offending
   literal and names the types, not the function. (D4)
5. **Under concurrent task dispatch, commit with a pathspec** (`git commit -m … --
   <files>`), never bare `git add` + `git commit`: the latter commits the whole
   index, so a sibling agent staging between the two calls is swept into your
   commit. Two agents independently reached for this. (D7)
