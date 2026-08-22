# Deviations — feat-900-solicitation-release-poller

Every entry here is something the plan did not anticipate. Step 6 of `/feature`
reads this file end to end before any review agent runs, and logs an
ACCEPT / RE-PLAN verdict per entry.

Format: `## <task> — <one-line title>` then What / Why / What changed.

Surface amendments are counted separately in `.feature/state.json`; only
`allowed_edit_surface` changes count toward the abort budget. Test-title
retitles and `verification_commands` corrections are owner-approved entries
here, not amendments.

---

## Plan round 1 — intake `tests_to_add` grew 27 → 38, estimates raised

**What:** `tests_to_add` gained eleven titles. `estimated_prod_lines` 780 → 820.
`estimated_test_lines` 1700 → 2300. Both intake copies updated and re-synced;
`scripts/arm-check.sh` re-run and still ARMED.

**Why:** the round-1 adversarial plan review answered its primary question —
*can the eval pass while the feature is still wrong?* — with **yes, eleven
times**. Each accepted finding became a test title rather than a prose note,
per the review protocol.

**What changed:** no `allowed_edit_surface` change, so this is a deviations
entry and **not** an amendment. It does not count toward the abort budget.
Owner-approved by the sign-off that locked the intake, under the workflow's
rule that `tests_to_add` retitles and estimate corrections are entries here.

## Plan round 1 — two DESIGN changes, not just test additions

**What:** (a) the Judge split moved from before the account cap to after every
other gate; (b) the `unknown` sweep now also terminalizes the **Lazy child**
run in the same transaction.

**Why:** (a) a downgrade clears `approved_at` — a destructive write that must
never fire for a batch the account cap alone would have stopped. (b) confirmed
at `src/lib/solicitation/dispatch.ts:1752`: #899's tx1 creates the child run
*before* the `sending` CAS, so a crash leaves a `running` child that
`deriveRunDisplayState` reports `stalled` forever. Terminalizing only the
Outreach row re-opened the wedge from the spine side.

**What changed:** the plan's governor-order section, Task 3 step 4, and Task 6
steps 2–3. No intake decision was invalidated, so no RE-PLAN.
