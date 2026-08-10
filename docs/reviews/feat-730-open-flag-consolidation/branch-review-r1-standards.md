# Branch review round 1 — STANDARDS & MAINTAINABILITY

**Branch:** `feat-730-open-flag-consolidation` · **Range:** `76b40b7b..HEAD` (aa01232b)
**Method:** `thermo-nuclear-code-quality-review` skill, applied to the branch diff.
**Reviewer stance:** fresh eyes; settled deviations (triaged ACCEPT, owner-ratified) honored and not re-litigated.
**Verification run:** `pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts src/lib/dashboard/__tests__/ src/app/api/dashboard` — 45 files passed, 2 skipped (DB-gated), 436 tests passed.

## Verdict

**APPROVE.** This branch is what a consolidation refactor should look like: eight inline
spellings of the open-flag predicate collapse onto one genuinely deep fragment
(`openFlagExistsSql`), the production diff is surgical in-place block swaps that each got
*shorter*, no shallow wrappers appeared at any migration site, and the semantic-owner
module gained a divergence contract that actively defends against future
boolean-parameter rot. All findings below are minor test-maintainability items; none is a
structural regression and none blocks merge.

## Findings table (≥80% confidence only)

| Severity | Location | Finding |
|---|---|---|
| Minor | `src/app/api/dashboard/__tests__/route.test.ts:37` (997 → 1012 lines) | The branch pushes this file across the 1000-line threshold (skill rule #1 presumptive blocker). **Waived**: the +15 lines are the mechanical fragment-aware repair of feature-caused breakage inside the `vi.mock` DB factory (owner-ratified surface amendment #2); splitting a route suite already at 997 lines is far outside this branch's ratified surface. The threshold crossing should be recorded as a decomposition fast-follow — the file was one mock repair away from the line before this branch touched it. |
| Minor | 7 files — `src/app/api/dashboard/__tests__/route.test.ts:37`, `src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:39`, `.../draft-status.test.ts:36`, `.../draft.test.ts:26`, `.../publish.test.ts:23`, `src/app/api/dashboard/reviews/__tests__/actions.test.ts:59`, `src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts:49` | `isExecutedStatement` is duplicated verbatim seven times (Fowler: Duplicated Code, on changed code). The executed-vs-fragment classification is now a load-bearing test contract — if the regex ever needs a fix (e.g. a comment-prefixed or `VALUES`-headed executed statement misclassified as a fragment silently skips the result queue), it needs seven synchronized edits. Mitigating: `vi.hoisted`/`vi.mock` factory hoisting makes in-factory copies the pragmatic choice today, and the regex is byte-identical everywhere. Recommend a follow-up promotion to one shared helper (dynamic `await import` inside the factories, or a documented house helper under `src/__tests__/helpers/`) — rule of three is exceeded ×2. |
| Low | `src/lib/moderation/__tests__/held-draft.test.ts:95` | Comment/code mismatch: "Scans the **four suites** that carried stubs" — `SUITES` enumerates **three** files. (Four *stubs* landed across three suites; titles #1 and #11 shared `held-draft.test.ts`.) Concrete failure: the next contributor hunts for a missing fourth entry, or "fixes" the array by adding one. One-word reword ("the suites that carried the four stubs"). |
| Low | `src/lib/dashboard/__tests__/aggregate-service.test.ts:109` (copied from `service.feed-projection.test.ts:41`) | Second verbatim copy of the `lateralBody` slicer, including its thrown error message. Two copies is at (not past) the rule of three and the comment cross-references the source, so acceptable — but if a third dashboard suite ever needs it, it must move to a shared helper rather than gain a third copy. |

## Axis-by-axis assessment

### 1. Repo standards (project CLAUDE.md working rules)

**PASS.**
- **No `any`:** zero `as any` / `: any` in the diff (grepped). Test doubles use
  `unknown` + narrowing casts (`as { fragmentText?: string }`) — the sanctioned idiom.
  `mkTx`'s cast improved from `as never` to `as unknown as postgres.TransactionSql`,
  which lets call sites type-check.
- **No silent catches:** none added; the property test's `finally` cleanup blocks are
  cleanup, not swallowed errors.
- **Status literals:** the fragment's `'open'` is the documented deliberate exception,
  and the in-function comment (`held-draft.ts:58-61`) is exemplary — it states *why*
  (byte-for-byte partial-index inference, migration 051, no fallback index on
  `response_id`), which is exactly the ON-CONFLICT/partial-index gotcha class the
  project CLAUDE.md warns about. The integration fixtures spell the migration-051
  vocabulary as *write* fixtures with a comment distinguishing them from the read-side
  owner — correct division.
- **Comment density/idiom:** the migrated sites each kept their explanatory comment and
  rewrote only the now-false clause ("hasOpenFlag … cannot be composed" → "composes its
  openFlagExistsSql fragment (#730)"). Stale-comment hygiene is complete: no surviving
  "spelled inline (D6)" claims (verified by grep); the stale `#680` pointer in
  `load-replies.ts` was rewritten as the plan required.
- **Allowlist:** 6 `sqlSnippet` strings regenerated in place in
  `scripts/ci/tenant-scope-allowlist.ts` (~327/~1285/~1509/~1516/~1530/~1537); entry
  count unchanged, no new entry for pending-count — matches the plan's locked facts.

### 2. Deep-module discipline (`codebase-design` vocabulary)

**PASS — `openFlagExistsSql` is a genuinely deep interface.** One two-parameter function
hides: the table name, the `fr` alias, the `status = 'open'` literal and its
index-inference constraint, and the EXISTS shape. The `ref`-as-fragment design covers
all three composition contexts (projected, filtered, bound-parameter) without a mode
flag — the interface is smaller than any of its eight former spellings while carrying
more guarantees. The docblock documents the one real leak (the reserved `fr` alias and
its silent self-correlation hazard) instead of pretending it away.

- **No shallow wrappers acquired:** every migration site embeds the fragment directly in
  its query; no site grew a pass-through helper.
- **`hasOpenFlag` re-expression** (`SELECT 1 AS one WHERE ${fragment}`) is slightly
  exotic SQL, but it is the price of single-spelling and was live-verified by design
  (title #6 runs it against real Postgres inside a transaction). Settled by plan; no
  objection.
- **The divergence comment block** on the owner module is the strongest deep-module move
  on the branch: it pre-empts the "shared helper acquires a boolean meaning 'actually a
  different query'" failure mode by naming the four consumer categories that must NOT
  consolidate. Verified against reality: the only remaining non-test
  `FROM flagged_responses` spellings are exactly the deliberately-distinct set
  (admin flagged-service/route, nav-counts, purge-verification, plus the owner module
  itself) — the consolidation is complete within its declared scope.
- **Code-judo check:** the deeper restructuring (migrating the seven bespoke route-suite
  doubles onto the already-fragment-aware shared flattening harness,
  `worker/__tests__/helpers/mock-sql.ts`) was considered and is the honest answer to
  finding #2 long-term, but it would touch dozens of positional assertions across suites
  this branch otherwise has no business editing. Not a missed move at this scope.

### 3. Fowler smell baseline (changed code only)

Two real smells, both in test code, both tabled above (Duplicated Code ×2:
`isExecutedStatement` ×7, `lateralBody` ×2). No Shotgun Surgery in production code —
the eight edits are the *removal* of a shotgun-surgery surface, not an instance of it.
No Feature Envy, no Speculative Generality (the fragment has eight concrete callers on
day one), no Divergent Change introduced. The production diff *reduces* net conditional
text at every site (the `agents/read.ts` anti-join → `NOT EXISTS` swap also removes a
join from the query plan surface).

### 4. Glossary (CONTEXT.md concept fidelity)

**PASS — no renames, no drift.** Checked against the CONTEXT.md "Reviews list" entry:
- "Reviews list" is used correctly (integration suite describe block; no "Past Replies"/
  "archive" resurrections in new text).
- `row_action` vocabulary is exact: held ⇒ `'none'` asserted as
  "affordance withdrawn (invariant #4 as structure)" (`load-replies.integration.test.ts:453`),
  and the property test's `draft_ready`-unless-held ⇒ `none` matches the #727 axes model
  verbatim.
- D9 SELECTed-not-filtered survives in both routes' comments and in the rewritten
  `load-replies.ts` comment ("Projected, not filtered (D9): a held draft must stay
  distinguishable from 'no draft'"). The removal of "(D6)" from the inline-spelling
  sentences is correct — that decision label attached to the now-deleted inline
  spelling, and its removal does not touch the *other* D6 (Unanswered/Answered grouping),
  which is untouched.

### 5. Test maintainability — five upgraded doubles + two source-scan tests

**Acceptable, with the duplication caveat (finding #2).** The `isExecutedStatement`
regex is byte-identical across all seven suites, and each copy carries a
site-specific comment explaining what must not consume what. Three capture conventions
now coexist, and each is *locally justified*:

1. **Capture-all + executed-queue** (`[reviewId]` route.test.ts `readCalls`,
   past-replies draft-status via `mock.calls`, actions.test.ts `sqlQueryTexts`) — where
   the capture array is searched with `.find`/`.some`, so fragment entries are harmless
   and useful for assertions.
2. **Dual ledger** (draft.test.ts, draft-id.test.ts, publish.test.ts:
   `mock.calls` = everything, `txExecutedCalls` = executed only) — where positional
   assertions exist; the new `txExecutedCalls` array is the right fix, and rewriting the
   positional assertions onto it ("4th executed statement", "fragment builds not
   counted") makes them *more* robust to future fragment compositions, not less.
3. **Executed-only capture** (dashboard route.test.ts `capturedSqlTexts`) — required
   because that array is consumed positionally (`capturedSqlTexts[1]` at line 717);
   capturing fragments would shift indices. The comment says so. Cost: fragment content
   is unobservable in that suite; a future test needing it must re-derive the pattern.

The dashboard-lib suites correctly did NOT get the route pattern — the shared
`mock-sql.ts` harness flattens fragment text (pre-existing #598 lineage), and the T5
pins assert the flattened form with comments explaining *why* the form differs from the
route suites'. A next contributor reading any one suite will understand that suite; one
reading two suites side-by-side must read the comments to see why the forms differ —
which the comments do carry. The shared-helper follow-up (finding #2) is what would
collapse the three conventions into one.

**Source-scan tests:** both are faithful to house precedent
(`eslint-boundaries.test.ts` style). The invocation-count design (`openFlagExistsSql(`
never matches an import specifier; pending-count requires 2) and the line-comment
stripping are sound. Two accepted limitations are already on the record in the
deviations log as owner fast-follow items and are NOT re-raised here: the enumerative
OWNER_FACING list (an 8th owner-facing file could inline the predicate and pass), and
the stripping being line-comment-only. The `.todo`-scan's self-scan hazard was handled
correctly (regex kept byte-identical; comments spelled indirectly) — verified the regex
literal cannot match its own source text.

### Settled items honored (not re-litigated)

- Surface amendments #1 (`*` respelling) and #2 (two blast-radius test files) — owner-ratified.
- T5 flattened-form pins + in-place strengthening of the ~261 aggregate pin.
- The enumerative source-scan ratchet recommendation and the `statusArraySql(sql, …)`
  write-client observation in the `[reviewId]` route — both recorded in deviations as
  owner hygiene items; this review concurs with both recommendations and adds nothing.

## Low-confidence appendix (speculation — below the 80% bar, no action required)

- **`isExecutedStatement` future misclassification:** an executed statement beginning
  with a SQL comment (`/* hint */ SELECT …`) or `VALUES` would be classified as a
  fragment and silently skip the result queue, presenting as a confusing
  empty-result/409 failure two assertions downstream. No such statement exists in these
  routes today; worth one line in the shared helper's docblock if finding #2's
  promotion happens.
- **Ref parameter type:** `postgres.PendingQuery<postgres.Row[]>` is broader than the
  concept ("a fragment"); exporting a named alias next to `openFlagExistsSql` would
  self-document call sites. Cosmetic.
- **Two template-joiners in one suite:** past-replies draft-status.test.ts's mock joins
  with `'?'` while its `joinTemplate` assertion helper joins with `'|'` — pre-existing
  idiom, but a contributor grepping for mock text output may be briefly misled.
- **Mirror title drift:** the aggregate mirror test's title ("keeps held-filtering
  inside the response LATERAL…") differs from locked title #10's wording. Deliberate
  (it is the mirror, not the promised title) but a title-based grep for #10 finds only
  one of the two pins.
- **`expect(exists.values).toContain(ref)`** in title #1 relies on object identity of
  the mkTx return value; fine today, would silently weaken if mkTx ever returned fresh
  objects per call.

## Approval-bar checklist (skill)

- No structural regression: **met** (production diff deletes complexity: −8 spellings, −1 join).
- No missed dramatic-simplification path at this scope: **met** (the harness-unification judo move is real but belongs to a test-infra branch).
- File-size explosion: **one waived crossing** (997 → 1012, mechanical repair — tabled).
- Spaghetti growth from special-case branching: **none** (the doubles' fragment branch is the same two-line guard everywhere, not ad-hoc divergence).
- Hacky/magical abstraction: **none** (fragment splicing is the platform's own mechanism, live-verified).
- Wrapper/cast/optionality churn: **none in production code**; test casts are narrow and idiomatic.
- Canonical-helper duplication: **two test-only instances, tabled** (Minor/Low).

**VERDICT: APPROVE** — findings are fast-follow hygiene, not merge blockers.

## Triage verdicts (orchestrator, round 1)

- Minor 1k-line threshold on dashboard route.test.ts — **ACCEPT as recorded**
  (waived by the review itself; decomposition logged as fast-follow).
- Minor `isExecutedStatement` ×7 duplication — **REJECT for this branch,
  ACCEPT as fast-follow** (extraction at the next consumer; re-touching 7
  green suites during review close is worse than the duplication; codex made
  the same recommendation — both positions recorded per protocol).
- Low "four suites" comment — **ACCEPT, fixed** in commit 203a3b9d.
- Low `lateralBody` second copy — **ACCEPT as recorded** (rule-of-three
  boundary; third consumer must extract — already noted in the T5 review).
