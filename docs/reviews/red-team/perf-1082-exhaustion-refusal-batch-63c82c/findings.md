# Red-team — `perf/1082-exhaustion-refusal-batch`

| | |
|---|---|
| Mode | feature, round 1 |
| Fork / merge-base | `b9fb96016cc025c151f17db4b39baf165cb80a13` |
| HEAD | `4f39fbd26e51e46bea1a45d8e6069d576c756021` |
| Intake SHA-256 | `2bc2a55f…f3a160` (risk: **high**) |
| Generated | 2026-09-03T12:11:50Z |
| **Status** | **OPEN_P0** |

Mutation runs used: **15 of 30**. All mutations restored; `finalize` reported
`restored 0 mutated file(s) and 1 dotenv file(s); journal closed` (each mutant
was restored to its journaled original before the next was applied, so the
finalizer found nothing outstanding). Tree clean at HEAD apart from this
report directory and the untracked `docs/reviews/perf-1082-…/` staged by the
other review axes.

Environment: allowlist env via `mutation-runner.mjs env --tmp-home …
--test-db postgresql://…@localhost:5499/test_ws4`, `.env.local` swapped for the
scrubbed replacement for the whole mutation phase. The live-DB lane RAN — it is
not a skip.

## Findings

| Severity | file:line | Finding |
|---|---|---|
| **P0** | `.claude/reference/arch-review-log.md:1513` | The row's claim that `refusalCalls()`'s `invocationCallOrder` sort is "LOAD-BEARING" and that "arm order mis-pairs every row the moment a second arm exists" is FALSE at HEAD — replacing the sort with plain concatenation leaves 51/51 unit tests green. |
| **P1** | `src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1493` | The new live-DB abort case does not kill the drift the row says it guards; three pre-existing cases do, one of them the same scenario 190 lines below. |
| **P1** | `docs/superpowers/plans/perf-1082-exhaustion-refusal-batch-plan.md:99` | Seven `path:line` citations in the changed plan (and one in the intake) do not resolve at HEAD; `prevalidate-plan.py` PASSes because it resolves files, not lines. |
| P2 | `docs/superpowers/plans/perf-1082-exhaustion-refusal-batch-intake.json:83` | Observability claim conflates the job's Sentry issue with the settlement's own (caught, logged, never rethrown) failure signal. |
| P2 | `src/lib/solicitation/__tests__/ask-generation.test.ts:1608` | "no holes" case's title states a behavioural property; its assertions pin the unconditional call, so a behaviour-preserving guard turns it red. |
| P2 | `src/lib/solicitation/__tests__/ask-generation.test.ts:1` | Claimed suite sizes (53 / 23) do not match HEAD (51 / 22). |

Full text of each finding, including the arbiter's non-equivalence reasoning
for the P0, is in `findings.json`.

## Duty 1 — hand-mutation

Sixteen inventory rows; 13 killed, 1 confirmed survivor, 2 excluded with a
recorded reason, 0 inconclusive, 0 skipped for budget.

Mutations applied, all journaled and restored:

| Id | Mutation | Result |
|---|---|---|
| M1 | Revert the batching: `recordOutreachWithheldRefusal` back inside the hole loop, batched call deleted | killed — 2 red, BOTH new unit cases and nothing else |
| M2 | `writeRefusalEvents(sql, refusals)` in place — the pool handle instead of `tx` | killed by the new abort case AND by pre-existing `:1682` |
| M2b | `refusals` hoisted above `sql.begin`; the write moved AFTER the transaction | killed by `:1360`, `:1624`, `:1682` — **not** by the new case at `:1493` |
| M3 | `refusals.pop()` before the write (one Refusal silently dropped) | killed by the new one-call case and the matrix case |
| M4 | `refusalCalls()` sort replaced with plain arm-order concatenation | **SURVIVED**, 51/51 green → RT1082-01 |
| M5a | `outreachWithheldRefusalInput` returns a hard-coded `refusalCategory` | killed by `:1367` only |
| M5b | wrong `subjectType` (`solicitation_ask`) | killed by `:1409` and the matrix case `:1443` |
| M5c | `occurredAt: 'transaction_time'` | killed by the matrix case and the forced-clock case `:1486` |
| M6 | caller-side `if (refusals.length > 0)` guard | killed by the "no holes" case (the assertion is STRONGER than its title, not weaker) |
| M7 | delete the `writeRefusalEvents` line from `expectNoRefusalWrite` | 51/51 green on its own — see below |
| M8 | unconditional `writeRefusalEvents(tx, [])` hoisted above the outbox-CAS guard | killed by the stale case, and by both new cases |
| M8+M7 | the two together, stale case only | **passes** — which is the proof that `expectNoRefusalWrite`'s second line is load-bearing, not decorative: the same production defect goes red with the line and green without it |

The brief's hypothesis that the batching revert would be caught only by the one
new unit case is **half right**: M1 turns exactly two cases red, and both are
new. Nothing pre-existing notices that the lane went back to a per-hole write —
which is correct, because per-hole writing is not a behavioural defect. The
row count, the subjects, the category, the code and the clock are all still
pinned by pre-existing cases (M3, M5a, M5b, M5c all die on them).

## Duty 2 — fragile assertions

- `ask-generation.test.ts:1608` — title/assertion mismatch, recorded as
  RT1082-05.
- `ask-generation.test.ts:1443` (matrix case) — positional pairing of
  `refusalCalls()[i]` with `withheld[i]`. An ordering contract DOES exist for
  this (intake invariant: "Subject ids stay the ids `insertOutreachRender`
  minted, in loop order"), so the pairing is legitimate. What is not legitimate
  is the claim that the sort protecting it is exercised — RT1082-01.
- `ask-generation.test.ts:1595` — `toEqual(['outreach-1','outreach-2',
  'outreach-3'])`. Order assertion, contract exists, not fragile.
- No absence-of-tag proxies and no exact string counts in the changed tests.

## Duty 3 — docs vs reality, re-resolved at HEAD

`python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py` was run on
both changed docs and reports **PASS** (5 and 0 citations checked, 0
unresolved). It resolves FILE paths only, so every line number below was
**hand-checked** against HEAD.

Confirmed TRUE:

- "27 executable lines added (40 comment, 3 blank), measured AT HEAD by first
  non-whitespace token" — re-measured on the pinned diff: 70 added lines = 27
  code, 40 comment, 3 blank. Exact. (87 changed = 70 + 17 deleted, matching D1.)
- "`batch-builder.ts:670` calls unconditionally with a possibly-empty
  `flatMap`" — line 670 is `await writeRefusalEvents(`, inside
  `commitAskDecisions`, with no length guard.
- "`writeRefusalEvents` already shipped … `commitAskDecisions` already called
  it; this branch is the second call site" — confirmed: exactly two production
  call sites of the set arm at HEAD.
- "the win is 2N → N+1 round trips, not 2" — `insertOutreachRender` stays per
  hole, so N inserts + 1 ledger statement.
- Kill-switch claim: `writeRefusalEvents` returns on `inputs.length === 0`
  BEFORE the flag read (`write.ts:589`), and `warnLedgerDisabled`
  (`write.ts:368`) is latched by `warnedThisEpisode` (`write.ts:296`). N
  single-row calls and one set call therefore both produce exactly one warning,
  and zero holes produce none under both. No warning-count delta. TRUE.
- `write.ts:547`/`:584`, `write.ts:296`/`:368` all resolve at HEAD.
- Claim (a), "only one of the lane's four writers was a loop": TRUE.
  `persistChildRender` opens its own `sql.begin` per child
  (`ask-generation.ts:833`), so W1/W2 settle one render per transaction even
  though `generateAsksForBatch` calls it repeatedly; `regenerateAsk`
  (`:1478`) settles one swap per transaction.

Confirmed FALSE or stale: RT1082-01 and RT1082-03.

## Duty 4 — missed sibling cases

**Pattern searched:** `rg -n 'writeRefusalEvents?\(' --glob '*.ts' src worker`,
excluding `__tests__`. **Scope:** the whole repository's production TypeScript.
**Result:** nine call sites at HEAD — eight pre-existing plus the one this
branch added. For each, the enclosing function and every caller were resolved
and checked for the "N ledger writes inside ONE lock-holding transaction" shape.

| Site | Enclosing | Loop inside one transaction? |
|---|---|---|
| `src/lib/auto-approval/suspension.ts:331` | `suspendAccountAutonomy` | No. Callers `JudgeWorker.ts:136` and `AutonomyGovernorScheduler.ts:61`; the scheduler DOES loop over candidates, but `suspendGovernorCandidateIfCurrent` opens `exec.begin` **per candidate** — one write per transaction. |
| `src/lib/solicitation/batch-builder.ts:670` | `commitAskDecisions` | Already the set arm. |
| `src/lib/solicitation/dispatch.ts:1474` | `commitWithhold` | No. One outreach per dispatch transaction (single call site, `dispatch.ts:1718`, not in a loop). |
| `worker/jobs/response-generation/persist.ts:898` | `recordPolicyGateRefusal` | No. One response per transaction. |
| `worker/jobs/response-generation/persist.ts:1038` | `recordModerationAndHold` | No. One response per transaction. |
| `src/lib/solicitation/approval.ts:637` | `latchHalt` | No. Three call sites, each once per transaction. |
| `src/lib/solicitation/ask-generation.ts:702` | `recordOutreachWithheldRefusal` (W1/W2/W3) | No — `persistChildRender` and `regenerateAsk` each own their `sql.begin`. |
| `worker/jobs/publisher/auto-policy-downgrade.ts:208` | `downgradeAutoApprovedResponseForManualReviewInTx` | No. Four call sites, each once per response. |

**Zero siblings.** The branch's conclusion holds, independently derived.

One note, not raised as a finding: the ticket asked about "the other seven
write sites", and claim (a) answers it by arguing about W1/W2/W3 — all three of
which live in the file the branch changed, not among the seven. The conclusion
is right; the stated reasoning addresses a different set.

## Duty 5 — operational completeness

**The diff adds no new terminal or swallowed failure path.** A failed set write
throws, aborts `settleGenerationExhaustion`'s transaction, and is handled by the
same `deadLetterWholeBatch` catch that already handled a failed single-row
write. No new rule row in `docs/runbooks/beta-launch-alerting.md` is owed by
this change, and no emitted signal contradicts a documented facet.

The intake is honest that the silent shape — "fewer Refusal rows than withheld
fills, with no error and no log line" — has no production emitter, and pushes
the burden onto tests. **That is acceptable here**, on two grounds a runtime
check could not improve: (1) the shape is a code defect in array construction,
not a runtime failure, so a runtime assertion would have to re-derive the row
count from the same array that is wrong; (2) the transaction already couples
fills and Refusals, so the only reader-visible inconsistency is an under-count,
and the live-DB guard at `:1462` compares id SETS rather than counts, which is
the right oracle for it. The one qualification is RT1082-04: the intake's
description of how a CHECK violation reaches an operator is not accurate, and
`terminal_settlement_abandoned` has no alert row — both pre-existing.

## Authorizations

None recorded.
