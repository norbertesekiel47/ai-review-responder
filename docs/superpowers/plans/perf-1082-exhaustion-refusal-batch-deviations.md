# #1082 — deviations

Entries the plan did not anticipate. Each carries a root verdict: ACCEPT (the
adaptation is sound) or RE-PLAN (it invalidates a locked decision).

---

## D1 — the estimate was low by 2.5x in both buckets; the classification is unchanged

**What happened.** The review gate's `reclassify` row fired: production 87
changed lines against an `estimated_prod_lines` of 35. The test bucket is 149
against an estimate of 75. Both are over the 2x trigger; the gate only reports
the production one.

**Why.** I estimated executable lines and forgot this repo's comment mass.
Measured at HEAD by first non-whitespace token, the production diff adds
**27 code lines, 40 comment lines and 3 blank** — the reasoning is 1.5x the
code, which is house style in `src/lib/refusals/` and `src/lib/solicitation/`
and is exactly what the surrounding modules do. The same holds in the tests:
the three new cases are mostly the docblocks explaining why each exists.

**Step 0 re-run, with the real numbers.** All three axes are unchanged.

| Axis | Before | After | Why |
|---|---|---|---|
| `size` | small | small | Breadth is what `size` measures, and breadth did not move: one function body, one helper extraction, two test files. No new module, no new dependency, no schema. |
| `risk` | high | high | Same transaction, same two locks, same silent-data-loss shape. |
| `surface` | backend | backend | Unchanged. |

**Action.** `estimated_prod_lines` 35 → 90 and `estimated_test_lines` 75 → 150
in both intake copies. This is an intake CORRECTION, not a surface amendment —
`allowed_edit_surface` is untouched, so it does not consume the amendment
budget.

**Verdict:** ACCEPT

---

## D2 — the promised-test title had to be re-quoted, not renamed

**What happened.** `promised-tests` failed on
`a generation exhaustion records every hole's Refusal in ONE writeRefusalEvents call, never one call per hole`.
The title was correct; the TypeScript was `it('… hole\'s …')`, and the
backslash escape made the on-disk bytes differ from the intake's.

**Action.** The `it(` call now uses double quotes so the title is verbatim on
disk. No intake edit — the promised title never changed.

**Note for a later pass.** An apostrophe in a `tests_to_add` title is a trap:
the gate greps the file bytes, so any escape sequence breaks it. Prefer a
double-quoted `it("…")` whenever a promised title contains one.

**Verdict:** ACCEPT

---

## D3 — the arch-review-log row had to be written at step 5, not step 8

**What happened.** `ci:merge-ledger` fails any PR that changes a production
file and adds no line to `.claude/reference/arch-review-log.md`. `/feature`
step 8 describes the COUNTER increment as post-merge, so the row itself has to
land before the gate can go green.

**Action.** The row is written now. It was appended after the #1080 row, not
before it — the first insert landed out of date order and was moved, because a
chronological ledger that is not chronological is worse than no ledger.

**Verdict:** ACCEPT

---

## D4 — the ticket's premise was 200x too large, and the branch repeated it

**What happened.** The review wave's standards axis found that `holes` is
bounded by `BATCH_CAP` (25), not `MAX_DATA_ROWS` (5,000). The 5,000 figure came
from the ticket itself and I carried it into the intake, the plan, a production
comment and a test comment without deriving it.

**The chain that settles it**, derived independently of both axes:

1. `holes` filters `ask.status = 'send'`.
2. `commitAskDecisions` writes `status: decision.decision`.
3. `evaluateBatch` keeps at most `BATCH_CAP` = 25 `send` decisions per batch.
4. `AskDecision` is `send | withhold`, and the sole `UPDATE solicitation_asks`
   sets `agent_run_id`, never `status`.

So at most 25 asks per batch can be a hole. The saving is at most 24 round
trips, not 4,999.

**Two axes disagreed.** The async axis re-derived 5,000 from the candidate
window and wrote "no correction needed". It conflated *asks inserted* (up to
5,000, mostly `withhold`) with *asks with `status='send'`* (at most 25). The
standards axis is right.

**Action.** Corrected in five places: the production comment, the test comment,
the plan, both intake copies, and a new bullet (f) in the arch-review-log row.
The owner reviewed the corrected value case and chose to ship.

**Verdict:** ACCEPT

---

## D5 — the branch's "load-bearing" claim about the sort was false (red-team P0)

**What happened.** The `refusalCalls()` docblock and the arch-review-log row
both claimed the `invocationCallOrder` sort was LOAD-BEARING and that arm-order
concatenation "mis-pairs every row the moment a second arm exists". Red team
replaced the sort with plain concatenation and got a green suite. The claim was
false when written.

**Why it was false.** The only arm-mixing test drives W1 → W2 → W3 → W4, and W4
is the only set-arm writer, so its calls are already last. Test ordering, not a
property of the helper.

**Action.** The sort is KEPT — it buys order-independence, and a later
interleaving test would mis-pair silently without it — but both claims are
rewritten to say what is true. A real one-armed hazard *was* found next to it
(the mid-test `mockClear` calls) and is now `clearRefusalCalls`.

**Verdict:** ACCEPT

---

## D6 — three review findings rejected, with reasoning

**R1 — "N live kill-switch reads became one" (Codex, medium).** REJECTED as
unreachable. `readFlagEnabledByDefault` is `process.env[name] !== 'false'`, and
there is no `process.env` assignment anywhere in `src/` or `worker/` outside
tests. The flag changes on redeploy, which restarts the worker, so no
mid-settlement flip exists. The intake's wording is tightened rather than the
code changed.

**R2 — "the unit suite is intermittently red at HEAD" (spec-correctness,
medium).** REJECTED on evidence, with the reasoning corrected after red-team
round 2 flagged that the first version of this entry answered the wrong
question.

The reporting axis was explicit that it **could not identify a mechanism**. My
first rejection refuted a call-array/`invocationCallOrder` desync — a mechanism
nobody had proposed — and presented that as the answer. The desync claim is
true (`mockClear` empties `calls` and `invocationCallOrder` in one function and
the two are pushed on adjacent unconditional lines in `@vitest/spy@4.1.7`, so
they cannot desync), but it answers that axis's appendix item, not its finding.

The finding is rejected on VOLUME, which is the only evidence that speaks to an
unexplained intermittency:

| Where | Runs | Failures |
|---|---|---|
| Reporting axis, at `4f39fbd2` | ~102 | 2 |
| Me, at `4f39fbd2` | 60 | 0 |
| Me, at `aa3fab6e` | 80 | 0 |
| Red team round 2, at `aa3fab6e` | 200 | 0 |

340 runs across two heads with zero reproductions, against 2 in 102. The async
axis independently traced its own single first-run failure to a stale vitest
transform cache, which remains the best available explanation and is a property
of the local cache rather than of this branch. Recorded as unexplained rather
than as solved: if it recurs, this table is the baseline to compare against.

**R3 — `docs/directory.md` prose is stale (async, low).** RAISED, NOT TAKEN.
The file is outside `allowed_edit_surface` and `ci:directory-map` checks row
presence, not prose. Filed as a follow-up rather than widening the surface.

**Also rejected: inline `recordOutreachWithheldRefusal`** (standards, medium).
It is now a pass-through, so deleting it would remove one indirection. Rejected
because half of its docblock — the no-catch rule, migration 116's CHECKs, the
`dispatch.ts` counterpart — describes the WRITE and would sit wrongly on a pure
value builder that performs none. The stale census it carried is fixed instead.

**Verdict:** ACCEPT
