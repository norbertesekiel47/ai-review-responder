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

## Step 3→4 checkpoint — Task 8's registration moved forward, into the stub commit

**What:** `src/lib/solicitation/release.ts` and
`worker/background/pollers/SolicitationReleasePoller.ts` were created as
contract stubs (full public interfaces, throwing bodies) at the plan
checkpoint, together with their two `docs/directory.md` rows and the
`worker/index.ts` registration that Task 8 owned.

**Why:** two audits make the plan's original ordering unreachable.
1. `ci:feature-surface` fails when an `allowed_edit_surface` entry matches no
   file tracked at HEAD or changed on the branch. Both new files were surface
   entries, so the gate could not go green at the checkpoint.
2. `ci:db-imports` grants composition-root status **only** to a poller
   registered in `worker/index.ts`. An unregistered poller that imports
   `@/lib/db/server` fails the audit the moment it exists. Registration cannot
   follow the module it registers.
3. `ci:directory-map` requires a row for every production file under `worker/`
   and `src/lib/` in the same change.

Narrowing the surface and re-adding it later was rejected: that is two
`allowed_edit_surface` amendments, which trips the abort budget for a
bootstrapping-order problem rather than a design problem.

**What changed:** Task 8 now owns only the env var
(`SOLICITATION_RELEASE_POLL_INTERVAL_MS`), the P2 backlog entry and the
poller's loop-mechanics tests. Task 9 refines the two directory rows rather
than writing them. Task 0's expected red moves from "module not found" to
"`runReleaseCycle: not implemented`" — a **stronger** red, since it proves the
contract is importable and the behaviour absent. No intake decision is
invalidated, so ACCEPT, not RE-PLAN.

## Plan round 2 — governor order corrected; one title retitled, one added

**What:** `subscriptionGrantsFullAccess` moved from BEFORE the account cap to
AFTER it. `evaluates the governors in the fixed order breaker then platform
ceiling then account cap` retitled to `… then account cap then subscription`.
One title added: `rolls back unknown Outreach terminalization when lazy-child
completion fails`. Total 38 → 39.

**Why:** amendment B6's closing paragraph states the release-level order
verbatim — *circuit breaker → platform ceiling → account cap →
`subscriptionGrantsFullAccess`*. The plan had inferred the order from B6's
per-child item numbering (item 3 subscription, item 7 caps), which is a
DIFFERENT list and does not govern the release level. The three-governor test
title could pass with the wrong order, which is issue #910's B3.2 hazard exactly:
a wrong governor order is silent.

The added title exists because a success-path test cannot prove that the
Outreach `unknown` write and the child-run terminalization share one
transaction. Only injected failure between them proves it.

**What changed:** the plan's governor-order section and Task 6 step 3; both
intake copies. Still no `allowed_edit_surface` change — a deviations entry,
not an amendment.

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
