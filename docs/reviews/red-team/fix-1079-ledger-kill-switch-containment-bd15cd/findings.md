# Red team — `fix/1079-ledger-kill-switch-containment` — **round 2 of 2**

> **THIS IS THE ROUND-2 REPORT AND IT REPLACES THE ROUND-1 ONE.** Round 2 is the
> CAP: `round: 2` of a maximum 2, so no round 3 exists and nothing below is
> deferred to one. Round 1's report (status `OPEN_P0`, head `659810f2`) described
> a tree that no longer exists — its P0 was fixed at `b430c30a`, and leaving it
> here made this file contradict the `findings.json` sidecar beside it. The
> round-1 content is preserved in git history at this path; this file is
> reconstructed from that validated sidecar, which is the machine-read record the
> `reviewed` transition parses.

| | |
|---|---|
| Mode | feature (dispatched inside `/feature` step 7's review wave) |
| Round | **2 of 2 — the cap** |
| Risk | high (from `.feature/intake.json`, sha256 `beeb0c90…d529d732`) |
| Fork / merge-base | `f797d25064c31997dfe400414baf99967b63315f` |
| Head | `7269bdad3fdcbf436572698f66685c1db0641757` |
| Run id | `feature-fix-1079-ledger-kill-switch-containment-bd15cd` |
| Generated | 2026-09-03T10:05:00Z |
| **Status** | **`OPEN_P1`** |

## Verdict in one paragraph

**The code is right, and round 2 re-proved it under mutation rather than
inheriting round 1's word for it.** Every claim the fix commits make about
runtime behaviour held: the new warning arm does not weaken containment, the
`every`-not-`some` rule is genuinely test-enforced on both the unit property and
live Postgres, and the two guard numbers round 1 corrected were independently
re-derived here — including their exact recorded call and failure text. Seven of
eleven inventory rows are killed, one is a **proven-equivalent** mutant with the
proof attached, three are excluded for stated reasons, and nothing is
inconclusive or skipped for budget. **No P0.** All five findings are
documentation accuracy: the corrections this branch made propagated to every
authoritative surface — the production docblocks, `.claude/reference/arch-review-log.md`,
`docs/runbooks/beta-launch-alerting.md`, `docs/reviews/fix-1079-…/review.md` —
and stopped short of three artifacts the branch itself created or edited. One of
those, the new async finding-checklist, is **prescriptive** — its header says
async reviewers receive it and check the diff against every line — and it is the
one artifact still carrying the refuted `some` predicate.

## Severity table

| ID | Sev | Duty | Where | Finding |
|---|---|---|---|---|
| RT2-1 | P1 | 3 | `docs/superpowers/plans/…-plan.md` § "Chosen shape (owner-approved)" | The plan keeps three claims the branch disproved, unannotated: the guard-cannot-know premise, the "microseconds wide" window (measured ZERO), and `PURE` as the contract word. |
| RT2-2 | P1 | 3 | `docs/reviews/finding-checklists/async.md`, entry 2 | The new, PRESCRIPTIVE checklist ships the refuted `some` predicate as forward-facing guidance to future async reviewers, with no correction. |
| RT2-3 | P1 | 2 | `worker/jobs/response-generation/__tests__/persist.test.ts`, the new property's expectation comment | Claims guard 4's length check "is covered by the approved-draft cases above". The behaviour is covered; the named mechanism is not, and cannot be. |
| RT2-4 | P2 | 3 | `recordPolicyGateRefusal`'s docblock, guard-2 row | Publishes `82/82` under "re-ran against the CURRENT tests" and "do not re-derive this". At HEAD the surface is 85 cases and guard 2 survives 85/85. |
| RT2-5 | P2 | 3 | `docs/superpowers/plans/…-plan.md` | Sixteen more line-number citations; every sampled one is wrong at HEAD, and two now land on text that contradicts them. |

Counts: 5 findings — 0 P0, 3 P1, 2 P2. 0 accepted-risk, 0 rejected, 0 authorizations.

---

## RT2-2 (P1) — the one artifact a future reviewer is handed still says `some`

`docs/reviews/finding-checklists/async.md` is **created by this branch**, and its
own header says *"Reviewers on this axis receive this file and check the diff
against every line"*. It is a prescriptive input to future reviews, not a closed
historical log. Its second entry states:

> `blockReasons.some(c => Object.hasOwn(MAP, c) && MAP[c] !== null)` is total,
> non-throwing, and returns false for **exactly** the empty and all-null-mapped
> sets `write.ts:525-529` protects.

The clause after "exactly" is **false**, and it is machine-refuted twice:

| Refutation | Evidence |
|---|---|
| Unit property (`persist.test.ts`) | Mutant M-EVERY-SOME (`.every(` → `.some(`) FAILED with counterexample `[["policy_not_enabled","current_rating_missing"]]` after 1 test, shrunk twice. |
| Live DB (`refusal-write.integration.test.ts`, half B) | The same mutant FAILED on the copilot/2-star fixture: *"a decision that records nothing either way reports no gap: expected [ [ …(2) ] ] to have a length of +0 but got 1"*. |

**And the reason matters as much as the verdict.** The branch's own docblocks
state it slightly wrong too. Precisely:

- `some` does **NOT** over-warn on a veto-**ONLY** set — it is false there as
  well, because the only member maps to `null`.
- It over-warns on a **MIXED** set: one mapped non-null member plus one
  `null`-mapped member. `["policy_not_enabled","current_rating_missing"]` is the
  shrunk counterexample.
- Therefore the **`!== null` test inside the callback** is what saves the
  veto-only case — **not** the length check.

Every other artifact on this branch says `every`, never `some`. The checklist's
own header restricts edits ("edit only to prune entries that no longer apply"),
so the remedy is a scope call for the root: prune the entry, correct it in place,
or accept the risk on the record.

## RT2-1 (P1) — three disproved claims left standing in the plan

The fix commit already edited this document — it converted a stale line-range
citation to a symbol citation and appended a `SUPERSEDED IN REVIEW` note under
the T2 bullet — so **annotating in place is this file's own established
convention**. Three claims were left unannotated and are false at HEAD:

1. **The guard-cannot-know premise**, inside the normative "Chosen shape
   (owner-approved)" section: *"The persist guard cannot know whether a row would
   have been written without running the resolver — which is the thing it exists
   to avoid."* This is exactly the premise `wouldRecordRefusal` disproves, and
   every other artifact says so. The existing `SUPERSEDED IN REVIEW` note sits
   ~76 lines below it and does not reach it.
2. **The two-read window**, in "Known second-order effects": *"The window is
   synchronous and microseconds wide."* Re-derived here: guard 4's read reaches
   `writeRefusalEvent`'s read via `await withLedgerAttribution(…)` →
   `return await write();` → the async arrow's body → `await writeRefusalEvent(…)`,
   and an async call runs its body synchronously up to its own first `await`.
   `isRefusalLedgerEnabled()` is `writeRefusalEvent`'s FIRST statement, so both
   reads land in one run-to-completion segment. **No suspension point exists.
   The window is ZERO**, which is what the shipped guard-4 docblock and the
   arch-review-log now say.
3. **`PURE` as the contract word**, three times (the section heading, the shape
   paragraph, the T1 title). The branch retired it repo-wide for
   **SIDE-EFFECT-FREE** precisely because `vocabulary.ts` defines PURE in this
   feature area as excluding a flag read.

**Filed P1 rather than P0 deliberately:** every AUTHORITATIVE surface carries the
corrected version and the plan is a superseded planning artifact. It is also the
document a later reader opens first — and this branch exists *because a retained
claim in a superseded document was believed*. Escalate to P0 if the root judges
the plan normative.

## RT2-3 (P1) — a comment attributing an outcome to the wrong mechanism

The new property's expectation comment reads:

> `minLength: 1` keeps the empty set out of the generator; the "empty warns
> nothing" half is guard 4's length check and is covered by the approved-draft
> cases above.

The **behaviour** is covered — an approved draft warns nothing. The **named
mechanism** is not, and cannot be: an approved decision returns at guard 2
(`if (autoDecision.approved) return;`) and never reaches guard 4, so no
approved-draft case executes `blockReasons.length > 0` at all.

Measured, not reasoned: **M-DROP-LENGTH survives 99/99** across the three touched
suites (RT2-INV-08).

The honest wording is that **guard 2 makes the length check defence in depth
against a future guard reorder, and nothing tests it.** P1 rather than P0 because
the expression is provably unreachable-as-false at its only call site, so
believing the comment has no correctness consequence today. It is filed because
it is the exact defect class the branch is about: a comment attributing an
outcome to the wrong mechanism, sitting beside three carefully corrected
mechanism attributions.

## RT2-4 (P2) — a docblock that forbids re-derivation, carrying round 1's number

`recordPolicyGateRefusal`'s docblock says *"RE-MEASURED AT #1079, ONE AT A TIME
… re-ran that experiment against the CURRENT tests"*, then *"GUARD 2 — deletion
SURVIVES, 82/82"*, and closes with *"Do not re-derive this; the numbers are the
measurement."*

Re-derived anyway: at HEAD the two suites that cover this function
(`persist.test.ts` + `refusal-write.integration.test.ts`) hold **85 cases**, all
passing, and **M-DEL-GUARD2 survives 85/85**. The **verdict is right** — guard 2
is genuinely unpinned — and only the count is stale, because the branch added
three cases after round 1 took that number. A docblock that forbids
re-derivation must carry a number matching the tree it ships with, and must name
the surface the number is a property of.

## RT2-5 (P2) — the stale-citation class, unfinished

Round 1's RT-3 class. The five `write.ts:488-492` citations the round-2 brief
named are **all gone** — verified: no `write.ts:<digits>` or
`persist.ts:<digits>` citation survives anywhere in `src/`, `worker/`,
`.claude/reference/arch-review-log.md` or `docs/runbooks/beta-launch-alerting.md`.

The plan document keeps **sixteen more**, and every one resolved at HEAD is
wrong — this branch inserted ~36 lines into `write.ts` and ~90 into `persist.ts`:

| Cited | Claimed | Actually at HEAD |
|---|---|---|
| `write.ts:369` | `writeRefusalEvent` | a swallow comment inside `warnLedgerDisabled` |
| `write.ts:512` | `writeRefusalEvents` | a #1002 backfill comment |
| `write.ts:237` | `resetRefusalLedgerWarningForTests` | a blank line |
| `persist.ts:729`, `:877` | the function / the `held_draft` site | bare closing braces |
| `persist.ts:788` | `withLedgerAttribution`'s contract | the wrapper docblock's vocabulary-fault bullet |
| **`persist.ts:743`, `:745`** | **the guard list** | **inside the REPLACEMENT docblock — `:745` reads *"individually changes no outcome and kills no test"*, the exact sentence this branch retired** |

Those last two are worse than wrong: they hand a future reviewer the retired
claim as if it were current. **Re-anchor every citation BY SYMBOL.** A line range
is what rotted, twice, on this branch and its sibling.

Graded P2 to match round 1's grading of the identical class; the skill's scale
would allow P1 for a stale line number, and the resolve-to-contradicting-text
cases are the ones that argue for it.

---

## Mutation inventory — 11 rows, 7 killed, 1 equivalent, 3 excluded

| ID | Outcome | Test / target | Mutant and evidence |
|---|---|---|---|
| RT2-INV-01 | **killed** | `noteRefusalLedgerDark shares the write arms' once-per-episode latch` (`write.test.ts`) | M-NOTE-NOOP: `noteRefusalLedgerDark`'s body emptied. Baseline green, mutant FAILED. Re-derives the root's own claim rather than trusting it. |
| RT2-INV-02 | **killed** | `invariants: with the ledger off, the warning fires exactly when every block reason maps to a real category` (`persist.test.ts`) | M-EVERY-SOME: `wouldRecordRefusal`'s `.every(` → `.some(`. FAILED with `[["policy_not_enabled","current_rating_missing"]]` after 1 test, shrunk 2×. Confirms the docblock's central every-vs-some claim is genuinely test-enforced. |
| RT2-INV-03 | **killed** | `with REFUSAL_LEDGER_ENABLED off, a would-have-recorded decision warns once and a veto-only decision does not` (integration) | Two mutants, both killed on live Postgres. M-NOTE-NOOP failed half A (*"a withheld row reports the gap: expected [] to have a length of 1"*). M-EVERY-SOME failed half B, confirming half B really is the every-vs-some discriminator its comment claims to be. |
| RT2-INV-04 | **killed** | `with REFUSAL_LEDGER_ENABLED off, a throwing vocabulary resolver never runs and the draft row still commits` (integration) | M-GUARD4-NORETURN: the `return;` removed from guard 4's off-arm, so the arm warns then falls through to the resolve. FAILED with the armed poison `vocabulary_resolver_exploded`. **The new warning branch does not weaken containment.** |
| RT2-INV-05 | **killed** | `the held_draft lane still writes its refusal row and still aborts on a writer fault with the flag on` | M-DEL-GUARD1: `if (held) return;` deleted. FAILED: *"expected vi.fn() to not be called at all, but actually been called 1 times"*, recorded call `["moderation_flagged","moderation_held"]` — independently re-deriving the guard-1 number the docblock publishes, exact call included. |
| RT2-INV-06 | **killed** | `a structural non-candidate draft writes no policy_gate_held row` | M-DEL-GUARD3: the `isGenuineAutoCandidate` early return deleted. FAILED with *"expected [ { …(9) } ] to have a length of +0 but got 1"* — a spurious `policy_gate_held` row for a structural non-candidate. Re-derives the guard-3 number including its quoted failure text. |
| RT2-INV-07 | **killed** | `invariants: the flag decides the resolver call count — off yields zero calls, on yields exactly one receiving the generated block reasons verbatim and in order` | M-GUARD4-NORETURN (same mutant as INV-04). Baseline green inside the 85-case HEAD run of both suites; FAILED with `[["policy_not_enabled"],false]` after 5 tests. Re-entered the inventory because the fix hunk edited the production line this test covers. |
| RT2-INV-08 | **equivalent** | `wouldRecordRefusal`'s `blockReasons.length > 0` conjunct | M-DROP-LENGTH SURVIVES **99/99** across `persist.test.ts`, `refusal-write.integration.test.ts` and `write.test.ts`. **Proof, not judgement:** `wouldRecordRefusal` has exactly one caller (inside guard 4); guard 2 runs first; and across BOTH `AutoApprovalDecision` construction sites `approved` is true only when `blockReasons` is empty (`evaluateAutoApprovalCandidate` sets `approved: blockReasons.length === 0`; `structurallyBlockedDecision` throws rather than returning a structurally-blocked decision with an empty set). Guard 4 is therefore unreachable with an empty array, so the conjunct can never change an outcome. This is a claim about the MUTANT, not the oracle — the false COVERAGE claim attached to it is filed separately as RT2-3. |
| RT2-INV-09 | excluded | `writeRefusalEvent and writeRefusalEvents together emit exactly one disabled warning across one disabled episode` | The fix hunk changed only this case's comments, and the production lines it covers (both flag arms) are byte-identical to `659810f2`, where round 1 recorded this candidate killed. Its shared-latch property is additionally exercised at HEAD by INV-01. |
| RT2-INV-10 | excluded | `writeRefusalEvents issues no statement and emits no disabled warning for an empty input while the flag is off` | Same reason as INV-09: comment-only change in the fix hunk, covered production lines byte-identical to `659810f2`, killed there in round 1. |
| RT2-INV-11 | excluded | guard 2 deletion (docblock-claim verification) | Excluded as a SCOPE call, not an unmeasured row: guard 2 is unchanged production code outside the round-2 fix hunks, and a survivor there is not a round-2 finding. Run anyway to check the published number — **M-DEL-GUARD2 SURVIVES 85/85** at HEAD, so the verdict is correct and only the count is stale (filed as RT2-4). |

## What this round attacked hardest, and what held

- **Containment is not weakened by the new warning arm.** The obvious way the
  round-1 fix could have gone wrong is that guard 4's off-arm now *does something*
  before returning. M-GUARD4-NORETURN removes the `return;` so the arm warns and
  falls through — and it is killed twice: on live Postgres by the armed poison
  (INV-04) and by the biconditional property with a generated counterexample
  (INV-07). The arm warns and still executes nothing below it.
- **The `every`-vs-`some` rule is enforced, not merely asserted.** Killed on the
  unit property with a shrunk counterexample and again on the live-DB
  discriminator case (INV-02, INV-03). This is the branch's central correctness
  claim and it is genuinely pinned.
- **The two guard numbers round 1 corrected were re-derived from scratch**
  (INV-05, INV-06), including the exact recorded call and failure text the
  docblock quotes. The docblock's verdicts are right; only its guard-2 count is
  stale.
- **One mutant survived and it is proven equivalent, with the proof taken at the
  call site** (INV-08) — not waved through as "probably fine". The false coverage
  claim attached to it is filed separately (RT2-3) rather than folded into the
  equivalence.

## Method and environment — round 2

- Live-DB lane: the shared local Postgres was used as-is. `pnpm test:db:setup`
  was **not** run, per the wave brief. Gate invocations carried `VITEST_WORKERS=2`.
- Baselines were taken green at HEAD (`7269bdad`) before every mutant, and each
  mutated file was restored to its HEAD blob and verified by object id.
- Nothing was skipped for budget; nothing is inconclusive.
- **Round 2 is the CAP.** There is no round 3, and nothing above is deferred to one.

## Authorizations — round 2

None. No finding on this pass is `accepted-risk`.

---

# Appendix — round 1 (SUPERSEDED)

> **Historical record only, measured at `659810f2`.** Round 1's P0 (RT-1) was
> fixed at `b430c30a`; its RT-3 class is carried forward as round 2's RT2-5. Every
> `path:line` citation and every survivor count below is as of `659810f2` and
> does **not** resolve at HEAD — that staleness is the very defect class round 2
> filed as RT2-4 and RT2-5. Read the round-2 sections above for the current
> position; read this appendix only for the round-1 evidence trail.

## RT-1 (P0, FIXED at `b430c30a`) — the docblock's recorded mutation result is now false

`persist.ts:703-707` says:

> Branch review round 1 mutation-tested the original three: deleting guard 1, 2
> or 3 individually changes no outcome and kills no test, because the resolver
> guard already covers each case.

This branch did not leave that sentence alone. It renumbered it and then
explicitly bounded the staleness risk to guard 4 — *"THAT RESULT IS ABOUT THOSE
THREE AND THE RESOLVER GUARD (now numbered 5) AND NOTHING ELSE — guard 4
post-dates it (#1079)"*. That re-scoping publishes the claim as **current at
659810f2**. Measured, one guard at a time:

| Mutation | Result | Evidence |
|---|---|---|
| M10 — delete guard 1 (`if (held) return;`, `:776`) | **KILLS** T7 | `expected "vi.fn()" to not be called at all, but actually been called 1 times`, call recorded as `["moderation_flagged","moderation_held"]` |
| M11 — delete guard 2 (`if (autoDecision.approved) return;`, `:777`) | **survives**, 82/82 | claim holds here |
| M12 — delete guard 3 (`if (!isGenuineAutoCandidate(…)) return;`, `:778`) | **KILLS** a pre-existing case, **and changes the outcome** | `expected [ { …(9) } ] to have a length of +0 but got 1` — a `policy_gate_held` row **is written** |

Two distinct defects sit inside one sentence:

- **Guard 1 was falsified by this commit.** The test it now kills is
  `the held_draft lane still writes its refusal row and still aborts on a writer
  fault with the flag on` — added *by this branch*, and its
  `expect(resolvePolicyGateRefusalSpy).not.toHaveBeenCalled()` did not exist when
  round 1 took its measurement. The commit that re-asserts the claim is the
  commit that breaks it.
- **Guard 3 fails both halves**, and was already false at the fork point (the
  killing test predates the branch at `f797d250`). It is re-published rather
  than introduced — but it is re-published under a sentence that just told the
  reader it had been re-checked.

**Why P0 and not P1.** This is not a stale line number and not a style
objection. The docblock's stated job is to tell the next reader which guards are
safe to delete as "defence in depth". As written it licenses deleting guard 3,
and doing so writes a spurious `policy_gate_held` Refusal for a structural
non-candidate — a data-correctness defect in the ledger the Restraint tab
renders. The skill's rubric puts a misleading false claim at P0, and the branch
holds itself to exactly this standard three lines further down:

> an earlier version of this docblock claimed "each answers a different
> question", which was false and is corrected here rather than left to mislead
> the next reader.

**No runtime behaviour is wrong.** The fix is a docblock correction naming which
guard is actually unpinned (guard 2, with the proof) and what now pins the other
two.

## RT-2 (round 1, P1) — the alerting runbook overstates the ledger's gap detector

All six facets compared against the signal emitted at HEAD:

| Facet | Verdict |
|---|---|
| Signal identity | matches — `captureMessage`, `tags.subsystem=refusal_ledger` via `warnLedgerDisabled` |
| Filter | matches; pre-existing ambiguity **not** added here (`withLedgerAttribution` also tags `subsystem:refusal_ledger` at level `error`, and its capture body is unchanged by this diff — only its docblock moved) |
| Level | matches (`warning`) |
| Grouping title | n/a |
| **Threshold / cadence** | **CONTRADICTED** |
| Destination action | matches (Discord) |

The row says the warning fires *"once per disabled episode whenever
`REFUSAL_LEDGER_ENABLED=false` and a write is attempted"*. After this branch,
guard 4 returns **before any write is attempted** on the `policy_gate_held`
lane, so with the flag off that lane contributes nothing to the episode.

The branch records this as an accepted cost in three places (intake
`observability[3]`, the arch-review-log row, the guard-4 docblock), and I
verified the compensating claim is **true**: the `held_draft` lane at
`persist.ts:930` and all six other production write sites still call
`writeRefusalEvent(s)` with no flag guard, so they still warn. What was not
updated is the runbook — the operator-facing document that specifies the alert
rule and asserts in bold *"**This is the only signal that the ledger has a
gap**"*. It now overstates that coverage with no mention of the blind spot.

**Scope note for the adjudicator:** `docs/runbooks/beta-launch-alerting.md` is
not in the intake's `allowed_edit_surface`, so this is a scope decision for the
root, not an implementer miss. The fix is one sentence.

## RT-3 (round 1, P2 — carried forward as round 2's RT2-5) — a stale citation, deliberately not double-counted

At `659810f2`, `src/lib/refusals/write.ts:488-492` is the close of a docblock
plus three fields of `interface RefusalEventRow`. The empty-input no-warn rule
the branch repeatedly cites as its governing constraint is at
`src/lib/refusals/write.ts:525-529`. The same commit that cites `488-492`
shifted it, by inserting 36 lines above it. Four occurrences: `persist.ts:743`,
`write.test.ts:646`, `write.test.ts:698`, and
`.claude/reference/arch-review-log.md:1510`.

**Severity set below the rubric on purpose.** In isolation a stale line number is
P1. The async review axis already recorded this defect twice in
`docs/reviews/finding-checklists/async.md` at `[low]` during this same wave, and
my independently derived numbers agree with theirs exactly (`:525-529`). Filing
it as a blocking P1 here would count one defect twice across two axes and force
user adjudication on an already-triaged low. Recorded at P2 with the
verification attached so the root can dedupe. Both axes converge on the same
fix: cite the owner **by symbol**, not by line range.

Observed and **not** filed: every `path:line` citation in the intake
(`write.ts:353-359`, `:364-368`, `:488-492`, `:369`; `persist.ts:788-807`,
`:877`) resolves against the fork point rather than HEAD — correct and expected
for a locked pre-change contract.

---

## What round 1 attacked hardest, and what held

### Claim 1 — "with the flag off the vocabulary resolver is invoked ZERO times"

The dispatch's concern was that an absence assertion passes on any fixture
defect. It does not here, and the evidence is unusually direct: under **M1**
(guard 4 deleted) the test fails with

```
expected "vi.fn()" to not be called at all, but actually been called 1 times
Received: 1st vi.fn() call: [ [ "triage_high_severity" ] ]
```

The recorded argument proves the fixture reaches the resolver on the policy lane
with a real, non-veto block reason — a wrong tier, wrong origin lane, null
threshold, `held` or `approved` would each have produced zero calls here too.

The positive control is real and it is the **same fixture** (identical
`seedReview` + `makeInput`; the flag value is the only difference). Under **M2**
(guard 4 inverted) it fails with `expected 1 times, but got 0 times`. A vacuous
control could not do that.

### Claim 2 — the property test is a biconditional over the flag

It depends on its generated input on **both** arms:

- **OFF arm** — M1 → counterexample `[["policy_not_enabled"], false]`
- **ON arm** — M8 (array sorted before the resolver call) → counterexample
  `[["policy_not_enabled","moderation_flagged"], true]`, killing the "verbatim
  and in order" clause specifically.

Also checked for latent flakiness, since a throwing resolver would make this
test intermittently red: all 22 members of `POLICY_GATE_HELD_REFUSAL_CATEGORIES`
are mapped, and all 15 non-`null` members appear in
`AUTO_APPROVAL_BLOCK_PRECEDENCE`, so no generated subset can reach the resolver's
`unmapped_…` or `unranked_…` throws. The generator is safe today; #1080 owns the
structural enforcement.

### The eight promised titles

The verify gate matches title text only and never checks that a title asserts
anything. All eight are present verbatim, and **each has a confirmed kill**:

| Promised test | Killed by |
|---|---|
| T1 off ⇒ zero resolver calls | M1 |
| T2 on ⇒ exactly one + row | M2 |
| T3 capture once, tags, same instance | M3 |
| T4 still aborts, no response row | M7 |
| T5 one warning per disabled episode | M9 |
| T6 empty input: no statement, no warning | M5 **and** M6 |
| T7 `held_draft` lane pin | M10 |
| T8 the flag decides the resolver call count | M1 **and** M8 |

M7 deserves a note: it is the swallowing `try/catch` around the resolve — the
exact alternative shape the branch documents as rejected. It fails T4 with
`promise resolved "{ kind: 'persisted' }" instead of rejecting`. The
over-application guard does the job it claims.

### The purity contract

Both halves are load-bearing and both are pinned:

- **M5** — predicate warns (`if (!on) warnLedgerDisabled();`) → T6 fails,
  `expected [ Array(1) ] to have a length of +0 but got 1`.
- **M9** — predicate mutates the latch (`if (on) endDisabledEpisode();`) → T5
  fails with its own message, *"the predicate did not end the episode"*.
- **M6** — flag read hoisted above the `inputs.length === 0` return → T6 fails.
  The documented ordering is real.

## Duty 4 (round 1) — missed sibling cases: **zero, from a sound search**

**Pattern searched.** The shape #1079 fixes is *a caller performing ledger work
that can throw, in front of `write.ts`'s flag read, inside the deciding
transaction.*

**Searches run**

1. `grep -rn "refusals/vocabulary" --include="*.ts" src worker` (minus `__tests__`) — every production importer of the vocabulary module.
2. `grep -rn "writeRefusalEvent\b\|writeRefusalEvents\b" --include="*.ts" src worker` — every production call site of either write arm.
3. `grep -n "^export function\|throw new Error" src/lib/refusals/vocabulary.ts` — every throwing export.

**Scope** `src/`, `worker/`. **Exclusions** `__tests__/` (not production) and
`src/lib/refusals/write.ts` itself (the owner).

**Result.** `resolvePolicyGateRefusal` is the **only** throwing export in the
vocabulary module, and its only production consumer is
`worker/jobs/response-generation/persist.ts`. The six sibling write sites each
derive their category by a **total map index over a closed union** — no throwing
call anywhere in front of the flag read:

| Site | Derivation |
|---|---|
| `src/lib/solicitation/dispatch.ts:1474` | `OUTREACH_WITHHELD_DISPATCH_REFUSAL_CATEGORIES[…]` |
| `src/lib/solicitation/ask-generation.ts:698` | `OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES[reason]` |
| `src/lib/solicitation/batch-builder.ts:670` | `ASK_WITHHELD_REFUSAL_CATEGORIES[decision.reason]` |
| `src/lib/solicitation/approval.ts:637` | `BATCH_HALTED_REFUSAL_CATEGORIES[input.reason]`, null-checked before the write |
| `src/lib/auto-approval/suspension.ts:331` | `AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES[…]` |
| `worker/jobs/publisher/auto-policy-downgrade.ts:208` | `AUTO_POST_REVOKED_REFUSAL_CATEGORIES[…]` |

**Zero true siblings.** One near-miss recorded and rejected as a finding:
`batch-builder.ts:670` builds its whole `decisions.flatMap(…)` array eagerly as
the *argument* to `writeRefusalEvents`, so that work does run in front of the
flag read — but it is pure, total and non-throwing, so it cannot abort a
transaction. The intake's non-goal ("do not extend attribution to the other six
write sites — that is #1083") is about attribution, not containment; on
containment there is nothing to extend.

Also verified while there: the intake names the six sites without directories.
All six **line numbers resolve correctly**, but `suspension.ts` is
`src/lib/auto-approval/` (not `agents/governor/`) and `auto-policy-downgrade.ts`
is `worker/jobs/publisher/` (not `src/lib/refusals/`). Recorded as an
observation, not filed.

## Duty 2 (round 1) — fragile assertions: none of the three named shapes

Searched the three changed test files for absence-of-tag proxies, exact string
counts on rendered output, and order assertions with no ordering contract.

- **Every absence assertion added by this diff carries a proven positive
  control** — T1 by T2 (killed under M2), T6 by its trailing non-empty batch
  (killed under M5 and M6), T5 by its `resetRefusalLedgerWarningForTests`
  new-episode arm (killed under M9), T7 directly (killed under M10).
- The single order assertion — `toEqual` on the resolver argument in T8 — has an
  explicit ordering contract in `vocabulary.ts` ("the input VERBATIM, in its own
  order") and is killed under M8.
- Tags are compared with `toMatchObject`, not exact equality.
- `ALL_BLOCK_REASONS` is derived via `Object.keys(...)` rather than hardcoded,
  and its `// 22 today` comment is accurate (15 mapped + 7 `null`).

The one thing worth recording is RT-4, a latent state-leak hazard rather than a
fragile assertion.

## Other invariants re-derived (round 1, against `659810f2`)

| Claim | Verdict |
|---|---|
| `write.ts` is the only production module spelling `INSERT INTO refusal_events` | **true** — only `write.ts:432` and `:580` |
| `src/app/api/dashboard/refusals/route.ts:76` keeps its own literal flag spelling for `ci:env-registry` | **true** — `readFlagEnabledByDefault('REFUSAL_LEDGER_ENABLED')` |
| `REFUSAL_LEDGER_FLAG` is still used in `persist.ts` (no dead import) | **true** — `persist.ts:852`, in the Sentry tags |
| `held_draft` lane gains no guard and no behaviour change | **true** — `persist.ts:930`, unguarded |
| The resolver returns `null` (not a throw) for an empty set, as guard 2's redundancy argument requires | **true** — `vocabulary.ts:627` |
| `withLedgerAttribution`'s capture body is unchanged by this diff | **true** — docblock-only hunk |

## Method and environment — round 1

- Baselines and mutants ran under an identical isolated environment built by
  `mutation-runner.mjs env` (allowlist: `PATH`, temporary `HOME`, `TMPDIR`,
  `NODE_ENV`, `CI`, `MOCK_EXTERNAL_APIS`, plus a **validated localhost**
  `TEST_DATABASE_POOL_URL`). `.env.local` was swapped for a scrubbed copy for
  the whole mutation phase.
- Live-DB lane: the shared local Postgres at `localhost:5499` was used as-is.
  `pnpm test:db:setup` was **not** run, per the wave brief. Gate invocations
  carried `MAX_PARALLEL=2 VITEST_WORKERS=2`.
- **One deviation, recorded:** the first integration baseline silently skipped
  all 30 cases because `mutation-runner.mjs run` needs its own `--test-db`
  (passing it only to `env` is not enough — the child otherwise inherits
  `REPWORTH_DISABLE_LIVE_DB_SUITES=1`). Caught and re-run before any
  measurement was taken. Worth knowing for the next pass: a live-DB red-team run
  that forgets this reports green mutants that never executed.
- Green baselines at HEAD before any mutation: **30/30** integration,
  **65/65** unit.
- Every mutant run was verified with `assert-one-test` except the two
  whole-suite Duty-3 doc probes (M11, M12), where the question was expressly
  *"does this kill **any** test"* and a single-test run could not answer it.
  That deviation is deliberate and is why those two rows are `excluded` rather
  than coverage measurements.
- 18 of 30 mutation runs used. Nothing was skipped for budget.

## Restoration — round 1

Every mutated file was restored to its `659810f2` blob and verified by object
id; `git status --porcelain --untracked-files=no` is empty apart from this
report directory. Untracked siblings present during the run and **not** mine:
`.feature/review-staging/` (the read-only review axes) and
`docs/reviews/finding-checklists/` (written by the root's `review-log.mjs
triage`). Neither is evidence of a failed restoration.

**The dotenv swap is still open by design** — this run does not call
`finalize`; the root owns it. `.env.local` is currently the scrubbed replacement
and the real file is at `.env.local.red-team-backup`. The root's
`mutation-runner.mjs finalize` restores it and closes the journal; every
mutation entry will be found already at its original oid and marked restored
without a write.

## Authorizations — round 1

None. No finding on that pass was `accepted-risk`.
