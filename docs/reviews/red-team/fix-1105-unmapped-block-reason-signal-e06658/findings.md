# Red team — `fix/1105-unmapped-block-reason-signal` — ROUND 2

| | |
|---|---|
| Mode | `feature` |
| Round | **2** (the hard cap; `round-start` refuses a third) |
| Branch | `fix/1105-unmapped-block-reason-signal` |
| Fork / merge-base | `313a3e01fa73612037eb6674718619e5bf75eb4b` |
| Round-1 reviewed HEAD | `01aa07f3113af2688137f5d4004419ac03cc4264` |
| HEAD under review | `05f94055edd66d852fa064ddbcaf8f80d7e5622c` |
| Intake sha256 | `ccf6e2714576b46828869bc1f1fa31b0a8713fb423986b98d0a68677e7639f4c` |
| Risk | `high` (intake) — any open P1 needs user adjudication |
| Status | **OPEN_P0** |

## Scope

Round 2 reviews ONLY `git diff 01aa07f3..05f94055` and its direct callers. Round
1's negative results stand and were not re-opened: mutual exclusivity of the two
guard-4 signals, the seven plan-review-added cases, and the three "must NOT fire"
lane cases.

## Preconditions

- Worktree clean at a committed SHA.
- `mutation-runner.mjs watchers` — none serving this worktree.
- **`round-start` REFUSED — "round 3 exceeds the hard cap of 2".** The journal
  already carried `round: 2` with 3 runs consumed, all mutations `restored` and
  the dotenv swap closed. That is a valid open round 2 with a clean journal, so
  this pass ran inside it rather than opening a new one. The per-round run budget
  was therefore not reset: 27 of 30 available, 13 used (16/30 total).
- Environment isolated via `env --tmp-home` + `dotenv-swap` (localhost test DB
  validated; value never printed).

## Deviations from the protocol, recorded rather than hidden

1. **Whole-file mutant runs instead of `-t` single-test runs.** Every mutation
   was re-run against the entire covering suite (`write.test.ts`, 29 cases;
   `persist.test.ts`, 59 cases) rather than one regex-selected case. Strictly
   stronger kill criterion, and it removes the `-t`-regex failure mode that
   `assert-one-test` exists to catch; `assert-one-test` was therefore not
   invoked, and the JSON reporter's per-case pass/fail list is the evidence.
2. **Baselines were per-file, not per-case.** `write.test.ts` 29/29 and
   `persist.test.ts` 59/59 green at `05f94055` before any mutation.

## Duty 1 — hand-mutation

13 runs: 2 baselines + 11 mutants. Nine killed, two survived confirmed, one
recorded inconclusive on an unexecuted branch.

### Verification of round 1's P0 (F-01)

`worker/jobs/response-generation/persist.ts:968`,
`noteUnmappedBlockReasons(unmapped)` → `noteUnmappedBlockReasons(autoDecision.blockReasons)`.

Round 1: survived 59/59. **Round 2: KILLED** — `invariants: with the ledger off,
a mixed mapped and unmapped decision signals the vocabulary hole only` fails,
58/59. The argument assertion added at `persist.test.ts:1322-1325` is real.

### The new logic

| Mutant | Target | Result |
|---|---|---|
| `size >= UNMAPPED_SIGNAL_CAP` → `size > …` (`write.ts:571`) | cap boundary | **killed** — the cap case's `expect(message).toBe(OVERFLOW_MESSAGE)` fires. The boundary IS pinned: the code at `size == cap` overflows, the one at `size == cap-1` reports. |
| delete the whole `logger.warn` block in `noteUnmappedOverflow` (`write.ts:630-636`) | overflow durable transport | **SURVIVED 29/29** → R2-03 |
| delete `nextUnmappedAttemptAt = …` from `noteUnmappedOverflow`'s catch (`write.ts:649`) | overflow shared cooldown | **survived 29/29**, but the catch is a branch NO case executes → `inconclusive` / `oracle` → R2-04 |
| `if (fresh.length === 0)` → `if (unmapped.length === 0)` (`write.ts:569`) | the freshness guard | **killed** — 4 cases |
| drop the filter entirely (`write.ts:568`) | the per-code latch | **killed** — 4 cases |
| `for (const code of fresh) add(code)` → add `fresh[0]` only (`write.ts:604`) | partial marking | **killed** — the logger-line case |
| `for (const code of fresh) add(code)` → add only up to the cap's headroom | the claimed bound | **SURVIVED 29/29** → R2-01 |
| `captureMessage(CONST, …)` → `captureMessage(CONST + ': ' + codes, …)` (`write.ts:596`) | grouping | **killed** — 2 cases |
| `endDisabledEpisode()` += `signalledUnmappedCodes.clear()` (`write.ts:423-426`) | plan decision D3 | **killed** — the new enabled-ledger case. D3 now has a real oracle. |
| `fresh.join(', ')` → `[...new Set(fresh)].sort().join(', ')` (`write.ts:582`) | verbatim order, duplicates kept | **killed** — the input-order case, whose assertion moved from `message` to `extra.codes` and still discriminates |

No case carries more than two mutations; attribution is in the sidecar inventory.

## Duty 2 — fragile assertions

Checked and **cleared**, with the reasoning on record:

- `expect(JSON.stringify(options)).not.toContain('one_too_many')`
  (`write.test.ts:1017`) reads as an absence-of-string proxy, the shape this repo
  has been burned by. It is falsifiable here: the only plausible regression
  (threading `fresh` into the overflow event's `extra`) puts `one_too_many` in
  the first over-cap call's options and fails it. Not raised.
- `expect(handed, …).not.toContain(mapped)` (`persist.test.ts:1325`) is redundant
  beside the `toEqual(['ghost_reason'])` one line above, not fragile.
- No exact rendered-string counts, and the one order assertion has a stated
  ordering contract (`write.ts:551-556`).

## Duty 3 — docs vs reality, re-resolved at `05f94055`

`prevalidate-plan.py` on all three changed plan/runbook docs: PASS, PASS, and 2
false positives on the handoff (`01a069d3` / `b2f63e9769e6` are the two halves of
a UUIDv7 review id at line 39, not commit SHAs). Every prose claim below was
re-resolved by hand.

**Verified TRUE at HEAD:**

- `persist.ts:785-793` — the `_PrecedenceIsTotal` correction. `vocabulary.ts:487`
  carries `satisfies Record<AutoApprovalBlockReason, RefusalCategory | null>`
  (the map-hole guard) and `vocabulary.ts:658` is `_PrecedenceIsTotal` (the
  unranked-member guard). The corrected docblock credits the right one.
- `write.test.ts:873-886` — the case-count claim, now unquoted. The describe
  block holds 15 cases; 6 original + 6 plan-review + 3 branch-review = 15, and
  the `Object.hasOwn`-versus-`in` case is where the doc says it is
  (`persist.test.ts:1330`).
- `persist.ts:795-801` and `docs/directory.md:905` — "**five** lanes index a
  category map directly". Confirmed: `batch-builder.ts:674`,
  `auto-policy-downgrade.ts:218`, `dispatch.ts:1481`, `ask-generation.ts:751`,
  `suspension.ts:339`, `approval.ts:635` — six sites across exactly five lanes.
- `arch-review-log.md:1663` — "Promotion to lab notes happens at step 8".
  `.claude/reference/lab-notes.md` is untouched by this branch and holds no
  `#1105` reference. Round 1's F-03 is fixed.

**FALSE at HEAD — see R2-01, R2-02, R2-05.**

## Duty 4 — sibling sweep

Patterns searched, scope `src/` + `worker/`, excluding `__tests__/` and
`*.test.ts`:

1. `Sentry.captureMessage` with a non-constant message — the exact grouping fault
   this round's fix corrects. Seven call sites; five interpolate. Four of those
   interpolate values of **bounded** cardinality (`circuit-breaker.ts:197`,
   `subscription-updated.ts:154`, `OnboardingDemoWorker.ts:148`, `write.ts:479`
   whose only interpolation is a compile-time constant). One interpolates
   **unbounded** cardinality → R2-08.
2. `signalledUnmappedCodes` mutation sites — declaration (359), `.clear()` (411),
   `.has()` (568), `.size` (571), `.add()` (604). Exactly one growth site and no
   trim site. That is the static half of R2-01's proof.
3. Reverse-import sweep for `noteUnmappedBlockReasons` / `UNMAPPED_SIGNAL_CAP` /
   `UNMAPPED_BLOCK_REASON_*` / `noteUnmappedOverflow`: `write.ts`,
   `write.test.ts`, `persist.ts`, `persist.test.ts` and docs only.
   `write.test.ts` is therefore the ONLY suite that can cover
   `noteUnmappedOverflow` — which makes R2-03 and R2-04 whole-surface results.

## Duty 5 — operational completeness

The diff adds two swallowed, operator-actionable emitters. All six facets against
`docs/runbooks/beta-launch-alerting.md`:

| Facet | `fault:unmapped_block_reason` | `fault:unmapped_block_reason_overflow` |
|---|---|---|
| Signal identity | documented (`write.ts:596`) | documented (`write.ts:639`) |
| Filter (tag) | documented | documented |
| Level | documented `error` | **not stated**; it is `error` |
| Grouping title | documented (constant, named) | documented (constant, named) |
| Threshold / cadence (`_When_`) | **absent** → R2-06 | **absent** → R2-06 |
| Destination action | prose only; no §1a-do row → R2-06 | prose only; no §1a-do row → R2-06 |

The durable second transport is documented for the #1009 sibling item (line 82)
and for neither new signal — the same hole R2-03 finds on the test side.

---

## Findings — round 2

### R2-01 — P0 — `src/lib/refusals/write.ts:571` (with `:604`, `:353-354`) — duty 1 + 3

**The `UNMAPPED_SIGNAL_CAP` bound is not enforced, and four changed documents
state that it is.**

`write.ts:571` compares `signalledUnmappedCodes.size` against the cap BEFORE
`write.ts:604` adds **every** element of `fresh`. One call carrying N distinct
new codes therefore grows the Set to N, whatever the cap: with `size === 0`,
`0 >= 8` is false and all N are added. There is exactly one growth site and no
trim site, so the worst-case size is
`UNMAPPED_SIGNAL_CAP - 1 + fresh.length` for an input the module's own signature
types as `readonly string[]` and its docblock describes as "not bounded".

Falsified claims, all added in `01aa07f3..05f94055`:

- `write.ts:353-354` — "The set holds at most `UNMAPPED_SIGNAL_CAP` distinct
  codes and then stops growing".
- `docs/directory.md:905` — "It is BOUNDED at `UNMAPPED_SIGNAL_CAP` distinct
  codes".
- `.claude/reference/arch-review-log.md:1663` — "Now a bounded per-code Set with
  one overflow marker at `UNMAPPED_SIGNAL_CAP`".
- `…-deviations.md:217` — "Now a bounded `Set` with one overflow marker".

**Arbiter reasoning for the survivor.** The mutant applied was the *correct*
bounded form — `for (const code of fresh.slice(0, UNMAPPED_SIGNAL_CAP - signalledUnmappedCodes.size))` —
and it survived 29/29. Not equivalent: under it a code that WAS named in the
capture is not marked signalled, so a later call re-reports it, breaking the
stated "IT REPORTS EACH DISTINCT CODE ONCE" contract; under HEAD the Set grows
past the cap instead. The two differ observably and the suite cannot tell them
apart, because every cap-adjacent case feeds exactly one code per call. Not on an
unexecuted branch: `write.ts:604` runs in most cases in the describe block.

Fix is one line or four sentences — bound the add loop, or delete the bound claim
from all four documents and say what is true.

### R2-02 — P0 — `docs/runbooks/beta-launch-alerting.md:94` — duty 3 + 5

**"a FOURTH `subsystem:refusal_ledger` caller, and the only one above `warning`"
is false, and the same hunk that writes it falsifies it.**

`worker/jobs/response-generation/persist.ts:1048-1052` — `withLedgerAttribution`'s
catch — is `Sentry.captureException(error, { level: 'error', tags: { subsystem: 'refusal_ledger', … } })`
and has been since #1079. And `write.ts:639-642`, added in this diff, is a second
error-level emitter. At HEAD four emitters carry that tag: one `warning`
(`warnLedgerDisabled`, `write.ts:479-484`) and **three** `error`.

Operationally consequential: an operator building the rule this row asks for
would reach for `subsystem:refusal_ledger AND level:error`, which also catches
every Refusal-ledger write exception and the overflow marker.

The "FOURTH caller" half is not independently falsifiable — line 55 establishes a
local convention of counting only `warnLedgerDisabled`'s callers. The "only one
above `warning`" half admits no such reading.

### R2-03 — P0 — `src/lib/refusals/write.ts:630-636` — duty 1

**The overflow marker's durable log transport has no oracle anywhere in the
codebase.**

Deleting the entire `logger.warn` block from `noteUnmappedOverflow` survives
29/29 of `write.test.ts`, which the reverse-import sweep shows is the ONLY suite
that reaches this function.

**Arbiter reasoning.** Executed: the cap case's `['one_too_many']` call enters
`noteUnmappedOverflow` and runs this block. Not equivalent: it removes a
transport. The module's own doctrine makes it load-bearing — `write.ts:601-603`
and `docs/directory.md:905` both state that the latch is set when
`captureMessage` RETURNS (queued, not delivered) and that "the log line above is
what makes that acceptable". `noteUnmappedOverflow` latches
`unmappedOverflowSignalled` on the same queued-return terms at `write.ts:644`. If
the capture is queued and never delivered and the log line is gone, "more than
eight codes escaped the union in this process" exists nowhere for the life of the
process, with no retry.

Fix is one assertion in the cap case: assert the cap log line's presence, its
`flag` and its `cap`.

### R2-04 — P1 — `src/lib/refusals/write.ts:645-650` — duty 1 (uncovered change)

**`noteUnmappedOverflow`'s catch — the "shares the SAME cooldown, deliberately"
claim — is on a branch no case executes.**

Deleting `nextUnmappedAttemptAt = Date.now() + WARN_RETRY_COOLDOWN_MS` survives
29/29. Recorded `inconclusive` / `oracle` rather than as a confirmed survivor,
because the arbiter rule reclassifies a survivor on an unexecuted branch: no case
makes `Sentry.captureMessage` throw while the cap is already reached.

Without it, a throwing Sentry in the overflow path buys no window, so every
subsequent unmapped decision retries the capture — the retry storm the comment
says the shared cooldown prevents. The sibling normal-path cooldown is pinned by
four consecutive failures plus a recovery (`write.test.ts:1024-1068`); the
overflow arm has nothing.

This is what forces the run's `INCOMPLETE_ORACLE` component.

### R2-05 — P1 — `docs/runbooks/beta-launch-alerting.md:126` — duty 3

**"a new code is always reported" is false past the cap, and contradicts the same
bullet four lines above it.**

Lines 118-121 of the same item document the cap. `write.ts:571-574` sends any
call to `noteUnmappedOverflow` once `size >= cap`, and `write.ts:627` makes that
a one-shot. `write.test.ts:1019-1021` asserts exactly this at HEAD: two further
new codes past the cap produce NO additional Sentry event.

An operator who reads line 126 literally will treat the absence of an event as
evidence that no new code has escaped. Past the cap that inference is wrong.

### R2-06 — P1 — `docs/runbooks/beta-launch-alerting.md:92` — duty 5

**Two newly emitted signals, no rule row and no `_When_` on either.**

§1a-do (line 243) is "The Sentry click-path — **every unconfigured rule, in one
sitting**", a six-row table of `# | Rule name | _If_ filter | _When_ trigger |
Level`, closed by "_Then_ action for **all six**" (line 358). Neither
`fault:unmapped_block_reason` nor `fault:unmapped_block_reason_overflow` gets a
row, so an operator who works §1a-do end to end builds six rules, none of which
catches either new signal. No cadence is stated anywhere — and for a
constant-message `error` these two are precisely the case where "issue is first
seen" versus a frequency is a real decision (the runbook argues this itself at
lines 361-365 for rules 4-6).

The runbook also has the place where an un-ruled §1 signal is deliberately
recorded — line 353, "**Two §1 signals have no rule in either project** and are
named here so the absence is not rediscovered". #1105 makes that count wrong and
adds neither of its signals to it.

Precedent noted, not as an excuse: the #1009 sibling item has the same missing
row, and it is the one line 353 records.

### R2-07 — P2 — `docs/runbooks/beta-launch-alerting.md:105-107` — duty 3

"The event carries the offending codes in `extra.codes`, in the gate's own
evaluation order" is true of the codes the event reports, but since
`write.ts:568` filters against the latch first, those are only the
not-yet-signalled subset of that decision's offending codes. The Latching
paragraph at 123-127 covers the mechanism; the operator-action paragraph reads as
if the event were a complete list. One clause would close it.

### R2-08 — P2 — `worker/jobs/response-generation/generate-draft.ts:77` — duty 4

Sibling sweep result, recorded rather than acted on. The interpolated-message
grouping fault this round corrects has one live sibling with unbounded
cardinality: the cost-cap capture message interpolates `businessId`, opening one
Sentry issue group per business, and §1a-do rule 2 (`cost_event:limit_exceeded`)
fires on "issue is first seen", so fragmentation multiplies pages rather than
suppressing them. Unchanged code on this branch and out of scope for a fix here;
a zero-sibling claim would have been false, so it is on the record.

---

## Round 1 findings — dispositions at `05f94055`

| id | severity | disposition | evidence at HEAD |
|---|---|---|---|
| F-01 | P0 | **fixed** | The round-1 mutant now kills. `persist.test.ts:1322-1325` asserts the argument. |
| F-02 | P1 | **fixed** | `beta-launch-alerting.md:78-90` corrects the "raises nothing" sentence and adds the new item. The replacement introduces R2-02 / R2-05 / R2-06, which are new findings, not a failure to fix this one. |
| F-03 | P1 | **fixed** | `arch-review-log.md:1663` now says promotion happens at step 8; `lab-notes.md` is untouched by the branch. |
| F-04 | P1 | **fixed** | `persist.test.ts:1259-1264` now says "receiving the FILTERED subset. The CALL SITE owns the membership test". |
| F-05 | P1 | **fixed** | `write.test.ts:873-886` drops the count; 6 + 6 + 3 = the 15 cases present. |
| F-06 | P1 | **fixed** | `persist.ts:785-793` credits `satisfies` (`vocabulary.ts:487`) and distinguishes `_PrecedenceIsTotal` (`vocabulary.ts:658`). Both verified. |
| F-07 | P2 | **fixed** | Recorded at `persist.ts:795-801` and `docs/directory.md:905`; the "five lanes" figure verified against six call sites across five lanes. |
| F-08 | P2 | **open** | Untouched by round 2 and out of its scope. Carried forward. |
| F-09 | P2 | **fixed** | The handoff's "State at handoff" is current, records "One P0, fixed", and states the gate must be re-run. |
| F-10 | P2 | **fixed** | The deviations doc now carries the post-rebase re-derivation, pinned to `01aa07f3` by name. |

## Authorizations

None recorded.

## Restoration

`finalize` run before this file existed. `git status --porcelain` empty on every
tracked path; journal closed with every mutation `restored`; no dotenv backup
present; HEAD unmoved at `05f94055edd66d852fa064ddbcaf8f80d7e5622c`. Runs used:
16 of 30 for the round (3 consumed before this pass).

## Verdict

**OPEN_P0** — three P0s (R2-01, R2-02, R2-03) plus one `inconclusive`/`oracle`
row (R2-04). This is the last round; all four go to the owner.
