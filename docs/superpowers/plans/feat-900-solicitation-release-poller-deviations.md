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

## AMENDMENT 3 — `outcome-anchor-pairing.test.ts`, and the ROOT CAUSE of all three

**What:** `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts` added to
`allowed_edit_surface` (19 → 20 entries). `src/lib/solicitation/release.ts`
added to its `CALLER_ALLOWLIST`, its `NON_REVIEW_SUBJECT_CALLERS`, and the
FOURTH test that pins that carve-out — the pin is deliberate, so a new entry is
a conscious act rather than a silent one. Written with the lock-order
justification the house style requires: batch → run is the sole order, no
reviews or businesses lock is taken, and every governor runs ABOVE the
transactions with no lock held.

**ROOT CAUSE, stated once for all three amendments.** They are not three
separate scope creeps. They are ONE intake defect with three symptoms: the
intake declared **one of the four** governance registries that any new
cross-account, spine-writing background loop must touch.

| Registry | Declared at intake? |
|---|---|
| `docs/directory.md` | YES |
| `src/lib/agents/run-spine.ts` — `STEP_PERSONA` | no → amendment 1 |
| `scripts/ci/tenant-scope-allowlist.ts` — `background-global-scan` | no → amendment 2 |
| `src/lib/approval/__tests__/outcome-anchor-pairing.test.ts` — `CALLER_ALLOWLIST` | no → amendment 3 |

All four were foreseeable when the intake was written. None was foreseen. The
abort budget fired on symptom 2 and would have torn down a branch whose work
was on estimate and whose plan had passed three adversarial review rounds —
which is why the owner overrode it, on the reasoning that the criterion targets
a MIS-CLASSIFIED LANE and this lane was not mis-classified.

**Owner sign-off taken 2026-08-22, separately for each of the three.**

**PROMOTION OBLIGATION (step 8):** this four-registry list goes into
`.claude/reference/lab-notes.md`, so the next feature touching this class
declares them at intake instead of discovering them one gate failure at a time.
Recording it only here leaves the lesson where the next session will not look.

**Verified complete, with a caveat:** the full 12,897-test suite flags exactly
these. The sibling registries in the same family — `cost-guard-contract`,
`admin-aal2`, `analytics-events`, `purge-verification` — do not apply to this
module. Tasks 4-7 add more spine writes, but all from `release.ts`, so they
reuse this same entry.

## AMENDMENT 1 of 2 — `src/lib/agents/run-spine.ts` added to `allowed_edit_surface`

**This is a surface amendment and it COUNTS toward the abort budget.** A second
one triggers the abort criteria: stop, post-mortem, tear down, restart at step 1.

**What:** `src/lib/agents/run-spine.ts` added to `allowed_edit_surface`
(17 → 18 entries). Both intake copies updated, `scripts/arm-check.sh` re-run
and still ARMED.

**Why:** Task 3 step 4 records the Judge downgrade as an `approval_downgraded`
spine step — the DURABLE record, where the Sentry warning is ephemeral. But
`AgentStepKey` derives from `STEP_PERSONA` in that file, which carries 21 keys
and none that fits. `policy_gate` belongs to the Reply lane's auto-approval gate
and `batch_approved` is the opposite fact; filing a Judge-driven un-approval
under either collapses two distinct facts into one key, which is exactly what
the `CONTEXT.md` glossary discipline forbids.

Not auto-approved under step 2's rule, because `src/lib/agents/` is not a
directory tree the surface already covers. **Owner sign-off taken 2026-08-22.**

**What changed:** Task 3 adds one line — `approval_downgraded: 'solicitation'`.
Nothing else in that file may be touched.

## Task 0 correction — `SOLICITATION_PLATFORM_DAILY_CAP` needs NO amendment

**What:** Task 0 flagged that the plan's
`getWorkerConfig().SOLICITATION_PLATFORM_DAILY_CAP` does not typecheck, because
#898 registered the var on the SERVER schema (`src/lib/config/server.ts:221`).

**Why it is not an amendment:** `src/lib/config/worker.ts` is already on the
surface, and both schemas may legitimately declare the same var (the
`RESEND_FROM_EMAIL` precedent). Task 3 adds one line there.

**What changed:** nothing to the surface. Recorded so a reader does not count
this as a second amendment.

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

## Task 0 — `approval_downgraded` is not a `STEP_PERSONA` key, and its owner is off-surface

**What:** Task 3 step 4 mandates `recordStep(tx, { stepKey: 'approval_downgraded', … })`.
`AgentStepKey` is derived from `STEP_PERSONA` in `src/lib/agents/run-spine.ts`,
which carries no such key today — and that file is NOT in
`allowed_edit_surface`.

**Why:** `agent_run_steps.step_key` has no DB CHECK, so `STEP_PERSONA` is the
whole vocabulary; a missing key is a TypeScript error at the call site, not a
runtime surprise. `release.integration.test.ts` asserts the step exists with
`detail.reason = 'judge_unavailable'`, so Task 3 cannot land without it.

**What changed:** nothing yet — the eval task writes only tests. Task 3 needs
either a one-line `STEP_PERSONA` addition (`approval_downgraded: 'solicitation'`)
plus a surface amendment for `src/lib/agents/run-spine.ts`, or an existing key.
Flagging it here so the amendment is a decision rather than a surprise mid-task.

## Task 0 — `SOLICITATION_PLATFORM_DAILY_CAP` lives in the SERVER config, not the worker one

**What:** the plan's governor list reads
`resolvePlatformDailyCap(getWorkerConfig().SOLICITATION_PLATFORM_DAILY_CAP)`.
The var is registered in `src/lib/config/server.ts:221`, not in
`src/lib/config/worker.ts`, so that expression does not typecheck today.

**Why:** #898 registered and boot-asserted it on the server schema while
enforcement was still unbuilt. Both schemas may legitimately declare the same
var (the `RESEND_FROM_EMAIL` precedent), so the fix is a one-line addition to
`worker.ts` — which IS on the surface.

**What changed:** the tests set `process.env.SOLICITATION_PLATFORM_DAILY_CAP`
and clear BOTH memos (`resetServerConfigForTests` + `resetWorkerConfigForTests`),
so they hold whichever schema Task 3 reads.

## Task 0 — three fixture traps the plan's predicates do not mention

**What:** three live-schema constraints shaped the fixtures and will shape the
implementation:

1. `solicitation_batches_send_ordering` requires `sending_started_at >=
   approved_at`, so a mid-drip `unknown`-sweep fixture cannot pair a
   90-minute-old drip start with a one-hour-old approval. Hence
   `wedgedBatchInput()` in `release.integration.test.ts`.
2. `solicitation_batches_one_active_send_per_business` admits ONE approved,
   unhalted, unclosed batch per business. A case needing two live approved
   batches needs a second LOCATION, not a second batch — the flag-scope case
   uses three.
3. `agent_outcomes`' column is `outcome_kind`, not `kind`. Caught by probing
   every reader against the live schema rather than by the suite, because a
   `.fails` body masks a bad query behind the expected `not implemented` throw.

**Why:** each would have surfaced as a CHECK violation or a 42703 inside an
implementation task, reading as "the feature is wrong" rather than "the fixture
is wrong".

**What changed:** fixtures only. Recorded so Task 6 and Task 7 inherit them.

## Task 0 — the poller's interval can never overlap a cycle, so single-flight is reached through stop/start

**What:** `SolicitationReleasePoller`'s `CYCLE_TIMEOUT_MS` (45s) is below
`DEFAULT_INTERVAL_MS` (60s) by design, so a hung cycle always frees the
single-flight flag one deadline BEFORE the next tick. An interval-driven
overlap is therefore unreachable, and the first draft of the loop-mechanics
test asserted one and failed.

**What changed:** `SolicitationReleasePoller.test.ts` reaches the overlap
through a `stop()` + `start()` mid-cycle (start runs one cycle immediately) and
adds a second case for the #414 property the numbers actually encode — a cycle
that outruns its deadline frees the flag and the loop recovers in one interval.

## Task 0 — the file split is 33 / 4 / 1 / 1, not 36 / 3

**What:** the task brief said `release.integration.test.ts` carries 36 of the 39
titles "except the three listed under the other three files"; six titles are
listed under those three files. The actual split is 33 live-DB release titles,
4 in `approval-system-halt.integration.test.ts`, 1 in `release.test.ts`, 1 in
`job-outbox-helpers.test.ts`.

**What changed:** nothing but the count. The plan's own Step 2 table is correct
and was followed verbatim; all 39 titles verify present character-for-character.

## Task 3 — a FOURTH fixture defect: `beforeEach` re-armed every delegating spy with itself

**What:** `release.integration.test.ts`'s `beforeEach` re-armed its four
delegating spies from a plain `await import(...)`. This file `vi.mock`s all four
of those modules, so a dynamic import inside it returns the **mock**, not the
original — `spies.readSendBreaker.mockImplementation(breaker.readSendBreaker)`
therefore set each spy's implementation to the spy itself. Every case that
reached one died with `RangeError: Maximum call stack size exceeded` before its
own assertions ran. 31 of the 33 cases failed that way; the only two that did
not were the flag-off case (returns before any spy is touched) and the breaker
read-failure case (overrides the spy with `mockRejectedValue` first).

**Why it was invisible:** `it.fails` passes whether the body fails for the right
reason or the wrong one. The recursion presented as "the feature is not built
yet" in exactly the same shape as a genuine red, and would have presented as a
mysterious mass failure to whichever task first unmasked. Found by the mandatory
unmask step, which is the fourth defect that step has caught on this branch.

**What changed:** the four re-arms now use
`vi.importActual<typeof import('…')>('…')`. The re-arm itself is KEPT and is
load-bearing: `vi.clearAllMocks()` clears calls, not implementations, so without
it a case's `mockResolvedValue(false)` leaks into the next case. Test-only, on
Task 3's surface, and the header comment now states the trap. No production
behaviour is involved, so ACCEPT rather than RE-PLAN.

## Task 3 — three negative cases were unmasked while they still pass VACUOUSLY

**What:** `does not latch batch_expired on a batch with no Send batch parent`
(Task 5), `does not terminalize a sending row while an in-flight outbox row
still exists` and `does not terminalize a sending row whose outbox row is
re-pended after selection` (both Task 6) all pass today — because their sweeps
are still stubs returning 0, not because the predicate they describe works.

**Why they were unmasked anyway:** `it.fails` on a body that PASSES is a hard
suite failure ("Expect test to fail"), so leaving the marker would have left the
suite red on a green tree. Task 3's verification contract requires both suites
green.

**What changed:** the three markers were removed. **Tasks 5 and 6 must re-verify
these three for the reason their titles state** — after the sweep exists, delete
its predicate's guard arm and confirm the case goes RED. A green run alone is
not evidence for any of the three until then.

## AMENDMENT 2 of 2 — `scripts/ci/tenant-scope-allowlist.ts` added to `allowed_edit_surface`

**This is the SECOND and LAST surface amendment. A third trips the abort
criteria.** Owner sign-off taken 2026-08-22; `allowed_edit_surface` 18 → 19
entries, both intake copies synced, `scripts/arm-check.sh` re-run and still
ARMED.

**Resolves the blocker recorded below**, which is kept as written because it is
the argument the entry rests on. Applied exactly as the paste-ready section
specifies: baseline 383 → 385, `src/lib/solicitation/release.ts` added to
`CATEGORY_PATH_RULES['background-global-scan'].allowedFiles`, and two entries
sharing one hoisted `RELEASE_CANDIDATE_SCAN_SQL` /
`RELEASE_CANDIDATE_SCAN_REASON`. `pnpm ci:tenant-scope` passes at 385/385.
Nothing else in that file was touched and no other category was widened.

## Task 3 — the blocker this amendment resolves: `ci:tenant-scope` and predicate P4

**What:** predicate P4 — the release phase's candidate scan, stated verbatim in
the plan's "The four predicates, stated once" — is a cross-account scan of
`solicitation_batches`, exactly like every other background global scan in
`src/lib`. `ci:tenant-scope` therefore reports two findings against
`src/lib/solicitation/release.ts` (one per table the statement binds:
`solicitation_batches` at the top level, `solicitation_outreach` in the
`EXISTS`). Every other statement in the module IS scoped and needs nothing.

**Why it cannot be fixed in code:** the audit proves scope only from a
`column = $N` / `IN ($N)` / `= ANY($N)` predicate bound to a value. A platform
releaser must discover candidates before any tenant id is known, and every
possible entry point (`solicitation_batches`, `businesses`, `accounts`) is a
`TENANT_TABLES` member. This is the same shape as `judge-store.ts`,
`judge-health.ts` and `auto-approval/governor.ts`, all three of which carry
`background-global-scan` allowlist entries. There is no SQL formulation that
avoids it.

**Why Task 3 did not apply it on its first pass:**
`scripts/ci/tenant-scope-allowlist.ts` was not in `allowed_edit_surface`, and the
edit-surface guard blocked it (verified: exit 2). Adding it is a **second surface
amendment** and needed owner sign-off, so Task 3 stopped at the boundary rather
than taking that decision itself. Sign-off was then given — see AMENDMENT 2 of 2
above — and the change below was applied verbatim in a second commit.

**The exact change, paste-ready.** In `scripts/ci/tenant-scope-allowlist.ts`:
`ALLOWLIST_BASELINE` 383 → 385; add `'src/lib/solicitation/release.ts'` to
`CATEGORY_PATH_RULES['background-global-scan'].allowedFiles`; add two entries,
category `background-global-scan`, differing only in `table`
(`solicitation_batches`, `solicitation_outreach`), both carrying this
`sqlSnippet`:

```
SELECT b.id, b.account_id, b.business_id, b.sending_started_at FROM solicitation_batches b WHERE b.approved_at IS NOT NULL AND b.halted_at IS NULL AND b.send_closed_at IS NULL AND b.veto_deadline_at IS NOT NULL AND NOW() >= b.veto_deadline_at AND b.approved_at > NOW() - make_interval(hours => ${BATCH_SEND_WINDOW_HOURS}) AND EXISTS ( SELECT 1 FROM solicitation_outreach o WHERE o.batch_id = b.id AND o.account_id = b.account_id AND o.business_id = b.business_id AND o.delivery_status = 'rendered' ) ORDER BY b.approved_at ASC LIMIT ${scanLimit}
```

Reason to record on both: the release cycle is the single choke point that
enforces every send governor (amendment B3), so it must see every account's
approved batches before it can decide which of them may release; the scan
projects only ids, and every write that follows it is bound to the account and
business those ids carry. Same justification as the three sibling
`background-global-scan` files.

**Everything else on Task 3's verification list passes:** `pnpm typecheck`,
`pnpm lint`, both release suites, both approval suites, and
`ci:db-imports`, `ci:outbox-seam`, `ci:outbox-status`, `ci:static-policy`,
`ci:live-db-suites`, `ci:config-coverage`, `ci:process-env`,
`ci:directory-map`, `ci:outbox-topics`, `ci:feature-surface`, `ci:rls-audit`.
