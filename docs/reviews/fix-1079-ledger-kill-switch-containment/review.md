# Review record — `fix/1079-ledger-kill-switch-containment`

Reviewed SHA: `659810f23660fd12cc6c8a6223fe8bfc04547d58`
Fork point: `f797d25064c31997dfe400414baf99967b63315f` (unmoved throughout; no rebase)
Production diff at review time: **+216 / −30** (tests excluded) — 26 executable
lines, 91 comment, 3 blank. Risk `high`, so the maintainability axis and the
red-team pass were both mandatory, not threshold-triggered.

## Why this record is consolidated rather than four staged reports

The three read-only axes were dispatched as read-only agents with no
file-writing tools, so none could write its own
`.feature/review-staging/<axis>.md`. Each returned its full report inline
instead. That is a dispatch error by the root, not a reviewer failure — the
reports were complete and are reproduced in substance here. The durable
per-finding record lives in `.feature/review-transcript.jsonl`, which carries
every finding and every triage verdict with its evidence. The red-team pass
wrote its own report and sidecar normally, under
`docs/reviews/red-team/fix-1079-ledger-kill-switch-containment-bd15cd/`.

## The wave

| Axis | Findings | Outcome |
|---|---|---|
| spec/correctness | 2 Low | no blocking defect |
| standards & maintainability | 3 Medium, 3 Low | no blocking defect |
| async/operations (risk axis) | 2 Medium, 2 Low | kill switch verified by enumeration |
| red team | 1 P0, 1 P1, 2 P2 | `OPEN_P0` → both blockers fixed |

**15 findings. 15 ACCEPT. 0 REJECT.** None was a defect in the shipped
behaviour. Every one was either a claim the branch made about itself that did
not survive checking, or a gap in what the tests could prove.

## What the review CONFIRMED, which matters as much as what it found

- **The kill switch contains.** The async axis enumerated every statement
  reachable inside `sql.begin` on both lanes with the flag off and could not
  break it. `readFlagEnabledByDefault` is one `process.env` compare;
  `warnLedgerDisabled`'s two transports are each individually caught with
  assignment-only catch bodies.
- **All eight promised titles genuinely assert.** The gate matches title text
  only; three independent reviewers checked the bodies. The zero-invocation case
  has a working positive control on a byte-identical fixture, and red team
  confirmed the fixture reaches the resolver by observing its recorded argument.
- **The property is a real biconditional**, deep-equalling the generated array in
  order. Both shapes the plan skeptics killed — the `try/catch` swallow and the
  one-sided tautology — stayed dead.
- **Architecture invariants 2, 3 and 4 are unmoved**, and a flag-on ledger fault
  still aborts the persist.
- Red team: **10/12 mutation rows killed, 2 excluded, zero inconclusive**, no
  surviving mutant that measures this diff.

## The one behaviour change review forced

**The observability gap was avoidable, and is now closed.**

The signed-off plan conceded that this lane loses the once-per-episode
ledger-dark warning with the flag off, on the premise that a guard cannot know
whether a row would have been written without running the throwing resolver.
The async axis proved that premise false: map membership is decidable with
`Object.hasOwn`, which cannot throw.

Owner-approved and shipped: `write.ts` exports `noteRefusalLedgerDark`, a
side-effecting sibling of the side-effect-free predicate that calls the SAME
private `warnLedgerDisabled` — so it shares the once-per-episode latch rather
than adding a second signal. Guard 4's off-arm raises it only when
`wouldRecordRefusal` is true.

**The review's own proposed spelling was wrong and was corrected.** It proposed
`some(mapped && non-null)`. One `null`-mapped member vetoes the whole row
(#1003), so `some` returns true for a set that resolves to nothing — warning
about a decision that was never going to be recorded, re-breaking the exact rule
the arm exists to respect. The shipped predicate is `every`, with a length check
for the empty set.

## Three claims the branch made about itself that were false

This is the theme of the whole review, and it is worth naming: a branch whose
purpose was fixing a stale, self-contradicting claim shipped three more.

1. **The retained mutation-testing result.** The guard docblock re-published
   "deleting guard 1, 2 or 3 kills no test" as current. Red team re-measured per
   guard: guard 1 deletion **kills this branch's own new pin** (the commit
   re-asserting the claim is the commit that falsified it); guard 2 survives
   82/82; guard 3 deletion kills a pre-existing test **and writes a spurious
   `policy_gate_held` row** for a structural non-candidate — a ledger
   data-correctness defect the docblock was licensing. Already false at the fork
   point; never measured. The docblock now carries the per-guard numbers.
2. **"PURE."** `vocabulary.ts` defines that word for this same feature area as
   "no DB handle, no clock, no flag read", and the new predicate's whole body is
   a flag read that must differ between calls. The property relied on is
   side-effect-freedom. Renamed everywhere.
3. **"The window is microseconds wide."** It is **zero** — no `await` separates
   the two flag reads. The intake additionally drew a false consolation from it
   (that the lane could still warn through the second read), which was
   structurally unreachable and would have set a false-green trap for any test
   written against it. Both corrected.

## Stale cross-references, and the mechanism behind them

`write.ts:488-492` was cited in five places and was wrong in all five **the
moment it was written** — the same 36-line insert that created the predicate
moved the rule to `:525-529`. The mechanism was four-way duplication of one
argument. Every citation is now BY SYMBOL, because a line range is what rotted.

A sixth, outside the original surface: `src/lib/refusals/read.ts:45` cited
`persist.ts:758,885`, which this branch moved to 798 and 938. Fixed by symbol
under an owner-approved second surface amendment.

## The operator-facing runbook

`docs/runbooks/beta-launch-alerting.md` said the ledger-dark warning fires
"whenever `REFUSAL_LEDGER_ENABLED=false` and a write is attempted", and asserted
in bold that it is the ledger's only gap detector. Guard 4 made that false for
this lane. The row now states the real trigger — "a row would have been written",
not "a write was attempted" — names the third caller, and records the one blind
spot that survives.

## Mutation evidence for the new tests, run by the root

The bounded edit lease that added the tests could not mutate production to force
its new cases red — those files were held by the root. That evidence is the
difference between an oracle and an assertion, so the root ran it directly:

| Mutant | Result |
|---|---|
| `noteRefusalLedgerDark` → no-op | **KILLS** the new latch test AND the new integration case |
| guard 4's predicate → `length > 0` (the rejected `some`-equivalent) | **KILLS** the integration case AND the property, shrinking to `[["policy_not_enabled"]]` — a lone `null`-mapped veto member, exactly the case `every` protects |

Both restored; 99/99 green across the three suites afterwards, live-DB lane
included.

## Unresolved, carried forward deliberately

- **An UNMAPPED block reason raises no operator signal on this lane while the
  flag is off.** Correct on the no-gap rule — it would have thrown rather than
  written, so no row was lost — but it leaves the #1080 fault class unsignalled.
  Recorded in the runbook and in the intake's `observability`.
- **Aborted attempts leak `api_costs` rows with a NULL `response_id`**
  (pre-existing; the cost rows are committed outside the persist transaction).
  The kill switch stops accumulation but does not reconcile what leaked.
- **`withLedgerAttribution` captures per attempt**, where `attachJobFailureSink`
  reports only on the terminal one. Intended, but it raises Sentry volume ~5× for
  a deterministic fault; an alerting threshold may not expect that.
- Red-team method note worth propagating: `mutation-runner.mjs run` needs its own
  `--test-db`; passing it only to `env` leaves the child with
  `REPWORTH_DISABLE_LIVE_DB_SUITES=1` and **all 30 live-DB cases silently skip**.
