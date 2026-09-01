# Branch review round 1 — four axes, triage verdicts

**Branch:** `feat/1013-refusal-policy-gate-held` · **Wave SHA:** `9aa52781`
**Fixes at:** `edf7c13b`, `ccaeb196`, `35f60e9c`, `484bb598`

One parallel wave, four axes, dispatched the moment the review gate went green
and after `origin/main` was taken (the fork froze at dispatch). Per-axis full
reports were staged outside git during the wave; this file is the durable
record of what each found and what was DONE about it.

## Scoreboard

| Axis | Runner | Findings | Accepted | Rejected |
|---|---|---|---|---|
| Spec & correctness | Claude | 4 | 4 | 0 |
| Standards & maintainability | Claude | 9 | 9 | 0 |
| Adversarial approach | Codex | 3 | 3 (1 partial) | 0 |
| Red team | Claude | 16 across 2 rounds | 15 | 1 |

**Mutation totals:** 22 planted round 1 (16 killed, 6 arbiter-confirmed
equivalent) · 12 round 2 (8 killed, 3 survived, 1 excluded) · 3 re-plants after
the fixes (3 killed, 0 survived).

## The three findings that mattered

**1. Two test titles could not fail** (spec SC1/SC2, red team RT-2/RT-7,
independently). Title 25 asserted the candidacy narrowing's `threshold !== null`
arm, but `policy_not_enabled` is itself a veto member, so no row is written with
or without the arm — mutation M10 deleted the WHOLE narrowing and 75 tests
stayed green. Title 20's "verbatim order" clause was
`toEqual([...new Set(self)])`, a duplicate check against an already-deduplicated
array — a writer that SORTED passed it.

*Fixed:* title 25 now captures the fallback log, which has no veto concept and
is therefore the only oracle for that arm; title 20 asserts the gate's literal
emission order. Both verified by re-planting the mutation.

**2. A round-1 FIX introduced a P0** (red team RT-15). `withLedgerAttribution`,
added to make the kill switch discoverable, put a `try/catch` on a path
guarding invariant #4 — and nothing pinned the rethrow. Swapping `throw error`
for a swallow survived all 75 tests. The A/B was decisive: the two existing
constraint tests inject a `23514`, which poisons the transaction, so the
rollback they observe comes from Postgres and not from the throw. With a plain
JS error, a swallow **commits the response row with no Refusal recorded**.

*Fixed:* an oracle that injects a plain `Error` on both lanes and asserts the
persist rejects AND `responses` holds no row. Re-planting the swallow now fails
exactly that one case.

**3. A false mechanism in three places** (spec SC3, red team RT-1, converging).
The `!held` guard was justified by "mapping `moderation_held` to `null` is not
sufficient". That was #998's reasoning, written BEFORE #1003 made `null` a veto
rather than a rank — it reads `null` as if it lost a ranking contest, the exact
misreading the veto rule exists to prevent.

*Fixed:* all three sites corrected; the guards docblock now states plainly that
three of four guards are redundant defence in depth and names the load-bearing
one. Red team's M1/M1b pair proved the redundancy is mutual.

## The one rejected finding

**RT-4** claimed `findActiveReviewRun.mockResolvedValue(null)` "does not exist in
`persist.test.ts` at HEAD or merge-base (all nine are `ACTIVE_RUN`)". It exists,
at `:799` at HEAD and `:768` at the merge base. Verified with `git show`. The
agent confirmed its own grep had been truncated by `head -10` and re-ran every
other negative claim untruncated. The residual real defect — a stale line number
in the handoff — was split out as RT-14 and fixed.

## Owner decisions taken during triage

**A1 — D4 voids #1014's stated premise.** That ticket renders **Coverage start**
as `accounts.created_at` on the strength of "merge ordering is the gate, not a
flag". For `policy_gate_held` that is false: the lane stays dark behind
`AUTO_APPROVAL_ENABLED`, and #1002 forbids a backfill. Owner chose **disclose,
do not repair** — #1013 ships as built, `CONTEXT.md` records that #1014 must
render `max(accounts.created_at, lane activation)` or state the lane separately,
and the constraint is posted to #1014 at step 8. The rejected alternatives (a
durable coverage-start marker; reversing D4) are recorded in the deviations file.

**A1's second half REJECTED** — codex asked for a durable counter on flag-off
exclusions. Declined: `AUTO_APPROVAL_ENABLED=false` is the deliberate documented
pre-launch state, so a counter would alert continuously on the intended
configuration, and auto-approval instrumentation is not this slice's to own.
What WAS accepted is that the reconciliation query was vacuous as written; the
intake now states it is meaningful only with the flag on.

## Everything else

| ID | Axis | Finding | Disposition |
|---|---|---|---|
| A2 | codex | D4 claimed the ledger-disabled warning signals darkness; under D4 the writer is never called so it cannot fire | fixed — D4 corrected |
| A3 | codex | Kill switch not operationally discoverable | fixed — `withLedgerAttribution` |
| S1 | standards | `Record<string, …>` widening erased literal types; a null-mapped precedence member compiled and threw at run time | fixed — precise type, dead throw deleted |
| S2 | standards | Four unguarded mutate→act→restore fixture pairs; two set VETO conditions, so a mid-pair failure made eleven assertions vacuous | fixed — `withTemporary` try/finally |
| SC4 / RT-3 | spec, red team | `docs/directory.md` "Ten sites remain across #1010–#1013" false at HEAD | fixed |
| RT-5 | red team | Three shipped `path:line` citations resolved at the merge base, not HEAD | fixed — symbol citations |
| RT-6 / RT-14 | red team | Two stale citations in the handoff | fixed |
| RT-8 | red team | Order-assertion input was accidentally alphabetical, so `.sort()` survived | fixed — reordered, winner pinned |
| RT-9 / RT-10 | red team | Members unreachable through the write path; tier 5 `below_our_bar` dead on this lane | fixed — disclosed in the precedence docblock |
| RT-11 | red team | "FOUR GUARDS … each answers a different question" — three provably cannot change the outcome | fixed |
| RT-12 | red team | "six maps" stale; there are seven | fixed |
| RT-13 | red team | "highest-volume lane" unqualified beside D4's flag-off silence | fixed — all four sites |
| RT-16 | red team | The unreachability disclosure said FIVE members; it is SIX (`moderation_held`, blocked by guard 1) | fixed |
| P2 (standards) | standards | RED-phase namespace scaffolding, duplicated accessors, property test directory, comment density, comment-about-a-comment | **partially accepted** — the honesty defect in the comment-about-a-comment was fixed; the scaffolding and directory items are recorded as accepted debt, since the accessors still guard against a rename and moving the file buys nothing this branch needs |

## Recorded limitation of the tooling, not of the branch

`red-team-status.mjs` reports `INCOMPLETE_ORACLE` with `p0_open = 0` and
`p1_open = 0`. The status is driven solely by `inconclusive/oracle` rows — the
six equivalent mutants, where deleting a guard or remapping an entry changes no
observable behaviour, so NO oracle can kill them. The agent declined to mark them
`killed` to reach CLEAR, correctly: that would assert a test caught what no test
can catch. `OUTCOMES` has no `equivalent` member, so the status vocabulary cannot
express "unfalsifiable by design".

A separate checker defect (deviation D10) was found and proved during this run:
`makeGit` trims the whole porcelain output, so `line.slice(3)` mis-slices the
first line and the exclusion list never matches it. Filed for a follow-up rather
than patched from inside the branch the gate is judging.
