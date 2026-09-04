# fix/1105 — an unmapped block reason raises its own operator signal while the ledger is off

Issue: #1105. Intake: `docs/superpowers/plans/fix-1105-unmapped-block-reason-signal-intake.json`.
Fork point: `origin/main` @ `d50e270e`.

## The gap, restated from the code

`recordPolicyGateRefusal` (`worker/jobs/response-generation/persist.ts`) has five
guards. Guard 4 is the `REFUSAL_LEDGER_ENABLED` kill switch, and it contains a
vocabulary fault by NON-EXECUTION — it returns before `resolvePolicyGateRefusal`
can throw `unmapped_auto_approval_block_reason` (#1079).

That containment is correct and stays. Its cost is the subject of this ticket.
With the switch off and an **unmapped** block reason present:

1. `resolvePolicyGateRefusal` never runs, so `withLedgerAttribution` raises no
   Sentry issue.
2. `wouldRecordRefusal` is `every(mapped && non-null)`, and `Object.hasOwn` is
   false for an unmapped member — so `noteRefusalLedgerDark` does not fire.
3. Nothing else observes the lane.

An operator therefore cannot tell "the ledger is off deliberately" from "the
ledger is off AND decisions are being made against a broken map".

**The silence on the ledger-dark line is CORRECT and is not what we change.** An
unmapped member would have THROWN rather than written, so no Refusal row was
lost, and `writeRefusalEvents`' contract forbids claiming a gap for a call that
would not have written a row. This plan adds a SECOND, DISTINCT signal and
leaves the first one exactly as it is.

## What the compiler already covers, and why this is still worth building

Since #1080 (`_PrecedenceIsTotal` in `src/lib/refusals/vocabulary.ts`) the map is
proven total over `AutoApprovalBlockReason` at `pnpm typecheck`. So an unmapped
code needs a value that escaped the compiled union at run time. This signal is
DEFENCE IN DEPTH against that class, not a live fault. The issue says the same
and the intake records it. It is built because the fault class is currently
unsignalled, and the cost is one helper.

## Decisions locked before the tasks

- **D1 — REVERSED DURING T2. The CALL SITE owns the membership test.** A private
  `unmappedBlockReasons` predicate in
  `worker/jobs/response-generation/persist.ts`, beside `wouldRecordRefusal` and
  under the same cannot-throw rule, filters with `Object.hasOwn`;
  `noteUnmappedBlockReasons` takes already-unmapped codes and is a pure
  transport.

  A FAILING TEST REVERSED IT, not an argument. `persist.test.ts` mocks
  `@/lib/refusals/write`, so with the test inside the helper its spy recorded a
  call for a HEALTHY set too — four of the five lane cases asserted a count that
  discriminates nothing. A lane-level contract needs a lane-level oracle. Full
  record, including the rejected call-through alternative, in the deviations
  file entry D5.

  The paragraphs below are the ORIGINAL reasoning, kept because it is what the
  two plan review rounds read and because its import claim is still true and
  still worth knowing. Its conclusion is not.
- **D1 (superseded) — the helper owns the membership test.**
  `noteUnmappedBlockReasons` takes the whole block-reason set and filters it with
  `Object.hasOwn` itself.
  Rejected alternative: the caller filters and the helper takes an
  already-unmapped list (mirroring `noteRefusalLedgerDark`'s
  caller-owns-the-precondition contract). The precedent does not transfer:
  `wouldRecordRefusal` lives at the call site because its `every`-versus-`some`
  nuance is tied to the WRITE contract, and there is no such nuance here.
  `src/lib/refusals/write.ts` already has a named import block from
  `./vocabulary` (cited by symbol, not by line — a range here goes stale inside
  its own commit), so `POLICY_GATE_HELD_REFUSAL_CATEGORIES` costs one more name
  in it and no new coupling.

  THE TYPE COMES FROM SOMEWHERE ELSE, and an earlier draft of this decision got
  that wrong. `AutoApprovalBlockReason` is NOT exported by `./vocabulary` —
  that module imports it privately from `@/lib/shared/worker-types`, and
  `write.ts`'s vocabulary import block holds only `REFUSAL_VOCABULARY_VERSION`
  and three refusal types. Import the type directly from
  `@/lib/shared/worker-types`. Do not add a re-export to `vocabulary.ts` for
  this helper alone. (Plan review round 1, finding 9.)
- **D2 — a SECOND test-only reset, named for its own latch.** Add
  `resetUnmappedBlockReasonSignalForTests` rather than extending
  `resetRefusalLedgerWarningForTests`.

  THE REVERSED VERSION OF THIS DECISION SHIPPED IN ROUND 1 AND WAS FALSE ON A
  FACT THE REPOSITORY CONTRADICTS. It claimed every suite calls the existing
  reset in `beforeEach`. `src/lib/refusals/__tests__/write.test.ts` does;
  `worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts`
  does NOT — it calls the reset once, MID-TEST, to open a fresh disabled
  episode inside a case. An extended reset would make that mid-test episode
  boundary silently clear an unrelated process-lifetime signal. Two latches
  with two lifetimes get two resets. (Plan review round 1, finding 8.)

  THE CORRECTION IS NARROWER THAN THE ONE PROPOSED. Round 1 asked for the new
  reset to be invoked in every suite that exercises the real helper. Only
  `write.test.ts` needs it. The integration suite drives the REAL gate, so
  every block reason it can produce is a member of the compiled
  `AutoApprovalBlockReason` union and therefore mapped — the vocabulary latch
  can never set there, and a reset call would assert nothing. Recorded rather
  than silently dropped.
- **D3 — the new latch does NOT clear on the enabled path.**
  `endDisabledEpisode` clears the ledger-dark latch when the ledger is observed
  on, because "disabled episode" is a property of the switch. A vocabulary hole
  is not an episode of the switch, so its latch persists for the life of the
  process. A worker restart clears it.
- **D4 — the two signals fire from two independent `if`s, never an `else if`.**
  They are mutually exclusive by construction (an unmapped member makes
  `wouldRecordRefusal` false), so an `else` would be defensive handling of a
  state the invariants exclude — the shape `working-rules.md` bans. The
  exclusivity is stated in the docblock and asserted by a test instead.
- **D5 — level `error`, not `warning`.** The ledger being off is a deliberate
  operator act and stays at `warning`. A vocabulary hole behind it is a defect.
  The levels are what separate them in the issue stream.

## Invariants this change must not break

1. Guard 4 contains by NON-EXECUTION. Nothing added below the switch read may
   run the resolver, and nothing added may throw.
2. `Object.hasOwn` is the only membership test, because it cannot throw.
3. The new latch is separate. `noteUnmappedBlockReasons` never reads or writes
   `warnedThisEpisode` or `nextWarnAttemptAt`.
4. `wouldRecordRefusal` keeps its `every`-mapped-and-non-null form. #1003's veto
   rule and red team's mixed-set counterexample
   (`["policy_not_enabled","current_rating_missing"]`) still hold.
5. `src/lib/refusals/write.ts` stays the single owner of every Refusal ledger
   signal transport. `persist.ts` stays a call site.
6. A throwing logger or a throwing Sentry never rejects the helper and never
   changes control flow.

## Tasks

### T1 — eval: the 18 failing tests (FIRST, before any implementation)

Author every `tests_to_add` title from the intake as a failing test. Thirteen in
`src/lib/refusals/__tests__/write.test.ts`, five in
`worker/jobs/response-generation/__tests__/persist.test.ts`. Titles are the
intake's contract and are used VERBATIM — `verify-gate.sh`'s `promised-tests`
row matches on the exact string.

SEVEN OF THE THIRTEEN CAME FROM PLAN REVIEW ROUND 1, and each answers one way
the original eleven could all pass on a wrong implementation. They are marked
`[R1-n]` below with the finding that produced them. Do not drop one as
redundant without re-deriving why it was added.

`src/lib/refusals/__tests__/write.test.ts` — follow the existing latch and
throwing-transport cases in that file:

1. `noteUnmappedBlockReasons captures one error-level Sentry message naming every unmapped code`
   — two unmapped codes in one set, both named in the message, `level: 'error'`,
   tags `subsystem: 'refusal_ledger'` and `fault: 'unmapped_block_reason'`.
2. `noteUnmappedBlockReasons ignores a set whose every member is mapped` — a real
   set drawn from `POLICY_GATE_HELD_REFUSAL_CATEGORIES`; no capture, no log.
3. `noteUnmappedBlockReasons signals once per process and stays silent on the second unmapped set`
   — the latch. Two calls, one capture.
4. `a synchronously throwing Sentry buys a cooldown rather than the latch on noteUnmappedBlockReasons`
   — mirror the existing `WARN_RETRY_COOLDOWN_MS` case: after the throw, an
   immediate second call is silent, and a call past the cooldown captures again.
   Use the same fake-timer or `Date.now` seam the existing case uses.
5. `a throwing logger does not stop noteUnmappedBlockReasons from capturing` —
   the log guard's own catch.
6. `noteUnmappedBlockReasons leaves the ledger-dark episode latch untouched` —
   call the new helper, then drive the ledger-dark path and assert it still
   warns. This is the executable form of invariant 3, in ONE direction only,
   which is why case 7 exists.
7. `a prior ledger-dark warning does not suppress noteUnmappedBlockReasons`
   `[R1-2]` — the REVERSE order. An implementation that READS `warnedThisEpisode`
   without writing it passes case 6 and still goes silent whenever a mapped
   decision warned first. Raise `noteRefusalLedgerDark`, then assert an unmapped
   set still logs and still captures.
8. `noteUnmappedBlockReasons never invokes resolvePolicyGateRefusal` `[R1-1]` —
   invariant 1's only real oracle. Cases 14-17 assert the resolver spy in
   `persist.test.ts`, where the whole `@/lib/refusals/write` module is MOCKED,
   so the real helper is never the thing under test there. Spy the resolver on a
   partial mock of `./vocabulary` (the `importActual` shape `persist.test.ts`
   already uses) and drive the REAL helper.
9. `noteUnmappedBlockReasons emits one structured logger line naming every unmapped code and the flag`
   `[R1-3]` — case 1 checks only the Sentry payload and case 3 only the capture
   count. Without this, a generic log line, or a log on every call bounded only
   on the Sentry side, passes. Assert the codes and `REFUSAL_LEDGER_ENABLED` in
   the metadata.

   IT MUST CALL THE HELPER TWICE, with two DIFFERENT unmapped sets, and assert
   exactly one log line and exactly one capture (round 2, correction 1). A
   single-call version of this case still passes an implementation that logs on
   every call and latches only the Sentry side — the defect the case exists to
   kill. The new log line must NOT contain
   the substring `refusal ledger disabled`, or it inflates the file's existing
   `ledgerWarnings()` counts; give the new signal its own filter helper.
10. `noteUnmappedBlockReasons treats an inherited object key as unmapped`
    `[R1-4]` — a plain unknown string does not tell `Object.hasOwn` apart from
    `in`. The map is an ordinary object, so `"toString"` resolves through the
    prototype and an `in` implementation calls it MAPPED. This is the only case
    that pins invariant 2's choice of test.
11. `noteUnmappedBlockReasons ignores an empty block-reason set` `[R1-5]` — case
    2 uses a real non-empty mapped set, so a helper that signals on `[]` passes
    it. T2 requires the empty return explicitly.
12. `noteUnmappedBlockReasons preserves unmapped codes in input order` `[R1-6]`
    — case 1 requires both codes present, not ordered. Sorting or de-duplicating
    would pass it while breaking the stated guarantee. `vocabulary.ts` treats
    input order as evidence for whoever debugs the gate; this signal follows it.

    THE FIXTURE MUST CARRY A REPEAT, not two distinct codes (round 2, correction
    2). An order-sensitive assertion over two distinct codes kills SORTING and
    leaves DE-DUPLICATION alive, and the case names both defects. Use
    `['zeta', 'alpha', 'zeta']` and assert that exact sequence in the emitted
    message.
13. `simultaneously throwing logger and Sentry transports do not escape noteUnmappedBlockReasons`
    `[R1-7]` — cases 4 and 5 throw one transport each. A combined-failure path
    could still throw, abort the response persist, and pass every other case.
    That is invariant 1 and invariant 6 together, and it is the failure the kill
    switch exists to prevent.

`worker/jobs/response-generation/__tests__/persist.test.ts` — the guard 4 cases
live in `describe('invariants')`, NOT in a guard-4 describe block; an earlier
draft of this plan named one that does not exist (round 1, finding 10). That
block already mocks `@/lib/refusals/write` and spies `noteRefusalLedgerDark`.
Add a `noteUnmappedBlockReasonsSpy` alongside it:

14. `with the ledger off, an unmapped block reason signals the vocabulary hole and raises no ledger-dark warning`
15. `with the ledger off, a fully mapped held decision warns ledger-dark and signals no vocabulary hole`
16. `with the ledger off, a veto-only decision raises neither signal`
17. `with the ledger off, a mixed mapped and unmapped decision signals the vocabulary hole only`
18. `with the ledger on, an unmapped block reason invokes no vocabulary-hole signal`

Cases 14-17 also re-assert `resolvePolicyGateRefusalSpy` stays at zero, which is
the containment pin guard 4 exists for. Case 18 is the ON arm, where the resolver
is expected to run and throw; assert the throw propagates unchanged, because that
is #1079's contract and not something this branch may soften.

Turning an unmapped code into the fixture needs a value outside the compiled
union. Use the narrowest cast the file's existing style allows and say why in a
comment — the fixture is modelling a value that escaped the type system, which
is the entire fault class.

**Blocking edges**: none. Runs first.

### T2 — the signal and its call site

One vertical slice. It turns all 18 tests green.

`src/lib/refusals/write.ts`:

- Add a module-level latch pair for the new signal, beside `warnedThisEpisode`
  and `nextWarnAttemptAt`, with its own docblock stating D3 (it does not clear
  on the enabled path, and why).
- Add `noteUnmappedBlockReasons(codes: readonly AutoApprovalBlockReason[]): void`.
  It filters with `Object.hasOwn(POLICY_GATE_HELD_REFUSAL_CATEGORIES, code)`,
  returns on an empty result, and otherwise emits the same two transports in the
  same order and with the same two `try`/`catch` blocks as `warnLedgerDisabled`:
  a `logger` line first (the durable transport this process controls), then
  `Sentry.captureMessage` at `level: 'error'` with tags
  `{ subsystem: 'refusal_ledger', fault: 'unmapped_block_reason' }`. A returned
  capture sets the latch; a synchronously thrown capture sets the cooldown.
- Its docblock states: why it is distinct from `noteRefusalLedgerDark`, that it
  cannot throw, and that the parameter is typed as `AutoApprovalBlockReason[]`
  while the run-time filter exists precisely for a value that escaped that type.
- Add `resetUnmappedBlockReasonSignalForTests` per D2. Do NOT extend
  `resetRefusalLedgerWarningForTests`.
- Imports: add `POLICY_GATE_HELD_REFUSAL_CATEGORIES` to the existing
  `./vocabulary` block. Add `type AutoApprovalBlockReason` from
  `@/lib/shared/worker-types`, which is where it is exported — `vocabulary.ts`
  imports it from there and does not re-export it.

`worker/jobs/response-generation/persist.ts` — guard 4's off-arm becomes two
independent statements per D4:

```ts
if (!isRefusalLedgerEnabled()) {
  noteUnmappedBlockReasons(autoDecision.blockReasons);
  if (wouldRecordRefusal(autoDecision.blockReasons)) noteRefusalLedgerDark();
  return;
}
```

Add `noteUnmappedBlockReasons` to the existing `@/lib/refusals/write` import.

**Blocking edges**: T1.

### T3 — the docblock truth pass

The prose in this area is load-bearing and is cited by other files. Three places
claim things that T2 makes incomplete:

- `recordPolicyGateRefusal`'s guard 4 bullet in `persist.ts` says the arm "STILL
  WARNS, BUT ONLY WHEN A ROW WOULD GENUINELY HAVE BEEN WRITTEN". That stays true
  of the ledger-dark warning and must now name the second signal and state D4's
  exclusivity.
- `withLedgerAttribution`'s docblock in `persist.ts` records that "a fault
  arriving into an already-off flag never runs the resolver and raises nothing".
  That sentence is what #1105 falsifies. Correct it in place rather than leave it
  to mislead the next reader.
- `noteRefusalLedgerDark`'s docblock in `write.ts` must name its new sibling so a
  reader choosing between them lands on the right one.

Also confirm `docs/directory.md` needs no change: T2 adds no file under
`worker/` or `src/lib/`, so `ci:directory-map` has no new row to demand. Confirm
by running `pnpm ci:directory-map`, do not assume.

**Blocking edges**: T2.

## Verification

`bash scripts/verify-gate.sh` at each boundary, `--review` before the review wave.
Intake `verification_commands` adds:
`pnpm vitest run src/lib/refusals/__tests__/write.test.ts worker/jobs/response-generation/__tests__/persist.test.ts`.

No migration. No flag flip. `db_touching` is false, so the gate runs no live-DB
provisioning for this branch — but `refusal-write.integration.test.ts` covers this
same lane and must stay green, so the full `pnpm test` row is the real evidence,
not the targeted vitest run.

## Rollback

Revert the branch. The change adds one observability signal, no schema and no new
control-flow branch.

It DOES add module-level state — the new latch pair — and saying "no state" would
be false (round 1's closing note). That state is process-local, in-memory, holds
no tenant data, and a worker restart clears it. Nothing persists across a revert,
so the rollback is still clean.

## Plan review appendix

### Round 1 — codex plan skeptic, `VERDICT: REVISE`

Session id `01a069d3-87db-7aa0-bcb8-b2f63e9769e6`. A verification round resumes
it rather than starting cold.

Eleven findings, all ACCEPTED. Findings 1-7 each named a way the original eleven
tests could pass on a wrong implementation; they became eval cases 7-13, tagged
`[R1-n]` in T1.

| # | Finding | Disposition |
|---|---|---|
| 1 | Resolver assertions sit in a suite that mocks the helper's module | ACCEPT → case 8 |
| 2 | Case 6 tests one latch direction only | ACCEPT → case 7 |
| 3 | No assertion on the logger line's content or count | ACCEPT → case 9 |
| 4 | Unknown strings do not tell `Object.hasOwn` from `in` | ACCEPT → case 10 |
| 5 | No direct empty-set case | ACCEPT → case 11 |
| 6 | Code order unasserted | ACCEPT → case 12 |
| 7 | Transports throw only one at a time | ACCEPT → case 13 |
| 8 | D2's "every suite resets in `beforeEach`" is false | ACCEPT, correction NARROWED — D2 reversed to a separate reset; the proposed extra reset call in the integration suite is dropped, because that suite drives the real gate and can never produce an unmapped code. Reason recorded in D2. |
| 9 | `AutoApprovalBlockReason` is not exported by `vocabulary.ts` | ACCEPT → D1 corrected, verified at `src/lib/shared/worker-types.ts` |
| 10 | The cited guard-4 `describe` block does not exist | ACCEPT → T1 names `describe('invariants')` |
| 11 | Rollback says "no state" while T2 adds module-level state | ACCEPT → rollback corrected |

Findings 8 and 9 were re-verified against the working tree before acceptance,
not taken on the reviewer's word.

### Round 2 — codex verification, resumed, `VERDICT: REVISE`

Same session, resumed rather than started cold. It confirmed F1, F2, F4, F5 and
F7-F11 addressed, and confirmed F8's narrowing sound on its own reasoning: the
integration suite cannot set the new latch, so a separate reset avoids
cross-lane lifecycle coupling without losing coverage.

Three corrections, all ACCEPTED and applied:

| # | Correction | Applied |
|---|---|---|
| 1 | Case 9 needs TWO calls with different unmapped sets, or it passes an implementation that logs every call and latches only Sentry | T1 case 9 |
| 2 | Case 12 needs a repeated code in the fixture, or it kills sorting but not de-duplication | T1 case 12, fixture `['zeta', 'alpha', 'zeta']` |
| 3 | Case 8 still cited "Cases 12-16" after the renumbering | T1 case 8, now "Cases 14-17" |

No new fronts were opened against unchanged sections, and no appendix was
returned. All three corrections refine existing cases, so `tests_to_add` is
unchanged at 18 titles and no intake edit was needed.

Round 3 was not dispatched, and the mechanical check could NOT settle that on
its own. `contract-changed` compares against a snapshot taken at ROUND 1's
start, so it reports CHANGED for the 11-to-18 title growth that round 2 was
dispatched to review — and this appendix's own heading moves the heading
structure a second time. Reading that CHANGED as "round 3 is owed" would be
reading the tool's answer to a question nobody asked.

The substance settles it instead. Round 2 reviewed the 18-title version. The
only edits since it launched are the three corrections above, which alter case
BODIES, plus this appendix. `allowed_edit_surface` and `tests_to_add` are
byte-identical to what round 2 read. There is nothing for a round 3 to verify.

The contract snapshot was re-recorded after this appendix landed, so the branch
review rounds in step 7 start from a clean baseline rather than inheriting this
one.
