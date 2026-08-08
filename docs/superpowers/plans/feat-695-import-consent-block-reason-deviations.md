# Deviations — `feat-695-import-consent-block-reason`

Entries the plan did not anticipate. Each gets an ACCEPT / RE-PLAN verdict at
step 6 before review agents see this file.

## Step-6 triage (completed 2026-08-08, gate GREEN at `1b527b08`)

| # | Entry | Verdict |
|---|---|---|
| D1 | `allowed_edit_surface` amendment 1 of 2 (failover poller integration suite) | **ACCEPT** |
| D2 | `tests_to_add` retitle — executor-identity claim was unfalsifiable | **ACCEPT** |
| D3 | three `tests_to_add` additions from round-1 eval holes | **ACCEPT** |
| D4 | estimates deliberately NOT raised | **ACCEPT** |
| D5 | three T1 assertions added — the planned eval could not fail | **ACCEPT** |
| D6 | a sixth reference site the plan did not enumerate | **ACCEPT** |
| D7 | CONTEXT.md cites the ADR by filename, not number alone | **ACCEPT** |

No RE-PLAN verdicts: no entry invalidates a locked intake decision. Surface
amendments stand at **1 of 2** (D1 only) — D5, D6 and D7 all landed inside the
already-declared surface, and D2/D3 are `tests_to_add` changes, which step 5
classifies as deviations rather than amendments. The abort criteria are not met.

**The two entries most worth a reviewer's attention are D5 and D6**, because both
are cases where a green signal was misleading: D5's eval passed while the feature
was still unbuilt, and D6's three per-suite green runs each missed a file none of
them ran. Neither was found by reading the plan.

---

## D1 — `allowed_edit_surface` amendment 1 of 2 (owner-approved 2026-08-08)

**What.** Added `worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts`
to `allowed_edit_surface`.

**Why.** Round-1 codex plan review (session `019fe2ec-c789-7032-9b55-3b923267404f`)
found that this file imports the deleted `markOutboxOwnerUnreachable` at line 55 and
calls it at 365/373. `tsconfig.json` includes `**/*.ts`, so T2's claimed
`pnpm typecheck` PASS was impossible as planned. Verified independently against the
file before accepting.

**Owner decision.** Amend AND retarget the file's live assertion, not compile-fix
only — its `Step 6b` test asserts the value *Postgres actually persisted*, which is
the only pin that can catch the generalization writing a wrong column value. Mock
assertions cannot.

**Budget.** This is amendment **1 of 2**. A second one triggers the step-5 abort
criteria.

**VERDICT: ACCEPT.** The amendment bought the only assertion on this branch that can
catch the generalization writing a wrong column value, and it earned its keep — the
gate ran that suite 9 passed / 0 skipped against live Postgres, so the persisted
`owner_unreachable` wire value is pinned by execution, not by compilation.

---

## D2 — `tests_to_add` retitle (not an amendment)

`'guardImportConsent writes the block reason on the transaction handle, never the
outer sql client'` → `'guardImportConsent writes the block reason inside its own
consent transaction'`.

**Why.** The original title overclaimed. `worker/__tests__/helpers/mock-sql.ts:99-103`
invokes the `sql.begin` callback with the *same* mock object, so `exec === mockSql`
holds under both a correct and a broken implementation — an executor-identity
assertion cannot fail for the property it names. Codex proposed changing `mock-sql.ts`
to pass distinct sentinels; rejected, because that helper is shared by many suites
(and is outside the surface) and the property is already pinned against real Postgres
by the integration suite's forced-race test. The honest fix is the title, so the test
claims only the `inTransaction` evidence it actually has.

**VERDICT: ACCEPT.** Renaming the claim to match the evidence is right; the
alternative (editing a mock helper shared by many suites, outside the surface, to
manufacture falsifiability) would have been a worse trade. The property itself is
not unpinned — the live-DB forced-race test covers it.

## D3 — three `tests_to_add` additions (not amendments)

From round-1 eval holes, all verified as genuine gaps:

1. `OUTBOX_COMPLETION_REASON preserves the persisted owner_unreachable wire value` —
   the vocabulary was self-referential: writer, readers, and fixtures all resolve the
   same constant, so changing its string would strand every historical row with every
   test still green.
2. `markOutboxCompletedWithReason preserves owner_unreachable against live Postgres
   and rejects a superseded attempt` — the retargeted `Step 6b` from D1's file.
3. `guardImportConsent persists completion_reason=import_consent_blocked on the outbox
   row for a live pending import` — declined, derived-expired and accepted were pinned
   against live Postgres; `pending` (the migration-100 default population the gate
   exists for) was not.

**VERDICT: ACCEPT.** All three are genuine gaps, all three now execute against live
Postgres, and #1 in particular guards a failure mode nothing else could see — a
vocabulary whose every reader resolves the same constant cannot otherwise detect a
renamed value stranding historical rows.

## D5 — three T1 assertions added: the plan's `guardImportConsent` reason tests could not fail (not an amendment)

**What.** Added one line — `expect(mockMarkOutboxCompletedWithReason).toHaveBeenCalledTimes(1)`
— to three of Task 1 Step 3's four new titles (#7 `completes a refused backfill
row …`, #8 `stamps import_consent_blocked for a businesses row that does not
exist`, #9 `writes the block reason inside its own consent transaction`). Every
line the plan specified is kept verbatim; nothing was removed or reworded, and no
title changed. Confined to `worker/jobs/zernio/__tests__/job-eligibility.test.ts`,
inside the allowed edit surface.

**Why.** As written, all four passed GREEN at the eval commit, which is the one
thing a failing eval may not do. Two independent causes, both invisible from the
plan text:

1. `completionCalls` is shared by BOTH recorders (Step 3 sub-step 1 deliberately
   keeps `mockMarkOutboxCompleted` for `guardZernioJobEligibility`). So
   `expect(completionCalls).toHaveLength(1)` and `completionCalls[0]!.inTransaction`
   are satisfied by the guard's CURRENT plain-completion call — they say nothing
   about which writer ran.
2. `OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED` is `undefined` until T2, and
   the plain recorder pushes no `reason`, so
   `expect(completionCalls[0]!.reason).toBe(OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED)`
   compares `undefined` to `undefined` and passes.

The added line names the reason WRITER, which is what the three titles actually
claim, and it is the same assertion Step 3 sub-step 3 already retargets onto all
five pre-existing block cases — so this is the file's own convention, not a new
one. All three now fail at T1 (`called 0 times`) for the right reason and turn
green at T3.

**Left green deliberately:** title #10 (`stamps no completion_reason when consent
is accepted`) is a negative pin — `completionCalls` empty, reason writer never
called — which holds before AND after the change by design. It is a regression
guard, not an eval, and forcing it red would mean asserting something false.

**VERDICT: ACCEPT.** This is the most valuable entry on the branch. An eval that
passes while the feature is unbuilt is worse than no eval, because it converts a
missing implementation into a green signal — and three rounds of plan review did not
catch it. The fix asserts the reason *writer*, which is what the titles claim, using
the file's own existing convention rather than a new one. Declining to force title
#10 red is also correct: a negative pin that holds before and after is a regression
guard by design, and making it red would have meant asserting something false.

---

## D6 — a SIXTH reference site the plan did not enumerate (not an amendment)

**What.** `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts` — added
`mockMarkOutboxCompletedWithReason` to the `vi.hoisted` block and to the
`src/lib/shared/outbox` `vi.mock` factory, and retargeted **six** consent-refusal
assertions onto the reason writer. In surface (`worker/jobs/zernio/__tests__/**`),
so no amendment is consumed; the budget stays at 1 of 2.

**Why.** Task 1 enumerated **five** test files. This is the sixth, and the whole-repo
`pnpm test` gate row is what found it — the branch went RED with
`No "markOutboxCompletedWithReason" export is defined on the … mock`. Nothing in the
targeted per-suite runs T1/T2/T3 each performed could have caught it: every one of
them ran only the five planned files.

**Why it is the round-1 blocker's exact class, recurring.** Round 1 caught that
`markOutboxOwnerUnreachable` had a second reference in the failover poller's
integration suite (D1). The lesson recorded there was "count the references." It got
applied to the *deleted symbol* and not to the *changed call site*: `guardImportConsent`
swapping writers breaks any suite that mocks the outbox module and asserts on the old
writer, which is a different search than "who imports the deleted symbol." A grep for
`markOutboxOwnerUnreachable` finds D1's file; only a grep for
`vi.mock(.*shared/outbox` finds this one.

**Not a production defect.** Purely a mocking artifact — an incomplete mock factory
plus assertions naming the superseded writer. Production behavior was already pinned
by the 14 promised tests including five against live Postgres, and is unchanged. The
fix additionally asserts `mockMarkOutboxCompleted` was NOT called on the
missing-business path, which pins that a refusal does not double-complete (the reason
writer owns the row alone) — matching `job-eligibility.test.ts`'s length-1
`completionCalls` pins.

**29 plain-writer assertions in that file were deliberately left alone** — the
`accepted` paths and all three `guardZernioJobEligibility` skips legitimately keep
`completion_reason` NULL, which is an explicit intake non-goal. Retargeting one of
those would have masked a regression.

**VERDICT: ACCEPT.** In-surface, no production change, and the gate is the control
that caught it — which is the system working as designed rather than a process
failure. The durable lesson for step 8 promotion: when a call site swaps writers,
grep for suites that MOCK the module, not just for importers of the removed symbol.
Those are different searches and only the second one was run at round 1.

---

## D8 — "durably queryable" was an overclaim; corrected to the 7-day archival window (intake-field correction, owner-decided 2026-08-08)

**What.** The word *durable* is removed from the ticket's claim in five places and
replaced with an explicit operational-window statement: `docs/adr/0016-*.md` (three
sites, incl. a new third bullet under "Operator query, and its limits"), `CONTEXT.md`
**Import consent**, spec §5.3, and **both** intake copies (`goal` +
`observability[0]`). An intake-field correction, not an `allowed_edit_surface`
amendment — the budget stays at 1 of 2.

**Why.** The step-7 adversarial axis found that `ArchivalPoller.ts:60` deletes
completed `job_outbox` rows 7 days after `completed_at`. A refusal is completed
(skip-as-success), never failed, so it takes the **7-day** arm rather than the 90-day
dead-letter one. Independently verified against the poller. The implementation was
right; the language promised a permanence the sink does not provide.

**The correction to the reviewer's framing, which decided the remedy.** Codex read
this as "do not ship". It is not a defect this branch introduced: `owner_unreachable`
(ADR 0010) — the precedent this generalizes — writes to the same column on the same
table and has always had the identical 7-day life. The whole `OUTBOX_COMPLETION_REASON`
vocabulary is an operational-window signal. So the fix is the claim, not the code.

**Owner decision (2026-08-08).** Correct the language; do not expand scope. The two
alternatives were both re-plans, not patches: a longer-lived audit/analytics sink
contradicts the locked non-goal *"no HealthAlertPoller check, no Sentry capture, no
PostHog event — a refusal is the guard working, not an incident"*, and exempting
reasoned rows from archival would couple the shared archival arm to one domain — the
exact coupling ADR 0016 rejects when it declines a topic-specific trigger on
topic-agnostic infrastructure.

**What now carries the durable claim instead:** `businesses.import_decision` /
`import_decision_at` (the consent record that answers "did we import without
consent?"), plus the structured log line under the log sink's own retention. The ADR
now states the query is trustworthy in exactly one band — created after deploy AND
completed within 7 days — and says so where an operator will read it.

---

## D7 — CONTEXT.md cites the ADR by filename, not by number alone (not an amendment)

**What.** The plan's drafted `CONTEXT.md` text ended `(ADR 0016)` by number. T4
appended the path — `(ADR 0016, `docs/adr/0016-import-consent-enforcement-locus.md`)`.

**Why.** The plan's own Step 5 greps `CONTEXT.md` for the ADR *filename*; the drafted
text would have failed that check. Reported by T4 rather than written by it, because
T2 owned this file during the parallel T2 ∥ T4 window.

**VERDICT: ACCEPT.** It makes the plan's own verification step pass and satisfies the
repo rule that a cross-reference be greppable by filename. Cosmetic in blast radius,
correct in intent.

---

## D4 — estimates deliberately NOT raised

D3 adds ~60 test lines beyond the locked `estimated_test_lines` of ±225. The estimate
is left unchanged: raising it to match would defeat the step-5 `reclassify` detector,
which exists to measure the lock against reality. Expected actual is ~285, still under
the 2× trigger.

**VERDICT: ACCEPT — and the decision is now vindicated by measurement.** The gate's
`reclassify` row emits only on WARN and stayed silent. Measured against the fork
point: production bucket **243** lines (estimate 180, 2× trigger 360), test bucket
**391** (estimate 225, 2× trigger 450). Both under trigger, so the lane holds and no
re-classification is required. Had the estimate been inflated to match reality as the
work grew, this row would have measured nothing.

---

## Round-1 review findings REJECTED (with reasoning)

- **"`subagent-driven-development` skill is unavailable."** Rejected — it is provided
  by the Claude Code harness, not the repo or `~/.claude/skills`, which is where codex
  looked. The plan header stands.
- **"Add `markOutboxCompletedWithReason updates only the requested outbox row` and
  `… does not overwrite a non-dispatched terminal row`."** Rejected as new tests —
  row scoping and the `status = 'dispatched'` conjunct belong to the shared
  `dispatchedRow` fragment, which already has direct coverage in `outbox.test.ts`'s
  `'outbox writers — dispatchedRow attempt-guard composition'` block. Per-caller
  duplicates of a shared-fragment invariant are the abstraction-tax the fragment
  exists to avoid. **Partially absorbed**: the property test's
  `status = 'dispatched'` assertion was moved OUT of its `typeof attempt === 'number'`
  branch (it was genuinely unasserted on the legacy path), and the outbox id is now
  asserted in the bind values.
- **"Add `markOutboxCompletedWithReason sets completed_at`" and "`markOutboxCompleted`
  leaves completion_reason NULL"** — accepted as *assertions* folded into existing
  tests rather than new promised titles; neither warrants its own `it`.
