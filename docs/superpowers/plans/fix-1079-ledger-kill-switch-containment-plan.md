# Plan — #1079 · REFUSAL_LEDGER_ENABLED must contain a ledger throw

Branch: `fix/1079-ledger-kill-switch-containment`
Intake: `.feature/intake.json` (size=small, risk=high, surface=backend, db_touching=true)
Revision 3 — after plan-skeptic rounds 1 (9 findings) and 2 (12 findings). All ACCEPT.

## The defect, restated

`recordPolicyGateRefusal` (`worker/jobs/response-generation/persist.ts:747`)
calls `resolvePolicyGateRefusal` three lines before anything reads
`REFUSAL_LEDGER_ENABLED`. The flag is read inside `writeRefusalEvent`
(`src/lib/refusals/write.ts:369`). So a resolver throw:

1. aborts the persist transaction with the flag OFF, and
2. escapes `withLedgerAttribution`, so it reports as a generic persist failure.

## Chosen shape (owner-approved): containment by NON-EXECUTION

With the flag off, no vocabulary code runs inside the transaction. `write.ts`
stays the only WRITE-PATH reader of the flag and exports one **pure** predicate.
The resolver moves inside the attribution wrapper.

### The predicate is PURE — this is the round-1 correction

Round 1 showed that folding `warnLedgerDisabled()` and `endDisabledEpisode()`
into the extracted predicate breaks the module's own rule (`write.ts:488-492`):
a decision whose block reasons include a `null`-mapped veto member records
nothing either way, so warning on it puts noise on the one signal that says the
ledger is dark. The persist guard cannot know whether a row would have been
written without running the resolver — which is the thing it exists to avoid.

So:

- `isRefusalLedgerEnabled(): boolean` — reads the flag live, per call. **No
  transports, no latch mutation, no logging.** Its docblock says so, and names
  `src/app/api/dashboard/refusals/route.ts:76` as the sanctioned second reader
  that must keep its own literal spelling for `ci:env-registry`.
- `warnLedgerDisabled()` and `endDisabledEpisode()` stay **private** and stay
  exactly where they are, inside `writeRefusalEvent` and `writeRefusalEvents`.

### The accepted cost, stated rather than hidden

With the flag off, the `policy_gate_held` lane returns before the resolver and
therefore no longer emits the once-per-episode "ledger is dark" line, which it
does today. The signal is not lost globally: the `held_draft` lane and the six other
production write sites still emit it, and the latch is module-level. Those six
are FOUR solicitation sites (`dispatch.ts:1474`, `ask-generation.ts:698`,
`batch-builder.ts:670`, `approval.ts:637`) plus
`src/lib/auto-approval/suspension.ts:331` and
`worker/jobs/publisher/auto-policy-downgrade.ts:208` — and those last two are
the ones most likely to be live in a worker process that is also running
`ResponseGeneratorWorker`, which is what makes the mitigation real. A period
in which ONLY this lane is active goes silent. This is inherent to containment
by non-execution and is recorded in the intake's `observability`.

The vocabulary fault stays observable ONLY under a stated condition, and round 2
broke the broader claim. The Sentry issue this branch adds
(`subsystem=refusal_ledger`, `refusal_lane=policy_gate_held`) is the record of
the fault **for a flag flipped in response to it**. Two orderings defeat that:

  * **Pre-existing flag-off.** If `REFUSAL_LEDGER_ENABLED=false` is already set
    — an unrelated ledger incident, or a staging soak left over — the resolver
    never runs and NO issue is ever raised. There is no standing issue, because
    the fault never executed.
  * **Issue resolution.** An issue whose remediation was "flip the flag" is
    exactly the one an operator resolves once the aborts stop. The record leaves
    the working set while the flag stays off and the hole stays open.

Both are recorded in the intake's `observability` rather than argued away. The
window matters: #1080, which can open that hole, runs in a sibling worktree in
this same wave.

## Tracer bullets

### T1 — `write.ts` exports a pure ledger-enabled predicate

- Seam: `src/lib/refusals/write.ts`.
- Export `isRefusalLedgerEnabled()`: exactly
  `readFlagEnabledByDefault(REFUSAL_LEDGER_FLAG)`, live and per call, nothing else.
- `writeRefusalEvent` (`write.ts:369`) and `writeRefusalEvents` (`write.ts:512`)
  each become `if (!isRefusalLedgerEnabled()) { warnLedgerDisabled(); return; }`
  followed by `endDisabledEpisode()`. Behaviour is byte-for-byte what it is
  today; only the flag read moves behind one name.
- ORDER IS LOAD-BEARING and UNCHANGED: `writeRefusalEvents` keeps its
  `inputs.length === 0` return at `write.ts:508`, BEFORE the predicate call.
  The predicate's docblock carries an explicit line saying a caller with a
  possibly-empty batch must return before calling it.
- Never a module-scope const — the live-read rule at `write.ts:364-368`.
- Blocking edge: none. T2 and T3 depend on this.
- Precedent: the function contract at `write.ts:353-359`; the live-read rule at
  `write.ts:364-368`; `src/lib/llm/circuit-breaker.ts`.
- Tests: "writeRefusalEvent and writeRefusalEvents together emit exactly one
  disabled warning across one disabled episode"; "writeRefusalEvents issues no
  statement and emits no disabled warning for an empty input while the flag is
  off". Both in `src/lib/refusals/__tests__/write.test.ts`, isolated with
  `resetRefusalLedgerWarningForTests` (`write.ts:237`).

### T2 — the lane guards before it resolves, and attributes the resolve

- Seam: `recordPolicyGateRefusal` in `worker/jobs/response-generation/persist.ts`.
- Insert the flag guard AFTER `isGenuineAutoCandidate` (`persist.ts:745`) and
  BEFORE `resolvePolicyGateRefusal` (`persist.ts:747`): return when
  `isRefusalLedgerEnabled()` is false. Do NOT warn on that arm; carry a comment
  saying why, citing `write.ts:488-492`.
- Move `resolvePolicyGateRefusal(autoDecision.blockReasons)` INSIDE the
  `withLedgerAttribution('policy_gate_held', responseId, …)` callback. A `null`
  resolve returns from the callback and writes nothing — byte-identical to
  today. A throw is now tagged `subsystem: 'refusal_ledger'`,
  `refusal_lane: 'policy_gate_held'`.
- `withLedgerAttribution` (`persist.ts:788-807`) is UNCHANGED: capture, rethrow
  unchanged, reporter stays guarded.
- **Renumber the guard docblock, and fix the TWO SENTENCES it breaks.** Round 2
  found that "stays attached to the original four" is satisfiable by renumbering
  the list and leaving the prose stale. Both of these are at `persist.ts:697-702`
  and both become false:
    1. the headline *"FOUR GUARDS, AND ONLY THE LAST ONE DECIDES ANYTHING"* —
       after the change two of five decide something;
    2. *"…because guard 4 already covers each case"* — the mutation result's
       cross-reference must become guard 5.
  The recorded mutation-testing result stays attached to the original three-vs-
  the-deciding-guard claim, and the new guard's own entry states what it covers
  that the deciding guard does not.

- **`withLedgerAttribution`'s docblock gains the vocabulary case.** Its CODE is
  unchanged. Its docblock (`persist.ts:769-786`) justifies itself entirely in
  terms of the write — *"Both write sites are deliberately uncaught: a
  migration-116 CHECK violation is a writer bug"*. After T2 the
  `policy_gate_held` invocation also attributes a VOCABULARY fault, which is
  neither a CHECK violation nor a writer bug, and which the flag now genuinely
  suppresses. Leaving it untouched ships the same class of stale comment this
  branch is fixing ninety lines above it.
- The `held_draft` site at `persist.ts:877` has no pre-write resolve — verified
  at HEAD, every argument is a literal or the module constant
  `HELD_DRAFT_REFUSAL_CATEGORY`. It gains no guard and no behaviour change.
- Blocking edge: T1.

### T3 — the invariant, proved by a call-count oracle and on the live DB

This is the round-1 P0. Without a call-count oracle, a `try/catch` around the
resolver passes every other title while being the shape this plan rejects.

- Seam: `persistResponseAndNotify`, via
  `worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts`.
  The suite already mocks the vocabulary module (`:105-127`), so the resolver
  becomes a `vi.fn()` and the count is directly observable.
- Red first: with `REFUSAL_LEDGER_ENABLED=false`, assert `resolvePolicyGateRefusal`
  is invoked ZERO times across a full persist, and the draft row commits.
- **THE POSITIVE CONTROL IS MANDATORY, not implied.** A zero-count assertion is
  an assertion of ABSENCE, so every fixture defect makes it pass — wrong tier,
  `originLane !== LIVE_INGEST_NEW`, a null threshold, `held === true`, or
  `approved === true` each make guards 1-3 (`persist.ts:743-745`) return before
  the resolver on HEAD too. The suite's own header warns about exactly this
  class at `refusal-write.integration.test.ts:31-35`. So: **the SAME fixture,
  with the flag ON, must record EXACTLY ONE resolver invocation.** Without it
  the red-first claim is unverifiable and the test is a permanent false green.
- Bind title 1 to the POLICY lane fixture that writes a row with the flag on.
  The `held_draft` half is a pin, not an oracle — that lane invokes no resolver
  on HEAD or under any implementation, so it cannot falsify anything.
- **Titles 2 and 3 are load-bearing controls, and this is why.** An
  implementation that inlines `POLICY_GATE_HELD_REFUSAL_CATEGORIES` and
  `AUTO_APPROVAL_BLOCK_PRECEDENCE` into `persist.ts` and never calls the
  vocabulary module passes title 1 and T4 perfectly — zero resolver invocations
  with the flag on AND off. Only titles 2 and 3, which poison the mocked
  resolver and require its throw to surface, kill it. A later "these are
  redundant, we already assert the abort" cleanup silently reopens the hole.
- With the flag ON, a poisoned resolver still aborts and leaves no response row,
  and the rejection carries the injected error's message — so the fix cannot be
  over-applied into a swallow.
- `captureException` is called EXACTLY ONCE and the rethrown value is the SAME
  error instance, so a wrapper that re-wraps the error fails.
- The `held_draft` lane still writes its row and still aborts on a writer fault
  with the flag on.
- Blocking edge: T1, T2.

### T4 — the property test the router requires, as a BICONDITIONAL

`.claude/commands/feature.md:409` requires at least one `fast-check` property
per declared invariant for a feature touching approval / auto-approval logic.

**Round 2 killed revision 2's version of this tracer.** Two blockers at HEAD:
`recordPolicyGateRefusal` is NOT exported (`persist.ts:729` is a bare
`async function`; the file exports only `PersistResponseInput`,
`PersistResponseOutcome`, `hasStaleReviewContent` and `persistResponseAndNotify`),
so the property must drive the full persist — and therefore "ZERO queries on the
transaction" is **false by construction**: the lock preamble, the `responses`
INSERT, the `api_costs` updates, `recordModerationAndHold`, the spine checkpoints
and the gate reads all fire first. It failed on a correct implementation.

Worse, with the flag off the guard returns WITHOUT inspecting `blockReasons`, so
a generator over 2^22 subsets produces inputs the implementation cannot branch
on. That is a tautology dressed as a property, with no mutation-killing power.

- Seam: `persistResponseAndNotify`, in
  `worker/jobs/response-generation/__tests__/persist.test.ts` — which ALREADY
  imports `fast-check` and already owns the `vi.hoisted` `mockSql`/`mockTx`/
  `txQueue` stub-transaction harness. Do NOT create a second property file; a
  duplicated harness would make a second owner of the persist fixture.
- `./auto-approval` must be mocked so the generated `blockReasons` array reaches
  the gate verbatim — it is COMPUTED from the stub's rows on HEAD, and many
  members are mutually exclusive, so an unmocked generator cannot reach the guard.
- **The property is a biconditional over the flag**, which is what makes it
  depend on the generated input:
    * flag OFF ⇒ `resolvePolicyGateRefusal` receives ZERO calls;
    * flag ON  ⇒ EXACTLY ONE call, receiving the generated array VERBATIM and
      IN ORDER — which also pins `vocabulary.ts:668-672`'s "the input VERBATIM,
      in its own order".
  This kills both the `try/catch` swallow and the inline-reimplementation shape
  from T3; the revision-2 form killed neither.
- Do NOT assert a transaction query count. If a query-level assertion is wanted,
  narrow it to "no statement whose text contains `INSERT INTO refusal_events`",
  the idiom the sibling suites already use
  (`batch-builder.integration.test.ts:2423`, `approval.integration.test.ts:3109`).
- House style: `policy-gate-precedence.property.test.ts`'s `invariants` describe
  block; the `invariants: ` prefix goes INSIDE the `it()` string so the
  `promised-tests` exact match still works.
- Blocking edge: T1, T2, T3.

### T5 — cross-references corrected in the same change

- `refusal-write.integration.test.ts:4` claims "Titles 13-36, VERBATIM from
  `.feature/intake.json` `tests_to_add`". That file will hold THIS ticket's
  intake. Anchor the citation to the ticket that owns those titles (#1013)
  rather than to a path whose contents change per run.
- `.claude/CLAUDE.md:88` requires cross-references be cleaned in the same change.
- Blocking edge: T3 (edit the file once).

## Invariants this plan must not break

- `write.ts` remains the only module that spells `INSERT INTO refusal_events`
  in production (verified: `write.ts:395` and `write.ts:543`; every other hit is
  a test seeding rows).
- `write.ts` is the only WRITE-PATH reader of `REFUSAL_LEDGER_ENABLED`.
  `src/app/api/dashboard/refusals/route.ts:76` is a deliberate READ-path second
  reader and is out of surface — do not "fix" it, it would break `ci:env-registry`.
- With the flag ON, both persist write sites stay uncaught — a migration-116
  CHECK violation is a writer bug and must abort the transaction.
- `resolvePolicyGateRefusal` keeps both throws and its three-step order; this
  branch does not open `vocabulary.ts` (that is #1080, sibling worktree).

## Known second-order effects, deliberately out of scope

- The other six write sites still surface a ledger failure as a generic abort.
  That is #1083, a later wave.
- Two live flag reads now exist per write (persist guard, then `write.ts`).
  A mid-process flip to `false` between them lets the resolver run with the flag
  off. The window is synchronous and microseconds wide; it is the price of the
  pure predicate and is recorded as an edge case rather than defended against.

## Surface change from revision 2

`ledger-containment.property.test.ts` is REMOVED from the edit surface. T4 lives
in `persist.test.ts`, which is already in surface and already owns the harness.

## Verification

`bash .agents/skills/feature/scripts/verified-gate.sh` (db_touching provisions
the test DB serially first).
