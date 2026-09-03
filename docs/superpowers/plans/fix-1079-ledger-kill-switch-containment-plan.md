# Plan — #1079 · REFUSAL_LEDGER_ENABLED must contain a ledger throw

Branch: `fix/1079-ledger-kill-switch-containment`
Intake: `.feature/intake.json` (size=small, risk=high, surface=backend, db_touching=true)
Revision 3 — after plan-skeptic rounds 1 (9 findings) and 2 (12 findings). All ACCEPT.

> **CITATIONS IN THIS DOCUMENT ARE BY SYMBOL, NOT BY LINE.** Revision 3 carried
> ~17 `path:line` citations. This branch inserted ~36 lines into `write.ts` and
> ~90 into `persist.ts`, so by the time red team round 2 resolved them every
> sampled one was wrong, and two (`persist.ts:743` and `:745`, cited as the guard
> list) had drifted into the REPLACEMENT docblock — `:745` landing on
> *"individually changes no outcome and kills no test"*, the exact sentence this
> branch retired. A line range is what rotted, twice, on this branch and its
> sibling. Every citation below now names a function, constant, interface, or
> named section; re-anchor by symbol rather than "fixing" a number.

> **ANNOTATIONS ADDED AFTER THE FACT ARE MARKED IN PLACE.** This document is a
> superseded planning artifact, and this branch exists because a retained claim
> in a superseded document was believed. Claims the branch went on to measure as
> false are left standing (so the reasoning that produced the design is legible)
> with a **`SUPERSEDED IN REVIEW`** note attached at the claim, not filed at the
> bottom. Four such notes exist: the guard-cannot-know premise, the PURE contract
> word, the two-read window, and the T2 "do NOT warn" bullet.

## The defect, restated

`recordPolicyGateRefusal` (in `worker/jobs/response-generation/persist.ts`)
calls `resolvePolicyGateRefusal` three lines before anything reads
`REFUSAL_LEDGER_ENABLED`. The flag is read inside `writeRefusalEvent`
(`src/lib/refusals/write.ts`). So a resolver throw:

1. aborts the persist transaction with the flag OFF, and
2. escapes `withLedgerAttribution`, so it reports as a generic persist failure.

## Chosen shape (owner-approved): containment by NON-EXECUTION

With the flag off, no vocabulary code runs inside the transaction. `write.ts`
stays the only WRITE-PATH reader of the flag and exports one **pure** predicate.
The resolver moves inside the attribution wrapper.

### The predicate is PURE — this is the round-1 correction

> **SUPERSEDED IN REVIEW — the word, not the property.** "PURE" is wrong as the
> contract word and was retired repo-wide for **SIDE-EFFECT-FREE** before this
> branch shipped: `vocabulary.ts` defines PURE for this same feature area as "no
> DB handle, no clock, no flag read", and `isRefusalLedgerEnabled`'s whole body
> is a flag read that MUST be non-deterministic across calls. The contract is
> real and load-bearing; only the noun is wrong. Read every "pure predicate" in
> this section — including the heading and the T1 title — as "side-effect-free
> predicate". The shipped docblock on `isRefusalLedgerEnabled` says so.

Round 1 showed that folding `warnLedgerDisabled()` and `endDisabledEpisode()`
into the extracted predicate breaks the module's own rule (`writeRefusalEvents`'
contract, bullet 1 — cited by symbol; the line range this plan first carried
went stale inside its own commit):
a decision whose block reasons include a `null`-mapped veto member records
nothing either way, so warning on it puts noise on the one signal that says the
ledger is dark. The persist guard cannot know whether a row would have been
written without running the resolver — which is the thing it exists to avoid.

> **SUPERSEDED IN REVIEW — this premise is FALSE, and the branch disproved it.**
> The sentence immediately above ("the persist guard cannot know…") is the
> premise the whole "accepted cost" section below rests on, and the async review
> axis refuted it: map membership is decidable with `Object.hasOwn`, which cannot
> throw, so a guard CAN decide whether a row would have been written without
> running the resolver it exists to avoid. The shipped code is
> `wouldRecordRefusal` in `persist.ts`, and the warning is preserved through
> `noteRefusalLedgerDark`. The predicate is `every`, NEVER `some` — one
> `null`-mapped member vetoes the whole row (#1003), and `some` over-warns on a
> MIXED set (one mapped non-null member plus one `null`-mapped one; red team's
> shrunk counterexample is `["policy_not_enabled","current_rating_missing"]`).
> Note that `some` is NOT wrong on a veto-ONLY set — it is false there too — so
> it is the `!== null` test inside the callback, not the length check, that saves
> that case. The T2 bullet carries the same note; this one is here because THIS
> is the normative section, and the T2 note is ~80 lines away.

So:

- `isRefusalLedgerEnabled(): boolean` — reads the flag live, per call. **No
  transports, no latch mutation, no logging.** Its docblock says so, and names
  `src/app/api/dashboard/refusals/route.ts` — the route's own
  `readFlagEnabledByDefault('REFUSAL_LEDGER_ENABLED')` call — as the sanctioned
  second reader that must keep its own literal spelling for `ci:env-registry`.
- `warnLedgerDisabled()` and `endDisabledEpisode()` stay **private** and stay
  exactly where they are, inside `writeRefusalEvent` and `writeRefusalEvents`.

### The accepted cost, stated rather than hidden

> **SUPERSEDED IN REVIEW — the cost was NOT accepted as shipped.** This section
> describes the shape the plan chose before the guard-cannot-know premise was
> refuted. What shipped keeps the warning on this lane, via `wouldRecordRefusal`
> + `noteRefusalLedgerDark`; only an UNMAPPED reason stays silent, which is
> correct because it would have thrown rather than written. The mitigation
> inventory below is still accurate and is still the reason the residual silence
> is tolerable.

With the flag off, the `policy_gate_held` lane returns before the resolver and
therefore no longer emits the once-per-episode "ledger is dark" line, which it
does today. The signal is not lost globally: the `held_draft` lane and the six other
production write sites still emit it, and the latch is module-level. Those six
are FOUR solicitation sites — the `writeRefusalEvents` calls in
`src/lib/solicitation/dispatch.ts` (indexing
`OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES`), `ask-generation.ts`
(`OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES`), `batch-builder.ts`
(`ASK_WITHHELD_REFUSAL_CATEGORIES`) and `approval.ts`
(`BATCH_HALTED_REFUSAL_CATEGORIES`) — plus
`src/lib/auto-approval/suspension.ts` (`AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES`)
and `worker/jobs/publisher/auto-policy-downgrade.ts`
(`AUTO_POST_REVOKED_REFUSAL_CATEGORIES`) — and those last two are
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

(Read "pure" as **side-effect-free** — see the superseded note above.)

- Seam: `src/lib/refusals/write.ts`.
- Export `isRefusalLedgerEnabled()`: exactly
  `readFlagEnabledByDefault(REFUSAL_LEDGER_FLAG)`, live and per call, nothing else.
- `writeRefusalEvent` and `writeRefusalEvents` each become
  `if (!isRefusalLedgerEnabled()) { warnLedgerDisabled(); return; }`
  followed by `endDisabledEpisode()`. Behaviour is byte-for-byte what it is
  today; only the flag read moves behind one name.
- ORDER IS LOAD-BEARING and UNCHANGED: `writeRefusalEvents` keeps its
  `inputs.length === 0` early return BEFORE the predicate call.
  The predicate's docblock carries an explicit line saying a caller with a
  possibly-empty batch must return before calling it.
- Never a module-scope const — the live-read rule stated in
  `isRefusalLedgerEnabled`'s own docblock.
- Blocking edge: none. T2 and T3 depend on this.
- Precedent: the function contract and the live-read rule, both in
  `isRefusalLedgerEnabled`'s docblock; `src/lib/llm/circuit-breaker.ts`.
- Tests: "writeRefusalEvent and writeRefusalEvents together emit exactly one
  disabled warning across one disabled episode"; "writeRefusalEvents issues no
  statement and emits no disabled warning for an empty input while the flag is
  off". Both in `src/lib/refusals/__tests__/write.test.ts`, isolated with
  `resetRefusalLedgerWarningForTests` (exported from `write.ts`).

### T2 — the lane guards before it resolves, and attributes the resolve

- Seam: `recordPolicyGateRefusal` in `worker/jobs/response-generation/persist.ts`.
- Insert the flag guard AFTER the `isGenuineAutoCandidate` narrowing and
  BEFORE the `resolvePolicyGateRefusal` call: return when
  `isRefusalLedgerEnabled()` is false. Do NOT warn on that arm; carry a comment
  saying why, citing `writeRefusalEvents`' contract by symbol.

  **SUPERSEDED IN REVIEW.** The async axis proved the premise behind "do NOT
  warn on that arm" false: map membership is decidable with `Object.hasOwn`,
  which cannot throw, so the guard CAN know whether a row would have been
  written. The shipped arm calls `wouldRecordRefusal` (`every`, never `some` —
  one `null`-mapped member vetoes the whole row) and raises the same
  once-per-episode line through `noteRefusalLedgerDark`. The warning is
  preserved; only an UNMAPPED reason stays silent, which is correct because it
  would have thrown rather than written. The precise shape of the `some` error
  is recorded on `wouldRecordRefusal`'s docblock: `some` is false on a veto-ONLY
  set as well, and goes wrong only on a MIXED set.
- Move `resolvePolicyGateRefusal(autoDecision.blockReasons)` INSIDE the
  `withLedgerAttribution('policy_gate_held', responseId, …)` callback. A `null`
  resolve returns from the callback and writes nothing — byte-identical to
  today. A throw is now tagged `subsystem: 'refusal_ledger'`,
  `refusal_lane: 'policy_gate_held'`.
- `withLedgerAttribution`'s BODY is UNCHANGED: capture, rethrow
  unchanged, reporter stays guarded.
- **Renumber the guard docblock, and fix the TWO SENTENCES it breaks.** Round 2
  found that "stays attached to the original four" is satisfiable by renumbering
  the list and leaving the prose stale. Both of these are in
  `recordPolicyGateRefusal`'s docblock and both become false:
    1. the headline *"FOUR GUARDS, AND ONLY THE LAST ONE DECIDES ANYTHING"* —
       after the change two of five decide something;
    2. *"…because guard 4 already covers each case"* — the mutation result's
       cross-reference must become guard 5.
  The recorded mutation-testing result stays attached to the original three-vs-
  the-deciding-guard claim, and the new guard's own entry states what it covers
  that the deciding guard does not.

  > Red team round 1 then falsified that recorded result for two of its three
  > guards, and round 2 found its surviving survivor-count stale. The shipped
  > docblock carries the re-measurement, per guard, with the surface each count
  > was taken against — treat this bullet as the instruction, and the docblock as
  > the answer.

- **`withLedgerAttribution`'s docblock gains the vocabulary case.** Its CODE is
  unchanged. Its docblock justifies itself entirely in
  terms of the write — *"Both write sites are deliberately uncaught: a
  migration-116 CHECK violation is a writer bug"*. After T2 the
  `policy_gate_held` invocation also attributes a VOCABULARY fault, which is
  neither a CHECK violation nor a writer bug, and which the flag now genuinely
  suppresses. Leaving it untouched ships the same class of stale comment this
  branch is fixing ninety lines above it.
- The `held_draft` write site (the second `writeRefusalEvent` call in
  `persistResponseAndNotify`) has no pre-write resolve — verified
  at HEAD, every argument is a literal or the module constant
  `HELD_DRAFT_REFUSAL_CATEGORY`. It gains no guard and no behaviour change.
- Blocking edge: T1.

### T3 — the invariant, proved by a call-count oracle and on the live DB

This is the round-1 P0. Without a call-count oracle, a `try/catch` around the
resolver passes every other title while being the shape this plan rejects.

- Seam: `persistResponseAndNotify`, via
  `worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts`.
  The suite already mocks the vocabulary module (its
  `vi.mock('@/lib/refusals/vocabulary', …)` factory), so the resolver
  becomes a `vi.fn()` and the count is directly observable.
- Red first: with `REFUSAL_LEDGER_ENABLED=false`, assert `resolvePolicyGateRefusal`
  is invoked ZERO times across a full persist, and the draft row commits.
- **THE POSITIVE CONTROL IS MANDATORY, not implied.** A zero-count assertion is
  an assertion of ABSENCE, so every fixture defect makes it pass — wrong tier,
  `originLane !== LIVE_INGEST_NEW`, a null threshold, `held === true`, or
  `approved === true` each make guards 1-3 (the `held`, `approved` and
  `isGenuineAutoCandidate` early returns in `recordPolicyGateRefusal`) return
  before the resolver on HEAD too. The suite's own file-header comment warns
  about exactly this class. So: **the SAME fixture,
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

`.claude/commands/feature.md` (the rule requiring at least one `fast-check`
property per declared invariant for a feature touching approval / auto-approval
logic) is what makes this tracer mandatory.

**Round 2 killed revision 2's version of this tracer.** Two blockers at HEAD:
`recordPolicyGateRefusal` is NOT exported (it is a bare `async function`; the
file exports only `PersistResponseInput`,
`PersistResponseOutcome`, `hasStaleReviewContent` and `persistResponseAndNotify`),
so the property must drive the full persist — and therefore "ZERO queries on the
transaction" is **false by construction**: the lock preamble, the `responses`
INSERT, the `api_costs` updates, `recordModerationAndHold`, the spine checkpoints
and the gate reads all fire first. It failed on a correct implementation.

Worse, with the flag off the guard returns WITHOUT inspecting `blockReasons`, so
a generator over 2^22 subsets produces inputs the implementation cannot branch
on. That is a tautology dressed as a property, with no mutation-killing power.

> **Partly superseded.** The shipped guard 4 DOES inspect `blockReasons`, through
> `wouldRecordRefusal`, so the flag-off arm is no longer input-blind. The
> biconditional below is still the right shape and is what shipped; a second
> property (`invariants: with the ledger off, the warning fires exactly when
> every block reason maps to a real category`) covers the inspecting arm.

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
      IN ORDER — which also pins `resolvePolicyGateRefusal`'s own docblock
      contract in `src/lib/refusals/vocabulary.ts`: "the input VERBATIM,
      in its own order".
  This kills both the `try/catch` swallow and the inline-reimplementation shape
  from T3; the revision-2 form killed neither.
- Do NOT assert a transaction query count. If a query-level assertion is wanted,
  narrow it to "no statement whose text contains `INSERT INTO refusal_events`",
  the idiom the sibling suites already use
  (`batch-builder.integration.test.ts` and `approval.integration.test.ts` both
  filter recorded statement text this way).
- House style: `policy-gate-precedence.property.test.ts`'s `invariants` describe
  block; the `invariants: ` prefix goes INSIDE the `it()` string so the
  `promised-tests` exact match still works.
- Blocking edge: T1, T2, T3.

### T5 — cross-references corrected in the same change

- `refusal-write.integration.test.ts`'s file-header comment claims "Titles 13-36,
  VERBATIM from `.feature/intake.json` `tests_to_add`". That file will hold THIS
  ticket's intake. Anchor the citation to the ticket that owns those titles
  (#1013) rather than to a path whose contents change per run.
- `.claude/CLAUDE.md` § "Working rules" (the bullet on deleting a doc or ticking a
  checklist item) requires cross-references be cleaned in the same change.
- Blocking edge: T3 (edit the file once).

## Invariants this plan must not break

- `write.ts` remains the only module that spells `INSERT INTO refusal_events`
  in production (verified: the statements inside `writeRefusalEvent` and
  `writeRefusalEvents`; every other hit is a test seeding rows).
- `write.ts` is the only WRITE-PATH reader of `REFUSAL_LEDGER_ENABLED`.
  `src/app/api/dashboard/refusals/route.ts`'s own
  `readFlagEnabledByDefault('REFUSAL_LEDGER_ENABLED')` is a deliberate READ-path
  second reader and is out of surface — do not "fix" it, it would break
  `ci:env-registry`.
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

  > **SUPERSEDED IN REVIEW — the window is ZERO, not "microseconds wide", and
  > the flip described cannot happen.** Both the async axis and red team round 2
  > derived it independently: guard 4's read reaches `writeRefusalEvent`'s read
  > via `await withLedgerAttribution(…)` → `return await write();` → the async
  > arrow's body → `await writeRefusalEvent(…)`, and an async call runs its body
  > synchronously up to its OWN first `await`. `isRefusalLedgerEnabled()` is
  > `writeRefusalEvent`'s FIRST statement, so both reads execute in one
  > run-to-completion segment. No suspension point exists between them, so no
  > other task can flip the env in between — there is nothing here to defend
  > against and nothing for a test to exercise. The shipped guard-4 docblock says
  > exactly this.

## Surface change from revision 2

`ledger-containment.property.test.ts` is REMOVED from the edit surface. T4 lives
in `persist.test.ts`, which is already in surface and already owns the harness.

## Verification

`bash .agents/skills/feature/scripts/verified-gate.sh` (db_touching provisions
the test DB serially first).
