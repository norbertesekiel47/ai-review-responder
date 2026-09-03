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
