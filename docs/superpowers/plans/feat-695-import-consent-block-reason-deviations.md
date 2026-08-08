# Deviations — `feat-695-import-consent-block-reason`

Entries the plan did not anticipate. Each gets an ACCEPT / RE-PLAN verdict at
step 6 before review agents see this file.

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

---

## D4 — estimates deliberately NOT raised

D3 adds ~60 test lines beyond the locked `estimated_test_lines` of ±225. The estimate
is left unchanged: raising it to match would defeat the step-5 `reclassify` detector,
which exists to measure the lock against reality. Expected actual is ~285, still under
the 2× trigger.

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
