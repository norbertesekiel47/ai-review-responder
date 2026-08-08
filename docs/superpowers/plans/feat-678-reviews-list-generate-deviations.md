# Deviations — feat-678-reviews-list-generate

Every entry is something the plan or intake did not anticipate. Step 6 requires an
ACCEPT / RE-PLAN verdict on each before review agents see this file.

---

## D1 — Surface amendment #1 of 2 (owner-approved, 2026-08-08)

**Trigger:** plan review round 1, finding F8. Collapsing `flags.ts` to a single
function — the owner's grilling decision — requires editing six files outside the
originally locked `allowed_edit_surface`, whichever of the two names survives.

**Added to `allowed_edit_surface`:**

| Path | Why |
|---|---|
| `src/lib/reviews/process-review.ts` | calls `replyEditingFlagEnabled()` |
| `worker/jobs/publisher/ResponsePublisherWorker.ts` | calls `replyEditingFlagEnabled()` |
| `worker/jobs/publisher/failed-hook.ts` | calls `replyEditingFlagEnabled()` |
| `src/app/api/dashboard/past-replies/**` | 3 routes call `editRepliesEnabled()` |
| `scripts/ci/process-env-baseline.ts` | env-baseline audit references the retired flag |
| `src/components/dashboard/__tests__/**` | the existing `PastReplyCard.test.tsx` lives here, **not** under `components/dashboard/reviews/` — the original surface missed it |
| `.claude/reference/review-ingestion.md`, `.claude/reference/lab-notes.md` | live (non-`docs/`) references to the retired flag |

**Amendment budget: 1 of 2 used.** A second amendment trips the abort criteria.

**SCOPE FENCE — read before editing `process-review.ts`:** `src/lib/reviews/process-review.ts`
is in-surface **for the flag rename ONLY**. The owner explicitly deferred F2's
in-flight `job_outbox` guard to #680 (see D2). Adding that guard here is out of
scope even though the file is now editable — do not let proximity turn a deferred
fix into a silent one.

**Verdict:** ACCEPT.

---

## D2 — F2 race deferred to #680 (owner decision, 2026-08-08)

**Finding:** a `Generate` racing the live-ingest content-change path in
`process-review.ts:325` enqueues a **second** `generate_response` job — that path
re-derives the version and never checks `job_outbox` for in-flight work, and
`enqueueGenerateResponse` has no in-flight dedup.

**Blast radius is smaller than the reviewer credited:** the partial unique index
(migrations 023+026+029) permits at most one non-terminal response per review, so
the losing job **fails to persist** rather than producing two drafts. The cost is
a wasted LLM call, not corruption.

**Decision:** test it here, fix it in #680. This branch adds
`Generate racing live-ingest regeneration for the same unanswered review leaves
exactly one in-flight generate_response version` so the behaviour is pinned and
measured; if it confirms wasted spend, that becomes a #680 item rather than
widening this branch into worker ingest.

**Verdict:** ACCEPT.

---

## D3 — 13 test titles added to `tests_to_add` (not an amendment)

Per the workflow, a `tests_to_add` change is an owner-approved deviations-file
entry, not a surface amendment — no budget burned. 37 → **50** titles, from plan
review findings F1–F9. Both intake copies updated and verified byte-identical.

The largest single gap: **zero** of the original 37 titles tested
`GET draft-status`, while Task 3 referred to "the poller titles" as if they
existed. That is the #643 fabricated-citation class, caught by the mandatory
cited-artifact check.

**Verdict:** ACCEPT.

---

## D4 — Estimates deliberately NOT re-padded

Scope grew (13 tests, 6 files) but `estimated_prod_lines` / `estimated_test_lines`
stay at the owner-ruled **900 / 1100**. The owner explicitly rejected padding on
the grounds that a loose estimate makes the re-classification trigger useless.
If the actual diff exceeds 2× either bucket, the trigger firing is the control
working as designed, not a surprise — re-run step 0 at that point.

(The orchestrator raised these to 1000/1500 mid-session and reverted it; recorded
here because a silent estimate change would have quietly disarmed the trigger.)

**Verdict:** ACCEPT.

---

## D6 — F5's prescribed `hasOpenFlag` is not usable on the read paths (round 2)

**Trigger:** applying round-2 findings. Round 1's F5 fix said "use `hasOpenFlag`
(`src/lib/moderation/held-draft.ts`) — already the owner of this fact". Its actual
signature is `hasOpenFlag(tx: postgres.TransactionSql, responseId)` — an in-tx,
post-`FOR UPDATE` **release gate**, documented as such in the module header.

Neither new site is a transaction: the `draft-status` poller is a `sqlRead`, and
the list check must live inside a single SQL statement (a LATERAL). Wrapping
either in `sql.begin` purely to read a boolean would add a transaction round trip
to a poll endpoint hit every few seconds.

The clean fix — export a composable predicate fragment from `held-draft.ts` —
is **blocked**: that file is outside `allowed_edit_surface`, and it is the LAST
amendment (1 of 2 already used by D1), which per the abort criteria means
post-mortem + teardown. Not worth spending on a refactor.

**Decision:** both new sites spell `EXISTS (SELECT 1 FROM flagged_responses f
WHERE f.response_id = … AND f.status = 'open')` inline, each carrying a comment
naming `held-draft.ts` as the semantic owner. Three spellings of the predicate
exist after this branch (`hasOpenFlag` + 2). Consolidating them into one exported
fragment is a **#680 item**, where `held-draft.ts` can be in surface.

**Verdict:** ACCEPT.

---

## D7 — Two-round pattern: review fixes landed as prose, not as steps

**Not a scope change — a process finding, recorded so it is not rediscovered.**

Round 1 accepted 9 findings and wrote them into a `# Round-1 revisions` appendix,
but patched only F3 and F7 into the task steps — and F3 only partially (caught
pre-round-2 by the orchestrator; see `plan-round1.md`). Round 2 then found F5, F8,
and F9 in the same state: described in the appendix, absent from every checkbox a
subagent executes.

**Root cause:** an appendix entry reads as "addressed" at every subsequent
checkpoint — including to the reviewer who wrote the finding — because the plan
demonstrably *discusses* the fix. Nothing distinguishes "described" from "applied"
without opening the task the fix belongs to.

**Correct approach:** a review fix is applied when the **checkboxed step** changes.
The appendix is a changelog, never the carrier. Round-3's brief (and every future
`/feature` review brief) asks: *if a subagent executes only the checkboxes of the
owning task, does the fixed behaviour result?*

**Promote to lab-notes at step 8** — this is not #678-specific.

**Verdict:** ACCEPT.

---

## D8 — 2 test titles added (50 → 52; not an amendment)

Per the workflow a `tests_to_add` change is an owner-approved deviations-file
entry, not a surface amendment — no budget burned (D3 precedent).

- `an orphan row keeps its failed_response_id and superseded text after the single-query merge`
  — pins round-2 Defect A. Without it, F3's single-query merge silently drops the
  field `PastReplyCard:157,201` needs to offer recovery at all, and every existing
  orphan title still passes (they assert grouping and non-duplication, not fields).
- `the Reviews list renders a moderation-held draft as held with no Generate, no draft text, and no cross-link`
  — pins round-2 Defect B at the surface. The locked F5 title covers only the
  poller; nothing covered the list row.

Both intake copies updated and verified byte-identical.

**Verdict:** ACCEPT.

---

## D9 — `held` is a sixth row state, and a new user-visible behavior (OWNER: ratify)

**Trigger:** round-2 Defect B. Round 1's accepted F5 fix requires a held review to
sit in `Unanswered` "with no affordance", but the locked five-state union cannot
express that. With the draft filtered out, `deriveRowState` falls through to
`generate` — offering an LLM spend the partial unique index (023+026+029) would
then reject, since a held draft is itself a live non-terminal response. With the
draft kept, the row reads `draft_ready` and surfaces held text plus
`Approve & post`. **Both violate invariant #4**, so the five-state model had no
correct configuration.

**Decision:** add `held` to `ReviewRowState`, carry `draft_held` from the query,
and branch it on the same test as `draft_ready` so no held draft can reach
`generate`. The row renders the review text and a muted `Under review` marker —
no button, no draft text, no cross-link (Needs Action does not surface held drafts
either, so the `draft_ready` cross-link would lead nowhere).

**Why this needs owner ratification:** it adds a user-visible state that the
owner-signed intake does not name. The intake's declared behavior — *"A review
with a pending draft shows a `Draft ready` cross-link"* — is unconditional, and a
held draft **is** a pending draft, so the signed contract as written mandates an
invariant #4 violation. That is a contract defect F5 exposed, not an
implementation choice, and the surviving question is only how the state presents.

`user_visible_behavior` updated in both intake copies (an intake-field correction,
not a surface amendment). **Flagged to the owner in the round-2 summary; veto or
relabel at any point before step 8.** The label `Under review` is the one piece
genuinely open to preference.

**Verdict:** ACCEPT (owner ratification pending — no work blocks on it).

---

## D5 — Plan cited two stale line numbers inherited from the spec

- The `version > 1` regen-budget guard is `generate-draft.ts:**107**`, not `:106`.
  Ticket #678's unblocking comment and spec §6.3b both say 106 — the spec is one
  line stale. Cite 107; do not "correct" the code to match the doc.
- `past-replies/draft/route.ts` is 253 lines, not 254 (cosmetic; plan prose only).

**Verdict:** ACCEPT.

---

## D10 — `peekRegenBudgetBatch` must catch its own Redis failure (T1)

**Trigger:** authoring the eval. The locked title reads
`peekRegenBudgetBatch fails open to an empty map when Redis is unavailable` —
it names the FUNCTION as the thing that fails open. Task 6 Step 1's code block
has no `try/catch`; it lets an `mget` rejection propagate and relies on Task 6
Step 2's caller-side catch in `load-replies.ts` to produce the empty map.

Both spellings deliver D-F's behaviour (no counters, every Regenerate enabled),
but only one satisfies the title, and a title is contract while a plan code
block is guidance.

**Decision:** the eval asserts the FUNCTION resolves to an empty `Map` and does
not throw. Task 6 must wrap the `mget` in a `try/catch` returning the empty map.
Step 2's caller-side catch stays as defence in depth — it is what covers a
synchronous `getCacheRedis()` throw before the `mget` is even issued — so this is
an addition to Step 1, not a replacement of Step 2.

**Verdict:** ACCEPT.

---

## D11 — F8's `scripts/ci/process-env-baseline.ts` entry does not exist (T1 observation)

**Trigger:** T1 checked every cited artifact before writing tests that set the
retired flag. Task 8 Step 4 lists a checkbox to "drop the
`PAST_REPLIES_VIEW_ENABLED` entry" from `scripts/ci/process-env-baseline.ts` and
to run `pnpm ci:process-env` after, on the grounds that a stale entry fails the
gate. `grep -rn 'PAST_REPLIES_VIEW_ENABLED' scripts/` returns **zero** hits: the
baseline is a set of FILE PATHS that read `process.env`, not a set of variable
names, and it excludes test files entirely (0 `__tests__` entries).

No work is lost — `src/lib/past-replies/flags.ts` reads the flag through
`readFlag`, so the file-path baseline is unaffected by the retirement either way.

**Decision:** Task 8 should treat that checkbox as a no-op verification (run
`pnpm ci:process-env`, expect green, tick it) rather than hunting for an entry to
delete. `scripts/ci/process-env-baseline.ts` stays in `allowed_edit_surface`; it
simply needs no edit. The three genuinely live references F8 names —
`.claude/reference/env-vars.md`, `.claude/reference/review-ingestion.md`,
`.claude/reference/lab-notes.md` — are real and still require the rewrite.

**Verdict:** ACCEPT.

---

## D12 — the task graph's T2/T4/T6 parallel claim is wrong: T6 edits T4's file

**Trigger:** step 4 dispatch. The plan's task graph marks `T2`, `T4`, `T6`
"mutually independent → parallel dispatch" and justifies it with disjoint file
sets: `worker-types.ts` · `load-replies.ts` · `tracker.ts`. But **Task 6 Step 2
edits `src/lib/past-replies/load-replies.ts`** (the batched peek call site) and
its Step 3 `git add` names that file explicitly. T4 owns that same file for its
whole rewrite. Dispatching them concurrently races two agents on one file —
and, in a shared worktree, on one git index.

**Decision:** re-sequence, do not re-plan. The corrected graph is

```
T1  ──> T2 ∥ T4          (genuinely disjoint)
    ──> T3 ∥ T5 ∥ T6      (T3 needs T2; T5 and T6 need T4)
    ──> T7 ──> T8
```

T6 moves from "parallel with T4" to "after T4". Every task's *content* is
unchanged; only the dispatch order moves. Parallelism is preserved (2-way then
3-way), and no two concurrent agents share a file.

**Also folded into T6:** `PastRepliesPageView` must expose `regenBudgets` as a
plain `Record<string, RegenBudgetStatus>`, not the `Map` that
`peekRegenBudgetBatch` returns. Task 4 Step 3's renamed-field list omits the
field entirely, and Task 6 Step 2's snippet stops at the `Map`. T1's eval pins
both ends: `regen-budget-batch.test.ts:74,95` requires the FUNCTION to return a
`Map`, while `past-reply-card-states.test.tsx:19,170` requires the client prop to
be a record — a `Map` does not survive the server→client boundary. The
conversion therefore belongs at the `load-replies.ts` seam, which T6 Step 2
already owns.

**Verdict:** ACCEPT.

---

## D13 — Task 4 cannot land green: `ci:tenant-scope` needs an allowlist edit outside the surface

**Trigger:** T4 execution. Rewriting the four `load-replies.ts` queries makes
`pnpm ci:tenant-scope` fail with **11 findings**, and every one of them can only
be cleared by editing `scripts/ci/tenant-scope-allowlist.ts` — a file that is
**not** in `allowed_edit_surface` and that neither the plan nor the intake
mentions. `scripts/verify-gate.sh` runs every `ci:*` script, so this blocks the
verify gate for the whole branch, not just T4.

**Why it is not avoidable by writing better SQL.** The allowlist is keyed on the
**exact normalized SQL text**, so changing a query orphans its entry and
`findUnusedAllowlistEntries` fires — 8 of the 11 findings are *unused* entries for
SQL that no longer exists. Even a hypothetically perfectly-scoped rewrite would
still leave those 8 red. The remaining 3 are new `responses` findings the audit
cannot resolve on its own: `responses` is reached through a `LEFT JOIN` and
through `NOT EXISTS` / `EXISTS` subqueries that `stripSelectSubqueries` removes
before predicate analysis, so no bound `business_id` predicate is visible to it.
Restructuring the counts as a `LEFT JOIN … IS NULL` anti-join would satisfy the
audit but is forbidden: the locked eval discriminates the two counts on
`/NOT\s+EXISTS/` (`reviews-list.test.ts:104`).

**The exact required patch** (deterministic; verified against the audit output):

- **Delete the 8 stale entries** for `src/lib/past-replies/load-replies.ts` —
  the two activation-split COUNTs (`responses` + `reviews`), the posted-only
  `AVG`, the old posted-JOIN main query, and the two for the now-deleted orphan
  query.
- **Add 3 entries**, all `file: "src/lib/past-replies/load-replies.ts"`,
  `table: "responses"`, `category: 'tenant-root-lookup'`, reusing the existing
  reason string: one for the new LEFT-JOIN + four-LATERAL main query, one for the
  `NOT EXISTS` unanswered count, one for the `EXISTS` answered count. The new
  `AVG` query needs **no** entry — it no longer joins `responses`, so
  `r.business_id = ${locationId}` scopes it outright, which is a small net
  reduction in exempted surface.
- **`ALLOWLIST_BASELINE` 414 → 409.**

**Not done here.** T4 left the file untouched: `scripts/ci/tenant-scope-allowlist.ts`
is outside the fence, and D1 already spent amendment 1 of 2 — spending the last
one is an owner-level call, not a subagent's. Deciding whether this counts as a
*surface amendment* at all is the open question: it is CI bookkeeping the audit
itself demands whenever a scoped query changes, not production code or docs, and
the same edit will be required again by any future task that touches these
queries (T6 does not — it appends a field, not a query).

**OWNER RULING (2026-08-08): CI bookkeeping, NOT a surface amendment.**
`scripts/ci/tenant-scope-allowlist.ts` is added to `allowed_edit_surface` in both
intake copies (verified byte-identical at `78a883ec…`), and the amendment budget
stays at **1 of 2 used**.

The reasoning that decided it — worth keeping, because the same question will
recur on every branch that touches a tenant-scoped query:

1. **A restart cannot avoid the edit.** The abort criteria exist to catch a
   mis-chosen lane, on the theory that restarting at step 1 produces a better
   branch. Here the allowlist edit is a precondition for *any* implementation of
   #678 to pass CI — `scripts/verify-gate.sh` runs every `ci:*`, and so does CI's
   `lint` job. A torn-down-and-restarted branch hits the identical wall at the
   identical step. Treating it as an abort trigger is a pure loss with no
   corrective value.
2. **It is the audit asking, not the implementation creeping.** The allowlist is
   an exact-SQL-text index with an exact-match count gate; its own header demands
   "an explicit, reviewable baseline bump in the same PR". Changing a scoped query
   without touching it is not an option the tool offers. The amendment budget
   exists to stop scope creep — implementation quietly outgrowing the reviewed
   contract — and this is the opposite: a mechanical consequence the contract
   failed to anticipate.
3. **The change is a net shrink of exempted surface** (414 → 409). The new `AVG`
   query no longer joins `responses`, so `r.business_id = ${locationId}` scopes it
   outright and it needs no entry at all. Fewer tenant-scope suppressions in the
   tree after this branch than before it.

**Precedent for future runs:** an out-of-surface edit that a CI audit
*mechanically requires* as the direct consequence of an in-surface change is
bookkeeping, not an amendment. It still gets a deviations entry and still needs
the owner's sign-off — it just does not burn amendment budget.

**Verdict:** ACCEPT.

---

## D14 — Task 3's Generate door adds 3 `ci:tenant-scope` findings the plan's SQL cannot clear

**Trigger:** T3 execution. The Generate door written exactly as Task 3 specifies
adds **3** findings on top of D13's 11:

```
src/app/api/dashboard/reviews/[reviewId]/generate/route.ts: responses: missing account_id or business_id scope   (x3)
```

They are the three in-transaction `responses` reads — the `status = 'posted'`
sibling check, the `NON_TERMINAL_STATUSES` existing-draft check, and
`COALESCE(MAX(version), 0) + 1`. All three key on `review_id` alone, exactly
mirroring the named precedent `src/app/api/dashboard/past-replies/draft/route.ts`,
which carries **three** `tenant-root-lookup` allowlist entries for the identical
shape (`tenant-scope-allowlist.ts:1667`, `:1674`, `:1681`, reason: "Owner
past-replies transaction has already resolved request account/location scope
before this row-level lock or mutation."). The scope proof is real and runs
first: the account-scoped `reviews ⋈ businesses` lookup, then `SELECT … FROM
reviews WHERE id = … AND business_id = … FOR UPDATE`. The audit strips
subqueries before predicate analysis and cannot see it.

The sibling `draft-status/route.ts` produces **no** finding — its draft read
already binds `resp.business_id = ${businessId}`.

**Decision:** left as the plan writes it. T3's fence forbids editing
`scripts/ci/tenant-scope-allowlist.ts`, and adding `AND business_id = …` to the
three tx reads would be a silent rewrite of contract SQL that two review rounds
blessed. The remedy is 3 more allowlist entries folded into D13's patch, all
`file: "src/app/api/dashboard/reviews/[reviewId]/generate/route.ts"`,
`table: "responses"`, `category: 'tenant-root-lookup'`, reusing the
`past-replies/draft` reason string — making D13's `ALLOWLIST_BASELINE` land at
**412**, not 409.

**ORCHESTRATOR (2026-08-08): APPLIED, folded into the D13 patch.** Refusing to
rewrite blessed contract SQL to satisfy a static audit was the right call — the
scope proof genuinely runs first, and the audit genuinely cannot see it. Holding
the patch until T3 reported is what kept these 3 entries out of a second pass,
where they would have been stranded exactly the way the original 8 were.

Final state: `tenant-scope-audit: passed — entries: 412 (baseline: 412)`.
Snippets were generated from the audit's OWN `extractSqlTemplates` +
`normalizeSql` rather than hand-transcribed: a one-space transcription
difference yields an entry that silently never matches, which is
indistinguishable from the stale-entry failure this deviation is about.

**Verdict:** ACCEPT.

---

## D15 — Task 5 must emit `row_state` on the card row, which forces a 3-token type widening in `load-replies.ts` (T6's file)

**Trigger:** T5 execution. Task 5 Step 2b describes `groupReplies` only as a
re-predicated merge-and-sort and never says what the emitted row carries. The
locked evals say it for it: `reviews-list.test.ts:192,258,269,292,357` reads
`view.unansweredRows[n].row_state`, and `past-reply-card-states.test.tsx:30-33`
pins the surface prop shape as `interface ListRow extends PastReplyRow {
row_state: string; provenance_badge?: string | null }`. So the derivation is
emitted ON the row, not recomputed by the card (D-D), and the badge field is
named `provenance_badge` — not `provenance`.

**The type consequence the plan does not mention.** `PastReplyRow.response_id`
is `string` (`PastReplyCard.tsx:17`) because pre-#678 every listed row had a
posted reply. Post-Task-4 the row source LEFT JOINs `responses`, so
`response_id` IS NULL is the unanswered predicate and is exactly what
`deriveRowState` branches on. Typing it `string` would be a lie a future
"simplify the always-true comparison" pass could act on, silently making every
review read Answered. T5 therefore exports

```ts
export interface ReviewsListRow extends Omit<PastReplyRow, 'response_id'> {
  response_id: string | null;
  row_state: ReviewRowState;
  provenance_badge: ProvenanceBadge | null;
}
```

and `groupReplies` returns it. `PastRepliesPageView` still declares
`PastReplyRow[]`, so `load-replies.ts` now has **3 typecheck errors** (`:356`,
`:370`, `:371`).

**Decision:** T5 does not fix them — `load-replies.ts` is T6's file for the
duration. The fix is mechanical and belongs to whoever holds the file next
(T6 or T7): import `type ReviewsListRow` from `replies-view` and use it in place
of `PastReplyRow` at those three sites. T7 additionally owns the matching
`PastReplyRow` change in `PastReplyCard.tsx` (add `row_state`, widen
`response_id`), which is already in its Step 3.

**ORCHESTRATOR (2026-08-08): the 3-site fix is APPLIED** (`PastRepliesPageView`
now declares `ReviewsListRow[]`), so T7 starts from a `load-replies.ts` that
typechecks.

The type-honesty argument is the load-bearing part and should survive into
review: `response_id: string` would have been a **false** type once Task 4's
LEFT JOIN made NULL the unanswered predicate. `deriveRowState` branches on
exactly that NULL, so the lie is one "simplify the always-truthy comparison"
pass away from making every review render as Answered. Widening the type is not
defensive noise — it is the type telling the truth about the query.

**Verdict:** ACCEPT.

---

## D16 — T7: three eval assertions were unsatisfiable, and the tab rename had to move from T8 into T7

**Trigger:** T7 execution. Three separate things in the locked material could not
all be true at once. None changes behaviour; all three are recorded because a
reviewer diffing T7 will see test edits outside the "write the surface" brief.

**(a) `past-reply-card-states.test.tsx` — the list smoke test could never pass.**
The title `the Reviews list renders without PAST_REPLIES_VIEW_ENABLED set` used
`getByText` three times against a render that necessarily contains **two** of
each match:

- `getByText(/answered/i)` — the substring is inside `Unanswered`, so the tile
  label and the section heading for *both* groups match it. Even rendering only
  the intake's four tile labels (`Total reviews / Unanswered / Answered / Avg
  rating`) is already two matches.
- `getByText('Great food!')` — `makeRow()` and `answeredRow()` share the default
  `review_text`, so the unanswered and answered fixtures both render it.

`getByText` throws `getMultipleElementsFoundError` on >1 match, so the test
failed on element counting, never on behaviour, and no copy choice fixes the
second one. **Repaired, not relaxed:** the three assertions became
`getAllByText(/^unanswered$/i)`, `getAllByText(/^answered$/i)` and
`getAllByText('Great food!')`, each pinned to `toHaveLength(2)` — strictly more
than the originals asserted, with anchors so `/^answered$/` cannot match
`Unanswered`. The **title is unchanged**, and the intake's tile copy and the
glossary's `Unanswered`/`Answered` group headings both ship verbatim.

**(b) `row_state` is typed `string` at the card boundary, not `ReviewRowState`.**
The same eval pins `interface ListRow extends PastReplyRow { row_state: string;
provenance_badge?: string | null }`. An interface may not widen an inherited
member, so declaring `row_state: ReviewRowState` on `PastReplyRow` makes the
eval itself a typecheck error (TS2430). The brief's instruction — "the eval pins
your prop shapes" — wins over the stronger type, so `PastReplyRow.row_state` is
`string` and `ReplySide` narrows **once**, at the wire boundary, with
`row.row_state as ReviewRowState`. The exhaustiveness goal is fully preserved:
the `switch` still ends in `const unreachable: never = state`, so a seventh
`ReviewRowState` member fails typecheck rather than rendering a blank half-card.
`ReviewsListRow` (server side) keeps the strong `ReviewRowState` and is
assignable to the widened wire type, so nothing downstream weakens.

**(c) `ReviewsTabs` / `ReviewsContent` / `reviews/page.tsx` moved from T8 to T7.**
The plan assigns the `historyEnabled` drop + `History` → `All Reviews` rename to
Task 8 Step 3, but the eval's `ReviewsTabs renders the All Reviews tab
unconditionally` renders `<ReviewsTabs active="history" />` with no
`historyEnabled`, which is one of T7's 11 starting typecheck errors and cannot
be cleared from any other file. T7 therefore drops the prop, renames the tab,
and updates the two call sites (`ReviewsContent`, `reviews/page.tsx`) plus their
suites. **`flags.ts` is untouched** — `pastRepliesViewEnabled()` still exists and
is still exported; only its two page-level callers are gone. Task 8 still owns
the collapse, the env-registry retirement, and the docs sweep, and its two
`flags.test.ts` titles are still red exactly as intended.

**Also folded in (mechanical, no behaviour change):** `Edit reply` on an answered
row is renamed `Regenerate` — one CTA into the same `EditReplyDrawer`, not a
second button beside it — and the three suites that queried it by name
(`PastReplyCard.test.tsx`, `PastRepliesClient.test.tsx`,
`useEditReplyDraft.test.tsx`) were updated with their fixtures. The three
`PastRepliesClient` tests that pinned the deleted gap/historical bucketing
(`hasHistoricalSection` for orphan-only hist rows, and the two orphan-count
reconciliations) are deleted with the behaviour they guarded.

**ORCHESTRATOR (2026-08-08): all three verified before acceptance.**

(a) Confirmed by reading the diff, not the report. `/answered/i` genuinely
matches `Unanswered`, so the original threw `getMultipleElementsFoundError` and
tested nothing; the replacement anchors the patterns and pins exact counts. The
locked-title check still reports **0 missing of 52** — the repair touched
assertions, never a title. This is the one class of eval edit that is legitimate:
the test was unsatisfiable as written, and the replacement is strictly stronger.

(b) Confirmed the exhaustiveness survives: `PastReplyCard.tsx:190` casts once at
the wire boundary and `:286` still holds `const unreachable: never = state`, so a
seventh `ReviewRowState` member fails typecheck rather than rendering blank.
**Flagged for step 7** — a reviewer should decide whether the eval's `ListRow`
should instead have been retyped to `ReviewRowState`, which would delete the cast
entirely. Not worth a fix round now: the cast is documented, narrow, and the
server-side `ReviewsListRow` keeps the strong type.

(c) Forced, not chosen — the tabs test is one of T7's 11 typecheck errors and no
other file can clear it. `flags.ts` was left untouched, so T8's scope survived
intact and its two red titles stayed red exactly as intended.

**Verdict:** ACCEPT.

---

## D17 — T8: `worker/jobs/publisher/__tests__/**` is outside the surface, so one stale `PAST_REPLIES_VIEW_ENABLED` reference survives

**Trigger:** Task 8's brief lists "the worker integration test" among the call
sites to update. `worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts`
sets, captures and restores `process.env.PAST_REPLIES_VIEW_ENABLED` in three
places, and carries the comment "Edit routes require BOTH flags". D1 added
`worker/jobs/publisher/ResponsePublisherWorker.ts` and `failed-hook.ts` to
`allowed_edit_surface` but **not** that directory's `__tests__/`, so
`edit-surface-guard.sh` blocks the edit.

**Why it is not worth an amendment:** the surviving reference is three
assignments of a now-unread env var plus one comment — it names no deleted
symbol, changes no behaviour, and the suite still passes because it sets
`EDIT_REPLIES_ENABLED=true` alongside it, which is the whole predicate now.
Widening the surface would burn amendment **#2 of 2**, which trips the abort
criteria, for a cosmetic cleanup.

**Decision:** leave the file untouched; the reference is reported as a known
surviving hit and folded into #680's cleanup alongside the frozen legacy
columns. `scripts/ci/process-env-baseline.ts` needed no entry deletion (D11
confirmed), but its *prose* citation of the deleted `replyEditingFlagEnabled()`
was corrected in place — that file IS in the surface.

**Same fence, four LIVE docs — these are the ones that matter operationally.**
`docs/runbooks/**`, `docs/adr/**` and `docs/eservices-variables.md` are all
outside `allowed_edit_surface` (only `docs/directory.md`, `docs/currents.md`,
`docs/superpowers/{plans,specs}/**` and `docs/reviews/**` are in), so five
now-wrong instructions survive and need a **follow-up PR** — they will otherwise
tell a future operator to set a variable that no longer exists:

| File:line | Says | Should say |
|---|---|---|
| `docs/runbooks/deployment-guide.md:155` | "requires `PAST_REPLIES_VIEW_ENABLED=true`" | `EDIT_REPLIES_ENABLED` is the sole gate |
| `docs/runbooks/gbp-api-application.md:67` | "`PAST_REPLIES_VIEW_ENABLED=true` (every edit route checks both flags)" | one flag, not both |
| `docs/runbooks/edit-existing-replies-testing-runbook.md:23` | sets the retired var in its env block | drop the line |
| `docs/eservices-variables.md:120` | lists the flag in the tracked-vars roster | drop the entry |
| `docs/adr/0015-…:11,45` | cites it as a live flag in the unflagged-replacement rationale | note it was retired at #678 (this ADR's own posture) |

**OWNER RULING (2026-08-08): fix them now, as CI-adjacent bookkeeping — budget NOT
burned.** `allowed_edit_surface` widened in both intake copies (verified
byte-identical) to add the five files. Amendment budget stays at **1 of 2**.

This extends the D13 precedent one step: D13 covered an edit a *tool*
mechanically demanded, this covers an edit the *repo working rule* demands
("when deleting a doc reference, clean every live cross-reference in the same
change"). The common test is that the edit is a mechanical consequence of an
in-surface change rather than new scope — and that shipping without it leaves
the tree in a state the project's own rules call broken. Five docs that instruct
an operator to set a variable which no longer exists is that state.

**Applied.** `deployment-guide.md` and `gbp-api-application.md` now name
`EDIT_REPLIES_ENABLED` as the **sole** gate; `edit-existing-replies-testing-runbook.md`
drops the retired line from its `.env.local` block with a note on why;
`eservices-variables.md` moves the flag out of the live roster into a `Retired:`
line. `adr/0015` gets a **dated superseding note** at Decision §1 rather than a
rewrite — its Context §11 mention is left exactly as written, because it
accurately records the flag landscape at the 2026-08-05 decision, and an ADR is
a historical record, not a live document. The note frames the retirement as this
ADR's own reasoning applied one ticket later: the flag's only job was hiding an
incomplete surface, and the surface is now complete.

**Verified after the sweep** — every surviving `PAST_REPLIES_VIEW_ENABLED`
mention outside `docs/progress-archive/**`, `completed_runbooks/**` and the
2026-05/06 plans is now either a retirement record or sits beneath an explicit
`HISTORICAL — superseded at #678` marker (`currents.md:1608`). `lab-notes.md`
keeps the two-flag rollout *pattern* — it generalizes beyond this feature — with
a dated entry recording that this feature's UI half is retired and must not be
resurrected.

The `worker/jobs/publisher/__tests__/` reference stands as T8 left it: three
assignments of a now-unread env var, behaviour-neutral, folded into #680.

**Verdict:** ACCEPT.

---

## D18 — the re-classification trigger fired on both buckets (2.7×), and the lane did not change

**Trigger:** the step-5 gate's `reclassify` row:

```
RECLASSIFY: production 2438 > 2x estimated_prod_lines (900);
            test 3034 > 2x estimated_test_lines (1100)
```

59 files. The workflow's response to this is not advisory — it says STOP and
re-run step 0 with the real numbers.

**Step 0, re-run against the actual diff.** Measured against the EPIC criteria,
none of the four hold:

| EPIC criterion | Actual |
|---|---|
| surface can't be declared tighter than a few top-level directories | declared file-by-file; `ci:feature-surface` passes 38/38 in-surface |
| spans multiple risk domains (schema + billing + worker) | **no migration**, no billing; `worker/` is a 3-file flag rename |
| decomposes into more than ~8 tracer tickets | decomposed into exactly **8**, all landed |
| open investigation questions grilling can't resolve | `open_questions` empty since intake |

Classification therefore stands at **RISK=high · SURFACE=mixed ·
db_touching=true** — already the heaviest non-epic lane, and the one whose
controls actually ran: 3 plan-review rounds (spent), dual + adversarial review
(step 7), staging ride before the PR (step 8).

**What was actually wrong was the estimate, not the lane.** D4 recorded the
owner's decision not to pad 900/1100 precisely so this trigger would stay
meaningful, and it did its job: it fired, forced an explicit re-derivation, and
the re-derivation confirmed the lane. That is the control working, not failing.

**Calibration note for future intakes.** The 2.7× miss is concentrated in work
the intake named but did not size: the eval task alone shipped ~2,360 test lines
against a 1,100 estimate, because 52 locked titles across 9 files (37 → 50 → 52
via D3/D8) were counted as titles, not as lines. A `tests_to_add` list that grows
by 40% mid-plan is itself a signal the test estimate has moved; neither D3 nor D8
revisited it.

**OWNER RULING (2026-08-08):** proceed to step 7 review under the existing high
lane.

**Verdict:** ACCEPT.
