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

## RE-CLASSIFICATION TRIGGER FIRED — owner elected to proceed as ONE PR

**What:** the step 5 gate's `reclassify` row went WARN at Task 8's commit
(`de893769`). Production changed lines **1717** against `estimated_prod_lines`
820, i.e. 4.7% past the 2x threshold of 1640. The test bucket is INSIDE its
estimate: 2942 against 2300 (2x = 4600).

| File | Added |
|---|---|
| `src/lib/solicitation/release.ts` | 1206 |
| `src/lib/solicitation/approval.ts` | 166 |
| `scripts/ci/tenant-scope-allowlist.ts` | 138 |
| `src/lib/shared/job-outbox-helpers.ts` | 74 |
| `worker/background/pollers/SolicitationReleasePoller.ts` | 74 |
| four others | 31 |

**The leniency argument that was REJECTED, recorded so nobody re-runs it:** the
largest single contributor to the overshoot is `tenant-scope-allowlist.ts`
(+138), whose bulk is justification prose rather than logic; excluding it puts
production at 1551, under the threshold. That file IS production TypeScript, the
gate counted it correctly, and all four entries exist because of this feature.
The overrun is real.

**Why the lane was still right.** RISK = high was correct and is unchanged, and
every control it mandates is still scheduled and none was skipped: the three
parallel review agents at step 7, the staging ride, and the PR pause for explicit
merge approval. What the EPIC path would have bought is different in kind —
decomposition into several smaller PRs. That is a **reviewability** argument, and
it is a real one: the plan decomposed into 11 tasks against the epic criterion of
"more than ~8 tracer tickets", and a 1707-line production diff is hard to review
well in one sitting.

**Owner decision, 2026-08-22: proceed as ONE PR.** Splitting the branch into
stacked PRs and tearing down to re-plan as an epic were both offered and both
declined — the work was complete, gate-green and sensitivity-proven at the time
of the decision, so a teardown would have destroyed 39 verified tests over an
estimate error. **The compensating control is the step 7 review round, which must
NOT be trimmed**: RISK = high gets all three agents, and the reviewers should be
told the diff is 2x its estimate so they size their pass accordingly.

**Lesson for the next intake of this class:** 820 was estimated before the plan
decomposed into 11 tasks. A task count above ~8 is itself an epic signal, and the
estimate should have been revisited at that moment rather than at step 5.

---

## STANDING SIGN-OFF — `ci:tenant-scope` entries for EVERY global scan in `release.ts`

**NOT a surface amendment, and it does not touch the spent abort budget.**
`scripts/ci/tenant-scope-allowlist.ts` has been on `allowed_edit_surface` since
AMENDMENT 2, and `src/lib/solicitation/release.ts` is already a member of
`CATEGORY_PATH_RULES['background-global-scan'].allowedFiles`. The file and the
category are admitted; only each individual STATEMENT is not, because allowlist
matching is `file + table + normalized SQL`.

**What the owner approved (2026-08-22, one decision covering all of them):**
each remaining task adds its own predicate's entry as it lands, in the
`background-global-scan` category, with a hoisted `*_SCAN_SQL` /
`*_SCAN_REASON` pair beside the P4 constants and a reason in the house style.
The alternative offered was a fresh sign-off per predicate; the owner chose one,
on the reasoning that all four predicates were stated verbatim in the plan and
survived three adversarial plan-review rounds, so the entries are the plan
executing rather than scope creep.

| Predicate | Task | Entries | State |
|---|---|---|---|
| P4 — release candidates | 3 | 2 (`solicitation_batches`, `solicitation_outreach`) | applied, baseline 383 → 385 |
| P2 — `send_window_elapsed` | 4 | 1 (`solicitation_batches`) | applied, baseline 385 → 386 |
| P3 — `batch_expired` | 5 | 2 (`solicitation_batches`, `agent_runs` in the `EXISTS`) | applied, baseline 386 → 388 |
| P1 — `unknown` | 6 | expect 1 (`solicitation_outreach`; `job_outbox` is not a `TENANT_TABLES` member) | pending |
| backstop join | 7 | 0 or 1, depending on whether it re-scans or reuses the tick's ids | pending |

**The standing sign-off covers global scans in `release.ts` and nothing else.**
Widening any OTHER category, adding any OTHER file, or touching any other
registry is still a stop-and-surface event. The amendment budget remains spent
at 3 of 2.

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

## Task 4 — `ci:tenant-scope` reports predicate P2 as a SECOND global scan; the Task 3 entry does not cover it

**What:** predicate P2 — the `send_window_elapsed` sweep's candidate scan,
stated verbatim in the plan's "The four predicates, stated once" — is a
platform-wide read of `solicitation_batches` with no tenant predicate, exactly
like P4. `pnpm ci:tenant-scope` therefore reports ONE new finding:

```
src/lib/solicitation/release.ts: solicitation_batches: missing account_id or business_id scope
```

One finding, not two: unlike P4 this statement binds no second table (there is
no `EXISTS` arm — see the predicate's docstring for why a batch with no live
Outreach row must still be selected).

**Why the AMENDMENT 2 entry does not already cover it:** allowlist matching is
`file + table + normalized SQL`, and the two entries added for Task 3 pin P4's
exact `RELEASE_CANDIDATE_SCAN_SQL` text. `src/lib/solicitation/release.ts` is
already in `CATEGORY_PATH_RULES['background-global-scan'].allowedFiles`, so the
FILE is admitted and only the statement is not — this needs one more entry, not
a widened category.

**Why it cannot be fixed in code:** identical to the P4 argument recorded above.
The sweep must find overdue batches across every account before any tenant id
is known, and the audit proves scope only from a value-bound predicate. Every
write that follows is bound to the account and business the scanned ids carry —
`latchSystemHalt` re-reads the row under `FOR UPDATE OF b` with both tenant
predicates spelled, and the latch's cancel, spine step and join are all scoped.

**Why Task 4 did not apply it:** `scripts/ci/tenant-scope-allowlist.ts` IS on
`allowed_edit_surface` (amendment 2), but the branch's surface-amendment budget
is spent and Task 4's brief instructs it to STOP and report a NEW finding rather
than edit that file. The owner decides. Everything else on Task 4's verification
list passes.

**The exact change, paste-ready.** In `scripts/ci/tenant-scope-allowlist.ts`:
`ALLOWLIST_BASELINE` 385 → 386; add ONE entry, `file:
"src/lib/solicitation/release.ts"`, `table: "solicitation_batches"`, category
`background-global-scan`, with this `sqlSnippet` (hoist it as
`SEND_WINDOW_SWEEP_SCAN_SQL` beside `RELEASE_CANDIDATE_SCAN_SQL`; Task 5's P3
will want the same treatment):

```
SELECT id, account_id, business_id FROM solicitation_batches WHERE approved_at IS NOT NULL AND approved_at <= NOW() - make_interval(hours => ${BATCH_SEND_WINDOW_HOURS}) AND halted_at IS NULL AND send_closed_at IS NULL ORDER BY approved_at ASC LIMIT ${scanLimit}
```

Reason to record: the `send_window_elapsed` sweep is the lane that reclaims an
overdue batch's `rendered`/`queued` rows, and until it runs 091's
`solicitation_batches_one_active_send_per_business` index blocks that location
forever (issue #915). It must therefore see every account's approved batches
before it can decide which have run out of window; the scan projects only ids,
and `latchSystemHalt` re-locks each row with both tenant predicates before any
write. Same class as `RELEASE_CANDIDATE_SCAN_REASON`'s three peers.

**What changed:** nothing off-surface. The implementation is committed with
`ci:tenant-scope` red on this ONE finding, exactly as Task 3 committed before
AMENDMENT 2 was signed off.

## Task 5 — the vacuous negative case is re-verified; one of the three obligations is discharged

**What:** `does not latch batch_expired on a batch with no Send batch parent`
no longer passes vacuously. With P3's `EXISTS` over `agent_runs` deleted it is
the ONLY case in `release.integration.test.ts` that goes red
(`AssertionError: expected 1 to be +0` — the watch-mode batch WAS latched), and
it goes green again the moment the arm is restored. Its `TASK 5 MUST RE-VERIFY
THIS` comment is rewritten to record that result rather than to ask for it.

**Why it is recorded here:** the entry "Task 3 — three negative cases were
unmasked while they still pass VACUOUSLY" names three cases and says a green run
alone is not evidence for any of them. This discharges the first. **Task 6 still
owns the other two** — `does not terminalize a sending row while an in-flight
outbox row still exists` and `… whose outbox row is re-pended after selection`
— and must delete P1's `NOT EXISTS` belt to prove each.

**What changed:** the comment on that one case, plus the two `it.fails` markers
Task 5 unmasked. No production behaviour beyond the sweep itself.

**Sensitivity proved, not assumed**, for all three:
`latches batch_expired on a never-approved batch…` and `a batch that receives no
approval for 7 days…` both go red when P3's interval is widened to 500 days
(`expected +0 to be 1`), which is Task 4's 500-hour probe in days. The second
case's STALLED assertion was probed SEPARATELY, because the interval widening
only reaches its first line: seeding the **Send batch parent** 12 days back
instead of 7 keeps the sweep firing and fails exactly that assertion
(`expected 1036800007 to be less than 950400000`), so amendment B7's
no-stalled-alert obligation is enforced by the test rather than merely stated
in its title.

**Nothing else deviated.** `BATCH_APPROVAL_WINDOW_DAYS = 7` was already the
approval window's single owner in `outreach.ts` — it is the sibling the task
brief predicted next to `BATCH_SEND_WINDOW_HOURS`, so no constant was invented.
The `ci:tenant-scope` findings landed at exactly the 2 the standing sign-off
predicted, and no other audit moved.

## Task 6 — the `unknown` sweep reaches a `sending` row the send-window sweep's own fixture expected it to leave alone

**What:** `latches send_window_elapsed past the 72h send window and cancels the
live Outreach rows` — a Task 4 case that was green — went RED the moment phase 1
existed: `AssertionError: expected 'unknown' to be 'sending'`. Its fixture seeds
a row that has sat `sending` for 68 hours with no in-flight outbox row, which is
precisely predicate P1's subject, and P1 carries no batch predicate. Phase 1 runs
FIRST, so the row is terminalized `unknown` / `send_indeterminate` in the same
tick that phase 2 latches its batch.

**Why the implementation is right and the assertion was stale:** this is D12d's
own stated example, not a collision. The spec says the `unknown` terminal
"resolves a deadlock this spec would otherwise ship: D10 deliberately excludes
`sending` from the halt sweep, so without an escape a wedged `sending` row would
block `closeBatchIfSettled` forever and permanently consume the account's
one-active-batch slot (D8)". The case's own comment already said the row
"resolves itself" — phase 1 IS that resolution, and it was unreachable while the
sweep was a stub. Narrowing P1 with a batch predicate to preserve the old
assertion would have re-opened exactly the wedge #915 exists to close, on the
halted-batch case that needs it most.

**What changed:** one assertion in `release.integration.test.ts`, from
`delivery_status === 'sending'` to `toMatchObject({ delivery_status: 'unknown',
disposition_reason: 'send_indeterminate' })`, with the D12d reasoning written
above it. It still pins what it always pinned — the halt does NOT cancel a
`sending` row — and now also pins the phase-1/phase-2 interaction. Test-only, on
the branch surface (`src/lib/solicitation/__tests__/**`); no production
behaviour was bent to fit it, so ACCEPT rather than RE-PLAN.

## Task 6 — the two vacuous negative cases are re-verified, and the belts are NOT independently pinned by the case that names them

**What:** the entry "Task 3 — three negative cases were unmasked while they still
pass VACUOUSLY" left Task 6 owing evidence for two of them. Both are now
discharged, and the probe contradicted the brief's expectation for one of them.

- `does not terminalize a sending row whose outbox row is re-pended after
  selection` — RED with the `NOT EXISTS` **repeated inside the CAS** deleted
  (`expected 1 to be +0`), and the ONLY case in the file that reddens; green the
  moment that belt is restored. It is that belt's sole pin, by construction: the
  re-pend lands after the unlocked selection, so P1's outer belt never sees it.
- `does not terminalize a sending row while an in-flight outbox row still
  exists` — **still green with P1's outer `NOT EXISTS` deleted.** Its outbox row
  is seeded before the cycle, so the CAS belt refuses the row anyway. It is also
  still green with the CAS belt deleted alone. It goes RED (`expected 1 to be
  +0`) only when BOTH belts are deleted. So this case pins the PAIR, not the
  outer belt; the task brief's "test 4 pins P1's outer `NOT EXISTS`" is not what
  the code does.

**Why it matters rather than being a curiosity:** the outer belt is a
liveness/bounding arm, not a correctness arm — the CAS belt is what makes the
sweep safe. Nothing in the suite would catch the outer belt being dropped, and a
future reader should know that before deleting it as redundant.

**What changed:** both `TASK 6 MUST RE-VERIFY THIS` comments rewritten to record
the result instead of asking for it, including the "pins the pair" finding. No
production change.

## Task 6 — a `sending` row with no running Lazy child is a branch, not an assertion

**What:** `findRunningLazyChild` returns `null` rather than throwing when no
`running` `solicitation_ask` run exists for the terminalized row's ask, which
departs from the house rule "assert impossible states, don't branch around them"
(and from `startLazyChild`, which throws on a missing **Send batch parent**).

**Why:** the precedent that fits is `recordDeferStepOnParent`, which is
best-effort for the same shape of reason. This sweep is the only loop on the
platform that can unwedge a location; a throw propagates out of `sql.begin`, out
of `runReleaseCycle`, and aborts the tick BEFORE phases 2 and 3 run — so one
anomalous row would hold every other account's wedged batch shut, which is the
#915 failure mode reintroduced by the guard meant to catch it. The Outreach
terminalization is the act that matters; the child transition is the spine's
half of it, and it is pinned by its own case.

**What changed:** nothing beyond the docstring, which states the departure and
the reason. Recorded so a reviewer reads it as a decision rather than an
oversight.

## Task 6 — standing sign-off applied for P1: 1 entry, baseline 388 → 389

**What:** the `## STANDING SIGN-OFF` table's P1 row reads "expect 1 …; pending".
Recording the outcome here rather than editing that row, because this task's
brief scopes this file to APPEND ONLY.

**Confirmed from the audit output, not assumed:** `pnpm ci:tenant-scope` reported
exactly ONE finding — `src/lib/solicitation/release.ts: solicitation_outreach:
missing account_id or business_id scope` — and no `job_outbox` finding, since it
is not a `TENANT_TABLES` member. One entry added in the `background-global-scan`
category with a hoisted `UNKNOWN_SWEEP_SCAN_SQL` / `UNKNOWN_SWEEP_SCAN_REASON`
pair beside `BATCH_EXPIRED_SWEEP_SCAN_SQL`; `ALLOWLIST_BASELINE` 388 → 389. The
reason names #915 plainly, as the standing sign-off asks. Passes at 389/389.
Nothing else in that file was touched and no other category was widened; the
amendment budget is untouched and remains spent at 3 of 2.

## Task 7 — "every still-open batch the tick saw" is a RE-SCAN, and the plan's triple is migration 091's index predicate

**What:** the plan's phrase admits two readings — re-scan at phase 5, or replay
the ids phases 1–4 touched. Task 7 chose the RE-SCAN, and the choice is forced
rather than preferred: `closes a settled batch the inline path missed` seeds a
batch that is approved, mid-drip and fully terminal (`sent` + `withheld`), which
NO earlier phase can select — P1 finds no `sending` row, P4's `EXISTS` finds no
`rendered` row, P2 and P3 see a batch inside both of its windows. A replay
reading leaves the backstop reachable only for batches something else already
closed inline, which is every batch except the one whose join was lost.

**Why the scan's three arms are the plan's exact triple, and why that is
principled rather than arbitrary:** `approved_at IS NOT NULL AND halted_at IS
NULL AND send_closed_at IS NULL` is migration 091's
`solicitation_batches_one_active_send_per_business` predicate **byte for byte**
(091 line 183). The scanned set is therefore exactly the set of batches
OCCUPYING a location's single active-send slot, so an unclosed batch inside it
is a wedged location — the #915 failure — and one outside it wedges nothing.
The unique partial index also serves the scan. This was verified against the
migration rather than inferred, because the arms read like three arbitrary
lifecycle filters until you notice they are one index.

**One residual, recorded rather than fixed:** a HALTED batch whose last live row
is terminalized by the send worker with the join lost is outside this set and
outside every phase (P1 only sees `sending` rows). It holds no active-send slot,
so it wedges no location — it is a stale-open row, not a wedge — and widening
the predicate would have meant departing from the plan's stated triple on Task
7's own authority. Flagging it for step 6 rather than taking that decision here.

**What changed:** `runBackstopJoin` + `selectOpenSendBatches` in
`release.ts`; `SweepCandidateBatch`'s docstring now says P2, P3 **and P5** share
it (three ids that are exactly `closeBatchIfSettled`'s whole input, so the
backstop needs no projection of its own); the module header's phase-5 line now
says RE-SCANNED and why. No new type, no shared sweep helper.

**Standing sign-off applied for P5: 1 entry, baseline 389 → 390.** The table's
P5 row reads "0 or 1, depending on whether it re-scans"; the re-scan reading
costs exactly ONE finding —
`src/lib/solicitation/release.ts: solicitation_batches: missing account_id or
business_id scope` — because unlike P3 and P4 this statement binds no second
table: the settled predicate is NOT spelled in the scan, since a second spelling
of it would be the second implementation of the join D11 forbids. Hoisted
`BACKSTOP_SCAN_SQL` / `BACKSTOP_SCAN_REASON` beside `UNKNOWN_SWEEP_SCAN_SQL`;
passes at 390/390. Nothing else in that file was touched, no other category was
widened, and the amendment budget remains spent at 3 of 2.

## Task 7 — the two unmask probes, and what each one actually pins

**What:** both markers were deleted and both cases pass. Sensitivity was PROVED
with two probes per case, chosen so that each reddens a different assertion.

- **Narrowing the scan** (`AND b.sending_started_at IS NULL`, which excludes the
  mid-drip settled batch) reds BOTH cases and only those two:
  `closes a settled batch…` on `expected +0 to be 1`, and the flag-scope case on
  `expected 0 to be greater than or equal to 1` — with its three sweep
  assertions still green. That is the BACKSTOP half of the flag-scope case.
- **Declaring a `failure`** (`{ code: 'gate_closed', gate: 'flag_disabled' }`,
  the trap the task brief names) leaves `backstopClosed` correct at 1 and reds
  both cases on `expected 'failed' to be 'completed'` — the Send batch parent's
  terminal status. So the durable receipt is pinned SEPARATELY from the counter,
  and the "a backstop is not a terminalizer" rule is enforced by the tests
  rather than merely commented.
- **Moving the flag read to the top of `runReleaseCycle`** reds EXACTLY ONE case
  — `runs the sweeps and the backstop while SOLICITATION_SEND_ENABLED is off`,
  on `expected +0 to be 1` (`sendWindowElapsed`). `does not release while
  SOLICITATION_SEND_ENABLED is off` stays GREEN, which is precisely the hazard
  locked decision 8 exists for: the obvious flag-off case passes under either
  scope. That case is the sole pin on the flag's scope, and the two halves of
  its title are independently pinned (this probe reds the sweeps assertion, the
  scan probe reds the backstop assertion).

**Step 2 needed no code:** `solicitationSendEnabled` is read at exactly one site
(`release.ts:766`, inside `runReleasePhase`). No second read was added.

**Nothing else deviated.** Zero `it.fails` markers remain in the suite (34/34
pass), and no audit moved except the one tenant-scope entry above.

## Task 8 — a configurable interval can violate the deadline-below-interval contract, so the floor is part of the parse

**What:** Step 2 asked for `SOLICITATION_RELEASE_POLL_INTERVAL_MS` parsed "like
`JUDGE_POLL_INTERVAL_MS`" — accept any positive parsed value. That precedent is
safe for `JudgeSweepPoller` only by accident: nothing there rests on the
interval. Here it does. `CYCLE_TIMEOUT_MS` (45s) is deliberately BELOW
`DEFAULT_INTERVAL_MS` (60s), and `GuardedPollOptions.timeoutMs` states the
relationship as a contract — the deadline must fire before the next tick so a
hung cycle frees the single-flight flag with recovery costing one interval, not
several. Making the interval env-tunable is the only way an operator could break
it: `SOLICITATION_RELEASE_POLL_INTERVAL_MS=30000` would arm ticks that land on an
in-flight cycle. The plan's Step 2 did not mention the interaction, and Task 0's
own deviation ("the poller's interval can never overlap a cycle") records the
property that a bare positive-parse would quietly retire.

**Why not clamp upward instead:** clamping a rejected value up to
`CYCLE_TIMEOUT_MS + 1` is invention — no loop in the repo does it. Falling back
to the default is the precedent's own failure mode for an unusable value
(`JudgeSweepPoller`, `AnalyticsDispatchPoller`), so "below the deadline" simply
joins "non-numeric", "zero" and "negative" in the invalid set.

**What changed:** `getIntervalMs()` accepts a parsed value only when it is
strictly greater than `CYCLE_TIMEOUT_MS`; everything else falls back to
`DEFAULT_INTERVAL_MS`. Two loop-mechanics cases added — one that a valid
override (90s) reaches `setInterval`, one table-driven case that the exact 45s
boundary, 30s, `0`, `-1000`, `'not-a-number'` and `'60s'` all fall back. Both
unmask-probed: relaxing the floor to `parsed > 0` and to `>= CYCLE_TIMEOUT_MS`
each turns exactly one case red. The registry row states the floor.

## Task 8 — `ci:config-coverage` does NOT pin the env-vars registry row

**What:** the task brief named `pnpm ci:config-coverage` as "the one that pins
your env-vars row". It does not. `scripts/ci/config-coverage-audit.ts` compares
`REQUIRED_VAR_DECLARATIONS` against the three lanes' UNCONDITIONALLY-required
var lists (`WORKER_REQUIRED_VARS` et al) and never reads
`.claude/reference/env-vars.md`. A `rawOpt` var is optional by construction, so
it is out of that audit's scope entirely — it passes with or without the row.
No audit in `scripts/ci/` reads `env-vars.md` at all (grepped).

**Why it matters:** the registry row is still mandatory — it is a CLAUDE.md house
rule, not a machine-enforced one. Recording this stops a future session from
inferring "config-coverage was green, so the row must be present."

**What changed:** nothing in the code. The row was written and
`ci:config-coverage` was run and is green; the two facts are simply unrelated.

## Task 8 — the P2 backlog list is numbered continuously across all four priority bands, so the new entry is 17

**What:** `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md`
numbers its items 1–16 straight through P1 (1–4), P2 (5–6), P3 (7–9) and the P4
table (10–16). "Add a P2 entry" therefore has no free slot: item 7 is already
`OutboxPoller` under P3. Renumbering 7–16 would rewrite the P3/P4 headings and
every in-file cross-reference (`P2 #5/#6`, `P1 #2`, `P4 #11`, `P3 #9`) for a
labelling problem.

**What changed:** the entry sits at the end of the **P2** section — the right
section — carrying the next free label, `### 17.`, with a one-line parenthetical
saying why the number jumps so nobody "corrects" it later. Its `Fix` bullet ends
with amendment B3's condition verbatim.

## Task 9 — the `release.ts` row said "four predicates"; Task 7 made it five

**What:** the stub-commit row for `src/lib/solicitation/release.ts` reads *"Owns
the four predicates"*. That was true of the plan's "The four predicates, stated
once" (P1–P4) and stopped being true at Task 7, which added **P5** —
`selectOpenSendBatches`, the backstop's own re-scan, whose three arms are
migration 091's `solicitation_batches_one_active_send_per_business` predicate
byte for byte. This is the only claim in either row that had drifted from the
code rather than merely aged.

**Why it matters:** P5 is the phase the standing sign-off table and the Task 7
tenant-scope entry both count separately (baseline 389 → 390), so a row saying
"four" undercounts the module's global scans against the allowlist that admits
them.

**What changed:** the row now says "the five scan predicates (P1–P5)", and gains
three facts the finished code carries and the stub row could not: the module is
the only producer of `solicitation_send` jobs; it owns the
`unknown`/`send_indeterminate` **Outreach row** terminal; and two traps — the
`unknown` sweep's TWO belts (grace period AND the in-flight `NOT EXISTS`
repeated inside the terminal CAS) and the backstop being a second CALLER of
`closeBatchIfSettled`, never a second implementation. The poller row's "Every
minute by default" became "Every 60s by default, overridable with
`SOLICITATION_RELEASE_POLL_INTERVAL_MS`", with Task 8's floor named as a trap: a
configured interval at or below `CYCLE_TIMEOUT_MS` (45s) is REJECTED and falls
back to the default.

## Task 9 — the `approval.ts` directory row does not mention `latchSystemHalt`, and was left alone

**What:** `src/lib/solicitation/approval.ts` gained 166 lines in Task 3 — the
system arm of the latch — and its `docs/directory.md` row still describes only
*"the five verbs of the send lane a human triggers"*.

**Why it was NOT edited:** the row is incomplete, not wrong. `latchSystemHalt`
is by construction not a verb a human triggers, so every sentence in that row
remains true, and Task 9's brief scopes step 1 to the two #900 rows. The third
arm is now stated in the `CONTEXT.md` **Halt latch** entry, which is the
glossary's authoritative owner of the latch's writer count.

**What changed:** nothing. Recorded so step 6 can decide whether one clause
belongs on that row, rather than rediscovering the gap later.
