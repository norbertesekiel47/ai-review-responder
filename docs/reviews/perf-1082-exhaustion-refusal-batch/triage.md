# #1082 — review wave round 1, triage

Wave dispatched at HEAD `4f39fbd2`, fork `b9fb9601`. Five axes: spec &
correctness, standards & maintainability, async & transaction semantics,
red team, Codex adversarial-approach.

Full reports: `async.md`, `spec-correctness.md`, `standards-maintainability.md`
in this directory; `blast-radius.md`; red-team sidecar at
`docs/reviews/red-team/perf-1082-exhaustion-refusal-batch-63c82c/`.

The production diff was 87 changed lines, above the standards axis's 300-line
threshold only by risk class: `RISK = high` runs that axis unconditionally.

## Verdicts

| ID | Sev | Axis | Finding | Verdict |
|---|---|---|---|---|
| T1 | high | standards | The bound is `BATCH_CAP` 25, not `MAX_DATA_ROWS` 5,000 — rationale 200x too large in 4 places | **FIXED** — see D4 |
| T2 | P0 | red team | The `invocationCallOrder` "LOAD-BEARING" claim is false; plain concatenation is green | **FIXED** — see D5 |
| T3 | med | standards, spec, async | `recordOutreachWithheldRefusal` docblock still claims three call sites; two remain | **FIXED** — census corrected, and the keep-vs-inline decision recorded in the docblock |
| T4 | low | spec | `mockClear()` at the mapping test's phase boundaries is one-armed | **FIXED** — `clearRefusalCalls()` |
| T5 | P1 | red team | 8 `path:line` citations stale at HEAD; `prevalidate-plan.py` resolves files, not lines | **FIXED** — plan and intake now cite BY SYMBOL |
| T6 | P2 | red team | Intake observability claim conflates the job's Sentry issue with the settlement's own signal | **FIXED** — verified `deadLetterWholeBatch` catches and never rethrows |
| T7 | P2 | red team | "no holes" test title states a property its assertions do not | **FIXED** — the title's property asserted first and alone; the design pin split out and labelled |
| T8 | P1 | red team | The new abort test duplicates the pre-existing per-writer rollback case | **PARTLY ACCEPTED** — kept, comment now names the sibling and the two real differences (2 holes vs 1; a Postgres 22012 abort vs a JS throw) |
| T9 | med | Codex | N live kill-switch reads became one deferred read | **REJECTED** — see D6/R1 |
| T10 | med | spec | The unit suite is intermittently red at HEAD | **REJECTED** — see D6/R2 |
| T11 | low | async | `docs/directory.md` prose stale | **RAISED, NOT TAKEN** — outside `allowed_edit_surface`; follow-up filed |
| T12 | med | standards | Inline `recordOutreachWithheldRefusal`, now a pass-through | **REJECTED** — see D6 |
| T13 | med | Codex | No measurement; the lock window is still O(N) | **ACCEPTED, OWNER DECISION** — the owner chose a controlled staging drill over shipping on reasoning |
| T14 | high | Codex | A normal staging ride cannot reach `settleGenerationExhaustion` while `SOLICITATION_SEND_ENABLED` is off | **ACCEPTED, OWNER DECISION** — controlled drill, not a plain ride |

Reasoning for every rejection is in
`docs/superpowers/plans/perf-1082-exhaustion-refusal-batch-deviations.md`
§ D4-D6. No finding was skipped silently.

## The axis disagreement, and how it was settled

The standards axis derived the bound as 25 from `BATCH_CAP`. The async axis
re-derived it as 5,000 from the candidate window and wrote "no correction
needed" in the same wave. Neither axis settled it — the code did:

1. `holes` filters `ask.status = 'send'`.
2. `commitAskDecisions` writes `status: decision.decision`.
3. `evaluateBatch` keeps at most `BATCH_CAP` = 25 `send` decisions.
4. `AskDecision` is `send | withhold`; the sole `UPDATE solicitation_asks`
   sets `agent_run_id`, never `status`.

The async axis conflated *asks inserted* — up to 5,000, nearly all `withhold` —
with *asks carrying `status='send'`*, which is at most 25.

## Round 2 — red team, scoped to the fix commit `aa3fab6e`

All six round-1 findings verified fixed. Five new findings, every one about
the FIXES rather than the code.

| ID | Sev | Finding | Verdict |
|---|---|---|---|
| T15 | P0 | The T2 fix retracted one unmeasured "LOAD-BEARING" and asserted a second one in the same bullet — `clearRefusalCalls()` is also inert today | **FIXED** — I re-ran the mutation myself before rewriting: one-armed clear leaves 51/51 green. Both helpers now documented as inert-today trap-removers |
| T16 | P1 | "27 executable lines added (40 comment, 3 blank — measured AT HEAD)" was falsified by the commit that re-published it: 66 comment lines at `aa3fab6e` | **FIXED** — the row now quotes the stable half (27 code) and the METHOD, and says re-derive. Same failure the #1080 row records by name, one entry later |
| T17 | P1 | The "CITATIONS ARE BY SYMBOL" banner was itself false — two bare citations survived, one (`:1632`) unresolvable | **FIXED** — the rule is now stated correctly: symbol for files this branch edits, line permitted for files it does not. The two survivors are gone |
| T18 | P2 | The intermittent-suite rejection refuted a desync mechanism nobody proposed; the axis said it could not identify one | **FIXED** — rejection now rests on volume (340 runs, 0 failures across two heads), and the finding is recorded as unexplained rather than solved |
| T19 | P2 | The bound comment added a line citation into `restraint-policy.ts` from production code | **FIXED, and the rule that first excused it was wrong** — see below |

**Red team independently re-derived and CONFIRMED `BATCH_CAP` = 25**, including
the question I had not closed myself: a batch cannot be rebuilt past the cap,
because `constructBatch` returns `already_built` when `built_at IS NOT NULL`
and `built_at`'s single writer is guarded on `built_at IS NULL`. Two write
statements repo-wide, no trigger.

Also verified: the `@vitest/spy` cannot-desync claim, `deadLetterWholeBatch`
never throwing on any path, the abort comment's both halves, and the
`recordOutreachWithheldRefusal` census.

## Round 3 would have been the citation rule — caught by taking main instead

There was no round 3; `round-start` refuses one. Taking main before shipping
found the defect anyway, which is the argument for taking main before shipping.

`origin/main` moved three commits while this branch was in review, and #1093
touched `restraint-policy.ts` — moving `evaluateBatch`'s cap logic from
`:440-448` to `:579-587`. T19 had been accepted on the rule "a file this branch
does not touch may be cited by line". **That rule is wrong**, and this is the
counter-example: the branch never touched the file, and the citation went stale
regardless, because main moved underneath it.

The rule is now unqualified — **cite by symbol, always** — and it took three
attempts to get there:

| Form | Fate |
|---|---|
| "Citations are by symbol" | False when written; two bare citations survived, one unresolvable (red team round 2) |
| "By symbol for edited files; by line for others" | Passed a full review round, then falsified by #1093 moving an unedited file |
| **"By symbol, always"** | Current. A line number is a fact about a TREE, not a codebase |

**Scope clause — stated as a TEST, not as a list.** The first version of this
clause enumerated the two buckets, and the enumeration leaked: it named the
plan, the intake, production comments and this file as living, and the review
reports and red-team sidecar as dated, which left the **deviations file** and
this branch's own **arch-review-log row** in neither. A stale figure survived in
exactly that gap (the D1 finding below). Enumerations of a category are how
things fall out of it.

The test, which needs no list:

> **Is this document asserting what is true NOW, or recording what was measured
> THEN?** A document that a reader will act on as current is LIVING and cites by
> symbol. A document that names the SHA it measured is DATED evidence, and its
> line numbers are correct as history — rewriting them would falsify the record
> rather than repair it.

Applied: the plan, both intake copies, production comments, the deviations file,
the arch-review-log row and this file are LIVING. The four review reports and
both red-team sidecars are DATED. Arch-review-log rows written by other branches
are theirs, not this branch's to touch either way.

**A living document may still quote a moving figure — but only one of them may
own it.** The comment-line count moved three times on this branch (40 → 66 →
68), and the arch-review-log row is its single owner. Every other mention points
there instead of restating it.

## Fresh red-team run at `a40fe38d` (post-rebase)

The rebase voided the previous sidecar, so a new run measured the rebased tree
rather than extrapolating. Two findings, both mine, both prose.

| ID | Sev | Finding | Verdict |
|---|---|---|---|
| T20 | P1 | Deviations D1 still said "40 comment lines … 1.5x the code" — the twin of the figure T16 fixed in the arch-log, missed in that sweep. False at HEAD (27 / 68 / 2.5x) | **FIXED** — D1 no longer quotes the count; the arch-log row is named as its single owner |
| T21 | P2 | The LIVING/DATED scope clause enumerated both buckets and classified the deviations file and this branch's arch-log row into neither — the gap T20 survived in | **FIXED** — the clause is now a test, not a list |

**What the run confirmed, independently derived rather than taken:**

- **The bound chain HOLDS at HEAD. 25, not 5,000. No P0.** Re-derived link by
  link on the rebased tree: `solicitation_asks` has exactly two production write
  statements, `decisions` has one source, `evaluateBatch` slices at
  `BATCH_CAP = 25`, and a batch cannot be rebuilt (`built_at` under
  `FOR UPDATE`). #1093 rewrote only `resolveVertical` and added
  `SUBCATEGORY_VERTICALS` — it touched neither the cap nor any `status` writer.
  No semantic coupling either: `settleGenerationExhaustion` never calls
  `assembleInterpolation`, the lane's only `resolveVertical` reader.
- **11 mutations, 9 killed.** The two survivors are the `invocationCallOrder`
  sort and the two-armed `clearRefusalCalls` — and **the branch's current claim
  that both are inert today is TRUE**, re-measured at 51/51 each. The third
  attempt at that sentence is the correct one.
- The `tx`→`sql` hoist is blind to the unit lane and killed in the live-DB lane
  by the new abort case *and* two pre-existing cases — confirming this branch's
  own "not the only guard" note.
- Sibling sweep: nine production ledger call sites, zero enclosing loops.
- **100 consecutive unit runs at `a40fe38d`: 0 failures.** Running total across
  five observers and three heads: 2 failures in ~102 at the oldest head, 0 in
  440 since.

## The pattern this branch should be remembered for

Six false self-claims across three rounds and a rebase, all mine, all the same
shape: **a fact asserted where a cheap measurement was available.**

| # | Claim | How it died |
|---|---|---|
| 1 | "up to 4,999 round trips" | 5,000 quoted from a sibling lane instead of derived; the real bound is 25 |
| 2 | The sort is "LOAD-BEARING" | Mutation: plain concatenation stays green |
| 3 | `clearRefusalCalls` is "load-bearing" | Written in the commit fixing #2, also without running the mutation |
| 4 | "40 comment lines, measured AT HEAD" | Falsified by the commit that published it |
| 5 | "Citations are by symbol" → then "by line for unedited files" | Two survivors; then a rebase staled an unedited file's citation |
| 6 | D1's "40 comment lines … 1.5x" | The twin of #4, missed in the sweep that fixed #4 |

**The code was correct in every round.** Nine of eleven mutations killed, the
bound chain re-derived twice by two independent parties, 440 clean runs. What
kept failing was what I wrote *about* the code.

Three rules came out of it, now in the arch-review-log:

1. **RUN THE MUTATION BEFORE WRITING THE ADJECTIVE.** (#2, #3)
2. **CITE BY SYMBOL, ALWAYS** — a line number is a fact about a tree, not a
   codebase. (#5)
3. **A FIGURE THAT MOVES NEEDS ONE OWNER**, and every other mention points at
   it rather than restating it. (#4, #6)

And the meta-lesson under all six: a self-describing claim is the cheapest thing
to check and the easiest to skip, because nothing fails when it is wrong.

## What survived the wave unchanged

The code. Same-`tx` guarantee proven by type; self-conflict inside the one
statement unreachable because every `subject_id` is a fresh `uuidv7`; error
semantics, retry idempotency and the one-warning-per-disabled-episode budget
all unchanged; 7/7 non-goals, 11/11 edge cases and 7/8 invariants verified;
all nine production ledger call sites audited with zero missed loops; 13
mutations journaled and restored with a clean tree.
