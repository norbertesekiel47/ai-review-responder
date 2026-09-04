# Deviations — fix/1083-ledger-attribution

Entries are things the plan did not anticipate. Each needs a resolved
**Verdict:** ACCEPT or RE-PLAN before the `reviewed` transition will pass.

---

## D1 — Ticket #1083's lane count was one lane out of date

**When**: step 0, classification.

The ticket says one lane attributes and six do not. It was filed 2026-09-02.
PR #1098 (#1079) merged 2026-09-03 and added the `held_draft` arm. At HEAD
`2be0c323` **two lanes attribute and five do not**, across seven call sites.

No scope change follows. The mechanism chosen covers all seven lanes regardless
of how many were already wrapped, and the plan's table records the true state.

**Verdict:** ACCEPT — a stale count in the ticket, corrected in the plan. The
work is unchanged.

---

## D2 — The stale ladder carried into `progress.mjs init`

**When**: step 0, opening the ladder.

`progress.mjs init` in the parent checkout returned a ladder whose `intake` and
`armed` steps were already `done`, timestamped `2026-09-03T10:30:06Z` — the
previous #1079 run. Steps 0 and 1 read as complete before any work existed.

This is open issue #1107 (`feature-setup.sh` carries a stale parent ladder).
Reset with `progress.mjs step intake pending` and `step armed pending`, then
re-closed each at its real boundary. `feature-setup.sh` later initialized the
worktree ladder cleanly from the intake with no parent carry, so the defect is
confined to the parent-checkout `init`.

**Verdict:** ACCEPT — worked around, and the underlying defect already has a
ticket. No change to this branch.

---

## D3 — The plan gate raised the test count from 12 to 16 across three rounds

**When**: step 3, plan gate, round 1.

Codex returned `VERDICT: REVISE` with four findings, all verified against source
and all accepted. Three were missing failing tests; one was a stale line
citation. The full table is in the plan's review appendix.

The material one is **F2**: the set arm materializes its rows at
`src/lib/refusals/write.ts:904`, before the INSERT at `:925`, and
`input.occurredAt.toISOString()` at `:922` throws on a type-valid
`new Date(NaN)`. A guard around the statement alone would leave a writer-side
failure unattributed — this ticket's own defect, one layer in. The guard now
starts at the row map.

Round 2 confirmed F1–F3 addressed and raised three residual items, the material
one being that the new "do not hoist `uuidv7()`" instruction had **no test** —
the same defect class as F2, since prose no test enforces is not a rule. A
sixteenth test closes it. Round 3 returned `VERDICT: APPROVED` with no
fix-introduced defects.

`tests_to_add` 12 → 16. `estimated_test_lines` 350 → 450.
`allowed_edit_surface` **unchanged across all three rounds**, so this is a
deviations entry and not a surface amendment; the amendment counter is
untouched.

**Verdict:** ACCEPT — the plan is stronger and the surface did not move.
