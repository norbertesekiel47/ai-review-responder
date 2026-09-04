# fix/1105 — review wave round 1, triage

Fork point `313a3e01` · HEAD reviewed `01aa07f3` · gate GREEN, 27 rows, fingerprint current.

Four axes, dispatched in one wave: spec & correctness, standards &
maintainability, adversarial approach (Codex), red team. The standards axis ran
because RISK is high, not because a diff threshold was crossed; the production
diff measured 245 changed lines.

The Codex axis was dispatched twice. Its first run was killed with no session
and no output — `codex exec` hangs reading stdin unless stdin is closed. The
second run, with `< /dev/null`, returned normally. Recorded because it also
killed plan round 1 and cost two dispatches there.

## Convergence

Three axes reached the same defect independently: the mixed-set lane case
asserts a call COUNT and never the ARGUMENT. Spec and standards found it by
reading; red team proved it by mutation, at 59/59 surviving. It is the round's
only P0 and the only finding that changes behaviour.

## Dispositions

| # | Axis | Severity | Finding | Verdict |
|---|---|---|---|---|
| 1 | red team | **P0** | `persist.ts:960` — passing `autoDecision.blockReasons` instead of `unmapped` survives 59/59. The two cases asserting the argument feed all-unmapped sets, where filtered ≡ unfiltered. | **FIX** |
| 2 | spec + standards + red team | medium/P1 | `persist.test.ts:1259` — comment says the call site "hands it everything and does not pre-filter". The opposite of HEAD. Residue of the reversed D1. | **FIX** |
| 3 | standards + red team | medium/P1 | `persist.ts:786` — credits `_PrecedenceIsTotal` with catching a missing map entry. That is the map's own `satisfies` clause (TS1360); `_PrecedenceIsTotal` catches mapped-but-unranked and fires on a map hole only as fallout. The branch's own test comment states it correctly, so docblock and suite disagree inside one diff. | **FIX** |
| 4 | red team | P1 | `docs/runbooks/beta-launch-alerting.md` — still says this lane "raises nothing" with the switch off, and scopes `subsystem:refusal_ledger` to three callers at `warning`. HEAD adds a fourth at `error`. | **FIX** — surface amendment 2, owner-approved |
| 5 | Codex | P1 | The same runbook gap from the operator-route angle: the branch creates a Sentry issue without establishing that anyone is notified or knows how to triage it. | **FIX** — merged into #4; a dedicated `fault:unmapped_block_reason` rule at `error` |
| 6 | red team | P1 | `arch-review-log.md` — "Promoted to lab notes." is false. D6 says it happens at step 8. Two changed docs contradict each other. | **FIX** |
| 7 | red team | P1 | `write.test.ts:871` — "SEVEN OF THESE THIRTEEN … THE OTHER SIX". The describe holds twelve, six review-added, after `[R1-4]` moved to `persist.test.ts` under D5. | **FIX** |
| 8 | standards | low | `arch-review-log.md` — "ABOVE this area's own 2-3:1 norm" is unsupported. Re-derived: 5.05:1 here against 7.82:1 (#1080) and 5.40:1 (#1079), the two nearest comparable fixes in this lane. 2-3:1 is the large-feature-commit figure. This branch is BELOW both neighbours. | **FIX** — my claim, and it was wrong |
| 9 | spec | low | Plan decision D3 has no oracle: adding `unmappedSignalledThisProcess = false` to `endDisabledEpisode` survives the suite. | **FIX** — one new case |
| 10 | standards | low | D5 says four lane cases "failed"; the docblocks, `directory.md` and the arch row say they "asserted a count that discriminates nothing". Incompatible accounts of one event, restated in four places. | **FIX** — one account, one owner |
| 11 | standards | low | `persist.ts:946-957` — an 11-line comment restating the enclosing docblock 65 lines above, guarding 3 executable lines. | **FIX** — trimmed |
| 12 | standards | low | `write.test.ts:84-86` — the vocabulary spy's delegating `mockImplementation` never executes; no case invokes the resolver and `write.ts` does not import it. | **FIX** — reduced to a bare `vi.fn()`, docblock corrected |
| 13 | spec | low | Deviations D8 says "Owner signed off"; `state.json` records `auto-approved (1st amendment)`. | **FIX** — both are true; the wording now says so |
| 14 | Codex | P1 | The process-wide latch: the compiler already rejects the systemic static hole, so the surviving threat is unsound runtime data, which varies per decision — the first bad value permanently hides a second, different unsafe producer. | **FIX** — owner chose the per-code bounded set. This defeats the intake's own stated justification, which is why it is not a rejection. |
| 15 | Codex | P1 | The capture message embeds the joined codes, so distinct sets, orderings and duplicates each open a separate Sentry issue group and bypass per-issue throttling. | **FIX** — owner chose a constant message with the codes in `extra` |
| 16 | red team | P2 | Sibling sweep: the exact #1105 shape has no sibling. But five map-indexing lanes keep the same fault CLASS in a different mechanism — `MAP[reason]` yields `undefined`, and with the ledger off they raise the ledger-dark warning, claiming a gap for a row migration 116 would reject, naming no code. | **RECORD, DO NOT FIX** — see below |
| 17 | red team | P2 | `[R1-7]` kills its named mutant, but case 4 also throws Sentry synchronously and would likely kill the same one. Unmeasured; case 4's mutation budget was spent. | **RECORD, DO NOT DELETE** |
| 18 | red team | P2 | The handoff doc says "Nothing implemented. T1, T2 and T3 are all open", stale at HEAD. | **FIX** |
| 19 | red team | P2 | Deviations D9 cites live-DB figures at pre-rebase `229c51ba`. Red team re-derived rather than accepting: 32/32 green at HEAD `01aa07f3`. | **FIX** — D9 now carries the post-rebase figures |
| 20 | Codex | P1 | Do not ship the runtime signal at all; the compiler already covers the class, so this is ceremony around an unreachable state. | **REJECTED** — see below |

## Rejected findings, with reasoning

### #20 — "do not ship the runtime signal"

Rejected on three grounds, and the PR description repeats them.

1. **It re-litigates a decision the owner already made.** The same objection was
   raised to the owner at grill time, in the intake's own words, and the intake
   was approved with it recorded. The GitHub issue says the same thing in its
   own text ("Lower priority now that #1080 has landed"). An axis restating a
   known, accepted trade-off is not new evidence.
2. **"Unreachable" is stronger than the evidence supports.** Red team's sibling
   sweep found five lanes carrying the same fault class through a different
   mechanism (`MAP[reason]` → `undefined`). The class is live in this codebase;
   only this particular shape is compiler-guarded.
3. **The correction it proposes is not smaller.** "Validate at the boundary that
   would create the invalid value" requires identifying a boundary that does not
   exist yet. The shipped signal costs one predicate and one transport.

### #16 — the sibling fault class

Not fixed, and the reason is scope rather than merit. The five map-indexing
lanes are a different mechanism with a different failure mode, and fixing them
is a second ticket, not a widening of this one. What was WRONG was leaving the
class unrecorded — red team's actual complaint. The architecture-log row and
`docs/directory.md` now state that the class stays open outside guard 4.

## Round 2

The fixes move HEAD, so the red-team sidecar is stale by construction. A scoped
round 2 runs against the fix hunks and their direct callers only.
