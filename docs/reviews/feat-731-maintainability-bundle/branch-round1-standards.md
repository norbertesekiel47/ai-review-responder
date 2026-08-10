# feat-731 maintainability bundle — round 1, standards & maintainability axis

**Skill run:** `thermo-nuclear-code-quality-review` (invoked successfully; no fallback to `code-review` needed).
**Diff under review:** `git diff 3887707d..HEAD` (fork point = `git merge-base origin/main HEAD` = `3887707d1a94406bb51d6db39f0da6e4ceededb2`; confirmed identical, so deviation D8's `origin/main` drift does not affect this review).
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-731-maintainability-bundle`
**Axis:** standards / maintainability only. Spec + correctness reviewed concurrently by a sibling agent; functional-bug findings deliberately left to them.
**Date:** 2026-08-09

---

## Verdict

**Approve with four items.** The bundle is genuinely net-simplifying on every axis this skill measures: no invariant violated, no interface widened, no file pushed past 1000 lines, no new abstraction for a single caller, no `any`, no unsanctioned silent catch, no glossary violation. Two of the four items delete a whole concept rather than rearranging it (the second advisory-peek contract; two of three denominator snapshots), which is the disposition the skill asks for.

One finding I would want closed before merge: **F1** — the branch silently reduced a logging-privacy assertion to a permanent no-op and left its title standing as if it were still coverage. Everything else is Low.

### Mechanical evidence gathered

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm ci:tenant-scope` | pass — entries: 408 (baseline: 408) |
| `pnpm ci:static-policy` | pass (1129 files scanned) |
| `pnpm ci:live-db-suites` | pass |
| `pnpm ci:db-imports` | pass (strict) |
| `pnpm ci:outbox-seam` | pass |
| 5 affected unit suites | 5 files / 99 tests passed |
| File-size threshold (1000 lines) | not crossed. `replies-view.ts` 309→385, `load-replies.ts` 374→389, `tracker.ts` 435→426, `dashboard-regen-rate-limit.ts` 117→116. `tenant-scope-allowlist.ts` (3172) was already over and **shrank** by one entry. |
| Glossary (`CONTEXT.md:30-31`) | **clean.** No added source line uses `the regenerate budget`, `regen budget`, `regeneration budget`, `backfill`, `Past Replies`, `the archive`, `History tab`, `on-demand drafting`, or `manual generation`. The two prose sites that previously said "the per-review regeneration cap"/"per-day regeneration cap" were corrected *toward* the locked term ("the per-review daily cap", "the advisory peek") — `dashboard-regen-rate-limit.ts:79`, `tracker.ts:357,364`, `dashboard-regen-rate-limit.test.ts:18`. The only occurrence of the forbidden phrase in the whole branch is the plan doc quoting it as forbidden. |

### Per-item disposition

1. **Seven ternaries → one dispatch to two private mappers.** Sound. The `Required<Pick<…>>` is load-bearing exactly as the handoff claims — `version`, `failed_response_id`, `failed_posting_error` are optional on `PastReplyRow`, so `Required<>` is what converts an omitted field from a #678-Defect-A-class silent bug into TS2741/TS2739. I verified the shape rather than taking it on faith. Neither mapper nor `ReplyFacts` is exported, so **the module interface did not widen** — the deep-module discipline holds: `toCardRow` still has exactly one public entry point and one dispatch. Not a shallow pass-through: `liveReplyFacts` carries a real Postgres.js `typeof` guard and two `??` narrowings, and the pair exists to satisfy a type, not to add a layer. I explicitly do **not** recommend collapsing the `Required<>`.
2. **Three snapshots → one `COUNT(*) FILTER` query.** Correct in substance and the right call. See **F2** for a simpler shape that reaches the same guarantee while deleting the LATERAL instead of adding it.
3. **`peekRegenBudget` deleted; caller uses `peekRegenBudgetBatch([id])`.** The best item in the bundle. It deletes a *contract*, not just a function: the module previously presented two opposite failure postures (throw-and-catch vs. resolve-to-empty-map) for one behaviour, plus a duplicated `used`/`limit`/`remaining` derivation. Post-change there is one. I did **not** treat the swallow-and-log in `tracker.ts:406-414` as a silent catch — it is the locked D-F posture, it logs on the shared `regen_budget_peek_failed` stream with `peek: 'batch'` + `subject_count`, and `getCacheRedis()` plus key-building are both inside the `try`, so the "no rejection path" claim in the callers' comments is actually true rather than aspirational. Collateral damage in **F1**.
4. **Retired-flag cleanup.** Complete for functional purposes. The only remaining `process.env.PAST_REPLIES_VIEW_ENABLED` reads/writes in the repo are the deliberate retirement-proof assertions in `flags.test.ts:52,73` and `past-reply-card-states.test.tsx:77,362,375,376` (tests that prove the list renders *without* the flag), and every other hit is a historical comment. `src/lib/reviews/process-review.ts:293` names the flag only to explain why `EDIT_REPLIES_ENABLED` is now the whole predicate — correct, not stale.

### Comment-density judgement (asked for explicitly)

I read the untouched neighbours first. The house style is real, and most added prose clears the bar of "states a constraint the code cannot show":

- `replies-view.ts:217-235` (`ReplyFacts`) — **earns it.** The reason `Required<>` cannot be relaxed is invisible at the call site (the optionality lives in `PastReplyCard.tsx`), and naming the TS error codes plus the prior defect is exactly the constraint a future simplifier needs. Two nits in the appendix.
- `load-replies.ts:304-328` — **paragraphs 1 and 3 earn it** (why one snapshot; why the AVG is unrestricted). Paragraph 2's planner claim is the weak one — see F2.
- `dashboard-regen-rate-limit.ts:93-101` and `load-replies.ts:364-370` — **earn it.** "Why there is no `catch` here" is precisely the thing a reader cannot see, and both sites name the observable log stream so the absence is checkable.
- The new test comments — mostly earn it; several encode *why a title cannot move to another suite* (`regen-budget-batch.test.ts:91-94`) or *why an assertion was reworded rather than deleted* (`reviews-list.test.ts:572-576`). I found no comment that merely narrates the code beneath it.

I found **no** instance of the smells this skill escalates: no new ad-hoc conditional bolted into an unrelated flow (net conditional count in `toCardRow` went 7 → 1), no one-off boolean or nullable mode, no feature logic leaking into a shared path, no bespoke re-implementation of a canonical helper in production code (one in a test — F4), no cast churn, no sequential orchestration that should be parallel (`Promise.all` retained, now 2-wide), and no atomicity regression (the change *increases* atomicity by construction).

---

## Findings

Only findings I would stake ≥80% on. Speculation is in the appendix.

| Severity | Location | Finding |
|---|---|---|
| Medium | `src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts:193-202` | The `never leaks the raw review id into the fail-open log` test is now permanently vacuous, and the logging-privacy contract it guarded has no replacement coverage anywhere. |
| Medium | `src/lib/past-replies/load-replies.ts:332-346` | Missed simplification: the `CROSS JOIN LATERAL` + two `COUNT(*) FILTER`s re-express, in a second join shape, what the row source 160 lines above already says with a `LEFT JOIN`. The same guarantee is reachable by deleting the LATERAL rather than adding it. |
| Low | `src/lib/past-replies/replies-view.ts:368`, `src/lib/past-replies/load-replies.ts:164` | Two comments still name the `NOT EXISTS` denominator this branch deleted. The identical claim *inside* the query block was updated; these two were not. |
| Low | `src/lib/past-replies/__tests__/load-replies.integration.test.ts:467-473` | Hand-rolled duplicate of `seedPostedResponse` (line 117). The file already solved this exact problem twice with an optional `bizId` param. |

---

### F1 — Medium — a logging-privacy assertion was reduced to a permanent no-op

**Location:** `src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts:193-202`
**Standard:** `.claude/CLAUDE.md` → Tech stack, Structured logging: *"Never log raw review/response text, tokens, secrets, or MFA codes."* Plus Working rules: *"Always write tests for … "* and the skill's bar on refactors that pass tests while weakening them.

Before this branch, `enforceRegenBudgetForReview` owned the fail-open `logger.warn`, so the test's guard was satisfied and its assertion ran:

```ts
it('never leaks the raw review id into the fail-open log', async () => {
  mockPeekRegenBudgetBatch.mockResolvedValue(new Map());
  await enforceRegenBudgetForReview(REVIEW_ID);

  if (mockWarn.mock.calls.length > 0) {          // ← pre-existing guard
    const logged = mockWarn.mock.calls[0]?.[0];
    expect(JSON.stringify(logged)).not.toContain(REVIEW_ID);
  }
});
```

After the rewire, `enforceRegenBudgetForReview` (`dashboard-regen-rate-limit.ts:90-116`) contains **no logger call at all** — the warn moved into `peekRegenBudgetBatch`, which this suite replaces wholesale at line 20-23. So `mockWarn.mock.calls.length` is provably always `0` on this path, the `if` never opens, and the test body executes zero assertions. It cannot fail. (The `if` guard is not the branch's fault — it is pre-existing — but the branch is what made it permanently false.)

The guarantee has **no replacement**: `src/lib/costs/__tests__/regen-budget-batch.test.ts` mocks no logger and asserts nothing about the `regen_budget_peek_failed` payload — `rg 'mockWarn|createWorkerLogger|subject_count|regen_budget_peek_failed'` over that file returns nothing.

Production is fine — `tracker.ts:407-412` logs `peek`, `subject_count`, `reason` and no ids — so this is a coverage loss, not a live leak. That is exactly what makes it worth flagging on this axis: the *title* survives and will be read as coverage by the next reviewer who greps for it, while the assertion that made it true is gone. A test asserting a contract it can no longer observe is worse than a deleted one.

**Remedy.** Move the assertion to where the log now lives: in `regen-budget-batch.test.ts`, mock `@/lib/shared/logger`, drive the `mget` rejection that suite already exercises at line 131-137, and assert the warn payload contains `subject_count` and does **not** contain `REVIEW_A`. Then delete the stranded title here rather than leaving it. Whatever else changes, drop the `if (…length > 0)` wrapper — a privacy assertion should fail loudly when its subject moves, which is precisely the signal this branch suppressed.

---

### F2 — Medium — the denominator merge adds a join shape where it could delete one

**Location:** `src/lib/past-replies/load-replies.ts:332-346` (query), `:316-318` (the justification), with knock-ons at `scripts/ci/tenant-scope-allowlist.ts:1297-1303` and `src/lib/past-replies/__tests__/reviews-list.test.ts:572-588`.
**Standard:** this skill's core demand — *"prefer solutions that remove moving pieces altogether over refactors that merely spread the same complexity around"* / *"if you see a path to delete complexity rather than rearrange it, push hard for that path."*

The merge is the right call and the guarantee it buys (an arithmetically closed partition) is real. My objection is to the *shape*. The new query introduces a construct the file did not previously contain:

```sql
COUNT(*) FILTER (WHERE NOT posted.has_reply)::int AS unanswered_total,
COUNT(*) FILTER (WHERE posted.has_reply)::int     AS answered_total,
AVG(r.star_rating)::float                         AS avg_star_rating
FROM reviews r
CROSS JOIN LATERAL (
  SELECT EXISTS (SELECT 1 FROM responses p WHERE p.review_id = r.id AND p.status = 'posted') AS has_reply
) posted
WHERE r.business_id = ${locationId}
```

Meanwhile the row source 160 lines above (`:203-205`) already expresses "does this review have a live posted reply?" as a plain `LEFT JOIN responses resp ON resp.review_id = r.id AND resp.status = 'posted'`. The denominator query and the row source must agree with each other by construction, yet a reader must now learn **two different encodings of the same predicate** to convince themselves they do.

The same three figures, with no LATERAL, no `FILTER`, and no `EXISTS` spelled at all:

```sql
SELECT COUNT(*)::int - COUNT(resp.id)::int AS unanswered_total,
       COUNT(resp.id)::int                 AS answered_total,
       AVG(r.star_rating)::float           AS avg_star_rating
FROM reviews r
LEFT JOIN responses resp
  ON resp.review_id = r.id AND resp.status = 'posted'
WHERE r.business_id = ${locationId}
```

Why this is equivalent rather than merely shorter:

- The LEFT JOIN **cannot fan out**, so `COUNT(*)` remains the review count. At most one posted response per review is guaranteed by the partial unique index `responses_one_posted_per_review` (migration 031) — and this diff's own new test asserts that guarantee out loud at `load-replies.integration.test.ts:460-463` ("ONE posted row is all the schema permits"). The correctness argument is already in the branch.
- The partition stays closed **by construction**, now by subtraction instead of by a matched pair of FILTERs: `unanswered + answered = COUNT(*)` is an identity, not two predicates a reader must verify are exact complements.
- `AVG(r.star_rating)` is still restricted by nothing but `r.business_id` — the join is LEFT, so it neither drops nor duplicates a review. The property the tile depends on is preserved.
- It uses the join shape this file already proved, so there is one plan shape to reason about instead of two.

It also retires three pieces of incidental cost the LATERAL created:

1. **The unverified planner claim at `:316-318`** — *"spelling it twice would plan two correlated subqueries per row"* — currently the sole justification for the LATERAL's existence, asserted with no `EXPLAIN` evidence in the branch's deviations doc. Under the LEFT JOIN the claim becomes moot rather than needing to be trusted.
2. **The test's regex surgery.** `reviews-list.test.ts:577-580` now has to textually excise the LATERAL out of production SQL (`text.replace(/CROSS JOIN LATERAL \([\s\S]*?\) posted/i, '')`) before it can assert what the title has always been about. An assertion whose meaning depends on the exact whitespace of a SQL literal is the kind of coupling this skill flags. (To its credit it fails *loud* if the strip misses — but it should not need to exist.)
3. **The allowlist `sqlSnippet`** at `tenant-scope-allowlist.ts:1301`, which grew to a ~300-character single line and must be kept byte-current with the query.

**Honest cost, stated so the owner can weigh it.** `reviews-list.test.ts:584` currently pins `expect(outsideLateral).not.toMatch(/JOIN\s+responses/i)` — under the LEFT JOIN shape the denominator query *does* join `responses`, so that pin has to be restated. Its intent ("the AVG's row set is every review for the location, not only replied ones") is still pinnable, and more directly: assert the join is `LEFT JOIN` and that no `WHERE`/`AND` clause outside the join condition references `responses`. That is a better pin than "there is no join," because the pre-#678 bug it guards against was an *inner* join, and the current phrasing bans a shape that is safe.

**If the LATERAL stays**, the minimum I would ask for is that the planner claim at `:316-318` be softened to intent ("evaluated once per review so the two FILTERs share it") or backed by an `EXPLAIN` in the deviations doc — a comment that justifies a structural choice with an unverified assertion about the planner is the one place in this branch where the dense-comment style works against the reader.

---

### F3 — Low — two comments still name the deleted `NOT EXISTS` denominator

**Locations:** `src/lib/past-replies/replies-view.ts:368`, `src/lib/past-replies/load-replies.ts:164`
**Standard:** `.claude/CLAUDE.md` → Working rules: *"When deleting a doc or ticking a checklist item, fix its audit tick and grep the filename to clean every cross-reference in the same change."*

The branch replaced the `NOT EXISTS` unanswered denominator with `COUNT(*) FILTER (WHERE NOT posted.has_reply)`, and correctly updated the claim *inside* the query block (`load-replies.ts:318-319`, now "the unanswered side already counts them"). Two cross-references to the retired construct survive:

- `replies-view.ts:368` — `` * `load-replies`' `NOT EXISTS` unanswered denominator already includes them. `` — a cross-*file* pointer to SQL that no longer exists.
- `load-replies.ts:164` — `// so the NOT EXISTS count already includes them), i.e. paginated like every` — 150 lines above the query it describes.

A reader who follows either one and greps `NOT EXISTS` in `load-replies.ts` finds only line 195, which refers to something else entirely (the #678-deleted *orphan* query — that one is **not** stale and should be left alone). In a codebase that deliberately leans on dense load-bearing comments, a comment naming a construct that no longer exists is the specific failure mode the density is meant to prevent.

Neither is caught by CI. Both are one-word fixes ("the unanswered `COUNT(*) FILTER`").

`reviews-list.test.ts:106` also mentions `COUNT(*)`+`NOT EXISTS` but correctly in the past tense, describing the legacy branches it replaced — correct, leave it.

---

### F4 — Low — the new integration test hand-rolls a duplicate of `seedPostedResponse`

**Location:** `src/lib/past-replies/__tests__/load-replies.integration.test.ts:467-473` vs. the existing helper at `:117-127`
**Standard:** `.claude/CLAUDE.md` → Working rules: *"no new file, no near-duplicate dependencies, no abstractions for a single caller"* (net-negative bias); this skill's *"copy-pasted logic instead of extracted helper."*

The new "a review with a posted reply counts once as answered" test writes its own 11-column `INSERT INTO responses`, byte-identical to `seedPostedResponse` (used five times at `:213,214,220,226,234`) apart from `business_id` and the reply text.

The blocker was only that `seedPostedResponse` hardcodes `businessId` and takes no override. The file has already solved that exact problem twice, with the same idiom both times: `seedReview` (`:100`) and `seedReplacementDraft` (`:136`) each end their signature with `bizId: string = businessId`. Adding the same optional parameter to `seedPostedResponse` was a one-line change; instead the `responses` fixture schema now has a second site to update, in a file whose established pattern points directly at the alternative.

Same remark for the co-located `'posted'` / `'owner'` literals — but note those match the untouched helper at `:124` exactly, so the new code is *consistent* with the file rather than an outlier, and folding into the helper removes the second copy anyway. Not worth a separate finding.

---

## Appendix — low-confidence observations (deliberately NOT in the table)

Recorded for completeness. I would not spend a review round on any of these.

1. **`replies-view.ts:333` — the spread sits mid-literal.** `...facts` is placed between `canEdit` and `reply_state`. No key collides today, so behaviour is exact. The latent hazard is that TypeScript does not error when a later spread overrides an earlier explicit property, so a future edit adding an explicit `version:` *above* line 333 would be silently discarded. Moving `...facts` to the first position in the literal makes explicit properties always win, which is the intuitive reading. Speculative — depends on a future edit that may never happen, and the `Required<>` type makes accidentally re-declaring one of the seven fields unlikely.

2. **`replies-view.ts:231-233` — dangling referents in the `ReplyFacts` JSDoc.** "deleting the `failed_response_id` line **here** reports `TS2741` at **this mapper's** `return {`" — but this doc block sits on the *type declaration*, which has no `return {` and is not a mapper. The sentence describes an experiment run in `orphanReplyFacts`/`liveReplyFacts` and reads as if it describes the type. Naming the mapper explicitly would fix it. Purely editorial.

3. **Only one `FILTER` is strictly needed.** Given the partition is closed, `unanswered_total` is derivable as `COUNT(*) - answered_total`. I do not recommend this *as a change to the current shape* — the symmetric pair is more legible than a subtraction when the LATERAL is present. It matters only as part of F2's alternative, where the subtraction is the thing that makes the identity structural.

4. **`emptyBusinessId` is caller-discipline-by-comment.** `load-replies.integration.test.ts:56-58` establishes a permanently-empty fixture whose invariant is held by a comment ("Kept deliberately empty — no test may seed into it"). This is the shape the production code explicitly rejects two files away (`load-replies.ts:192` — "orphan-ness is DATA, not caller discipline"). For a test fixture there is no cheap structural alternative, and the payoff — live-Postgres coverage of the zero-row aggregate path — is real. Noted, not asked for.

5. **`RegenBudgetStatus.remaining` is redundant** (`= max(0, limit - used)`), so the wire shape carries a derived field three ways. Entirely pre-existing, untouched by this branch, and the client renders all three. Out of scope; mentioned only because F2/item 3 put me in the neighbourhood.

6. **Considered and rejected: fold the denominators into the row source with window functions.** `COUNT(*) FILTER (WHERE resp.id IS NULL) OVER ()` in the main query would give one query, one snapshot, and would close the residual rows-vs-counts skew the comment at `load-replies.ts:312-314` openly concedes. I do **not** recommend it: it repeats three aggregate values on all 50 rows, widens `ReviewRow` (a type whose narrowness is load-bearing for `deriveAxes`), and makes the row source do two jobs. The comment is right that the residual skew cannot produce N > M, so the cost buys nothing. Recorded so a later reviewer does not re-litigate it.

---

# Orchestrator triage — round 1 (2026-08-09)

**F1 (medium — the privacy test is now permanently vacuous): ACCEPTED, FIXED in `27a57cc2`.** Reported independently by the spec axis as its F2. The guarantee was moved to where the log now lives — `regen-budget-batch.test.ts` gains `'the peek-failure warn carries subject_count and never a review id'`, mocking `@/lib/shared/logger` and asserting unconditionally that the payload is exactly `{event, peek, reason, subject_count}`. The vacuous test was **deleted**, not salvaged: a test whose `if` body cannot execute under any implementation is worse than no test. You were right that I had spotted this risk at planning time and chose to keep the test anyway — that was the wrong call, and "no replacement coverage anywhere" is what made it a finding rather than a nit.

**F2 (medium — missed simplification, `COUNT(*) − COUNT(resp.id)` over the existing LEFT JOIN): ACCEPTED, FIXED in `27a57cc2`.**
This one deserves a note, because I initially leaned toward **rejecting** it. My reasoning was robustness: `EXISTS` is correct at any cardinality, whereas counting join output is correct only while `responses_one_posted_per_review` holds, and trading a structural guarantee for concision seemed like the wrong direction in a ticket that exists *because* a denominator was subtly wrong.

The spec axis then produced `EXPLAIN ANALYZE` numbers showing the LATERAL costs **~261× the planner estimate and ~13× the execution time** of the join shape (332,820 / 61.5 ms vs 1,274 / 4.8 ms at 20k reviews), because the LATERAL forfeits the hash semi/anti-join. That flipped it decisively, and it also exposed the flaw in my objection: the main row source 160 lines above **already** depends on that exact index with that exact join, and would render duplicate rows if it broke. I was declining to add a second dependency on a guarantee the file already treats as load-bearing — in exchange for a 13× slowdown on a page load.

Shipped shape is the spec axis's variant (`FILTER (WHERE p.review_id IS NULL / IS NOT NULL)`) rather than the subtraction, keeping the symmetric pair you noted is more legible. Your appendix item 3 is thereby resolved: the subtraction is not needed, because the LEFT join makes the identity structural on its own.

**F3 (low — two stale comments naming the deleted `NOT EXISTS` denominator): ACCEPTED, FIXED.** `replies-view.ts:~368` and `load-replies.ts:~164` updated; `load-replies.ts:~195` left alone as you correctly identified it as a different, still-valid reference.

**F4 (low — hand-rolled duplicate of `seedPostedResponse`): ACCEPTED, FIXED.** `seedPostedResponse` gained the trailing `bizId: string = businessId` parameter, matching the precedent already set twice in that file by `seedReview` and `seedReplacementDraft`; the inline INSERT is gone.

## Appendix disposition

| Item | Verdict |
|---|---|
| 1 | See the on-disk item; noted. |
| 2 — dangling referents in the `ReplyFacts` JSDoc ("**this mapper's** `return {`" on a *type* declaration) | **FIXED.** My wording, introduced by commit `8cd0a58a`. The doc block explains the single mechanism the whole re-split rests on, so a sentence that misdescribes where the experiment was run is worth a fix, editorial or not. |
| 3 — only one `FILTER` is strictly needed | **RESOLVED by F2's fix**, and the symmetric pair is retained for the legibility reason you gave. |
| 4 — `emptyBusinessId` is caller-discipline-by-comment | **NOTED, accepted as-is.** The tension with `load-replies.ts:192` ("orphan-ness is DATA, not caller discipline") is real and well spotted, but that principle governs *production* invariants; for a test fixture there is no cheap structural alternative and the payoff (live-Postgres coverage of the zero-row aggregate path) is real. |
| 5 — `RegenBudgetStatus.remaining` redundant | **NOTED, out of scope.** Pre-existing and untouched. |
| 6 — window functions, considered and rejected | **AGREED**; it matches the intake's own stated non-goal. Now recorded in two reports so it is not re-litigated. |
