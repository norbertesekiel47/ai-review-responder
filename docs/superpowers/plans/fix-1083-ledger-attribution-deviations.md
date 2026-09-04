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

---

## D4 — The set arm's `extra` key for the distinct sources was unspecified

**When**: step 4, integrating T1.

The plan said the set-arm capture carries "`row_count` and the distinct
sources" without naming the key. T1 could not pin what the plan had not named,
so it asserted the sources key-agnostically — a weaker test than the rest of
the eval.

Named on integration: **`refusal_lanes`**, the same sorted comma-joined string
as the `refusal_lane` tag. The duplication is deliberate rather than sloppy — a
Sentry **tag** value truncates at 200 characters and `extra` does not, so a
cohort spanning every lane is exactly the case where the tag can lose a member.
`extra` is the durable copy.

The plan's T3 now states the shape as exactly `{ row_count, refusal_lanes }`,
and the eval pins the key. Test counts unchanged; the file `write.test.ts` was
already in the surface.

**Verdict:** ACCEPT — a gap in the plan, closed with a decision and a stronger
assertion. No scope change.

---

## D5 — Two of the sixteen eval titles pass before implementation

**When**: step 4, T1.

The plan's Done-when says "sixteen new failing assertions". The run shows
**fourteen failing, two passing**, and both passes are correct:

- `commits the response persist when the policy gate resolver would throw and
  the kill switch is off` is #1079's containment invariant. The plan itself
  requires it to pass **both before and after** — it is a regression pin, not a
  red test.
- `attributes a policy gate vocabulary fault without also attributing a write
  fault` passes because the surviving wrapper already reports that fault
  identically before and after T4. It pins that the wrapper's `extra` stays
  `{response_id}` rather than becoming the writer's five-key payload.

The double-attribution risk T4 introduces is caught by `raises exactly one
capture for a policy gate write failure`, which asserts the surviving capture
carries the **writer's** payload. A bare count of one would not have failed —
"delete the writer guard, keep the wrapper" also produces one — so the eval
asserts the shape, not the count.

**Verdict:** ACCEPT — the plan's own Done-when wording was imprecise, not the
eval. Fourteen is the correct number of red tests.
