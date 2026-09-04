# Spec & correctness review — `fix/1105-unmapped-block-reason-signal`

Base `313a3e01` → HEAD `01aa07f3`. Read-only review. Targeted suites re-run at
HEAD: `pnpm vitest run src/lib/refusals/__tests__/write.test.ts worker/jobs/response-generation/__tests__/persist.test.ts`
→ **2 files, 85 tests passed**.

## Contract checks

### 1. The 18 promised test titles

All 18 `tests_to_add` strings are present **verbatim** (machine-matched against
the two suites). Each was read for whether it asserts what its title claims:

| # | Title | Asserts its claim? |
|---|---|---|
| 1 | captures one error-level Sentry message naming every unmapped code | YES — both codes, the flag, `level: 'error'`, both tags |
| 2 | signals for the codes it is given without re-testing membership | YES — a genuinely mapped code (read off the map) still signals |
| 3 | signals once per process and stays silent on the second unmapped set | YES — two sets, one capture, plus a reset control that proves the counter can move |
| 4 | a synchronously throwing Sentry buys a cooldown rather than the latch | YES — 4 failures, boundary at `COOLDOWN-1` / `COOLDOWN`, recovery, then a `10×COOLDOWN` jump proving the latch is not time-based |
| 5 | a throwing logger does not stop … from capturing | YES |
| 6 | leaves the ledger-dark episode latch untouched | YES (one direction) |
| 7 | a prior ledger-dark warning does not suppress … | YES (the reverse direction) |
| 8 | never invokes resolvePolicyGateRefusal | YES — real helper, partial `../vocabulary` mock with a delegating spy |
| 9 | emits one structured logger line naming every unmapped code and the flag | YES — two calls/two sets, one line, one capture, and the suppressed code asserted absent |
| 10 | with the ledger off, an inherited object key is treated as unmapped | YES — `['toString']` through the lane; kills an `in`-based predicate |
| 11 | ignores an empty block-reason set | YES |
| 12 | preserves unmapped codes in input order | YES — `['zeta','alpha','zeta']`, exact substring; kills sort AND dedupe |
| 13 | simultaneously throwing logger and Sentry … do not escape | YES |
| 14 | ledger off, unmapped → vocabulary hole, no ledger-dark | YES (arg asserted; but see F1/F2) |
| 15 | ledger off, fully mapped → ledger-dark, no vocabulary hole | YES |
| 16 | ledger off, veto-only → neither | YES |
| 17 | ledger off, mixed → vocabulary hole only | PARTIAL — count only, no argument assertion (F2) |
| 18 | ledger on, unmapped → no vocabulary-hole signal | YES — and pins that the #1079 throw still propagates |

The two suites' filter helpers (`ledgerWarnings()` on `refusal ledger disabled`,
`unmappedSignals()` on `refusal ledger vocabulary hole`) are genuinely disjoint
against the two shipped message strings, so neither signal can satisfy an
assertion about the other. Plan round-2 correction 1 (two calls in case 9) and
correction 2 (repeated code in case 12) both landed as specified.

### 2. Mutual exclusivity — verified from the predicates, not the prose

`worker/jobs/response-generation/persist.ts:747-753`
```
wouldRecordRefusal = blockReasons.length > 0
  && blockReasons.every(c => Object.hasOwn(MAP, c) && MAP[c] !== null)
```
`worker/jobs/response-generation/persist.ts:790-794`
```
unmappedBlockReasons = blockReasons.filter(c => !Object.hasOwn(MAP, c))
```
`unmappedBlockReasons(S).length > 0` ⟺ ∃c∈S with `!Object.hasOwn(MAP,c)` ⟹ the
`every` callback is false for that c ⟹ `wouldRecordRefusal(S)` is false. There is
no set for which both hold. **Exclusivity confirmed by construction**; the two
independent `if`s (D4, no `else`) are correct and the docblock claim is true.

### 3. Guard 4 containment — traced, not trusted

`persist.ts:959-960` off-arm, in order:
1. `unmappedBlockReasons(autoDecision.blockReasons)` — `Array.prototype.filter` +
   `Object.hasOwn`. Neither can throw on a `readonly string[]`. No resolver call.
2. `noteUnmappedBlockReasons(unmapped)` — module-level boolean/number reads,
   `Array.prototype.join`, then two independent `try/catch` blocks around
   `logger.warn` and `Sentry.captureMessage`. Nothing outside a `try` can throw.
   No import of, or reference to, `resolvePolicyGateRefusal` anywhere in
   `src/lib/refusals/write.ts` (grepped).
3. `wouldRecordRefusal` / `noteRefusalLedgerDark` — unchanged.
4. `return`.

`resolvePolicyGateRefusal` remains unreachable on the off-arm. No new throw
surface. The pre-existing dependence on `autoDecision.blockReasons` being an
array is unchanged (`wouldRecordRefusal` already dereferenced it), so no
regression in ordering either. **Invariants 1, 2, 6, 7 hold.**

### 4. Latch asymmetry

Implemented as specified: `unmappedSignalledThisProcess` /
`nextUnmappedAttemptAt` (`write.ts:347,354`) are separate module state with their
own reset (`write.ts:366`), and `endDisabledEpisode` (`write.ts:378-381`) touches
only the two episode fields. `noteUnmappedBlockReasons` never reads or writes
`warnedThisEpisode`/`nextWarnAttemptAt` — invariant 3 holds by inspection.

Pinned by tests in three of four directions (cases 4, 6, 7). **The fourth — D3's
"does not clear on the enabled path" — is unasserted (F3).**

### 5. Non-goals

| Non-goal | Status |
|---|---|
| Restraint tab / read path | UNTOUCHED (no `src/lib/refusals/read.ts` or `src/app/**` change) |
| `wouldRecordRefusal` | UNTOUCHED (byte-identical) |
| `noteRefusalLedgerDark` | body UNTOUCHED; docblock extended per plan T3 (sanctioned) |
| `warnLedgerDisabled`, `endDisabledEpisode`, episode latch | UNTOUCHED — the non-comment diff of `write.ts` is purely additive (verified with a comment-stripped `-U0` diff) |
| guard 4 ON arm | UNTOUCHED; case 18 pins the #1079 throw still propagates |
| `held_draft` lane, `auto-policy-downgrade.ts` | UNTOUCHED |
| widening the kill switch's containment / writing a row for an unmapped code | NOT DONE |

### 6. Allowed edit surface

Every changed path is in `allowed_edit_surface`, including
`.claude/reference/arch-review-log.md` (D8 amendment) and `docs/directory.md`.
The only untracked path is `docs/reviews/fix-1105-unmapped-block-reason-signal/`,
also listed. The two intake copies (`.feature/intake.json` and the committed
audit copy) are byte-identical after normalisation.

### 7. Edge cases

All nine intake edge cases are covered by a test except one nuance:

- Empty set → case 11 ✓ (and the call site's own `length > 0` guard).
- Every member mapped non-null → case 15 ✓.
- Veto-only → case 16 ✓.
- Mixed → case 17 ✓ (count only — F2).
- Two+ unmapped in one decision, in input order → case 12 ✓ at the helper level;
  no lane-level case carries two unmapped members (see appendix A3).
- Second different code later in the process is silent → case 3 ✓.
- Sentry throws synchronously → case 4 ✓.
- Logger throws → case 5 ✓ (and case 13 for both at once).
- Ledger on → case 18 ✓.

### 8. Blast radius

18 importers of `write.ts`, 7 of `persist.ts`, all re-checked for semantic (not
just signature) impact:

- `write.ts` change is **purely additive** — two new exports and two new module
  variables. No existing export's behaviour, signature or module state changed,
  so none of the 17 other importers can observe a difference.
- `persist.ts`'s only behavioural change is on the guard-4 off-arm, which now
  makes one extra non-throwing call when a block reason is unmapped. The four
  non-`persist.test.ts` suites that import `persist.ts`
  (`ResponseGeneratorWorker.test.ts`, `on-demand-lane.property.test.ts`,
  `content-freshness-gate.integration.test.ts`,
  `autopilot-entitlement-concurrency.integration.test.ts`) drive the REAL gate,
  whose block reasons are all members of the compiled union and therefore mapped,
  so the new arm is unreachable there — consistent with D4's reasoning for not
  adding a reset to `refusal-write.integration.test.ts`.
- The new process-lifetime latch is per-module-instance, so it cannot leak across
  vitest files.

No caller-side regression found.

## Findings

| Severity | Location | Finding |
|---|---|---|
| medium | `worker/jobs/response-generation/__tests__/persist.test.ts:1259` | The comment teaches the reverse of the shipped design: "the call site hands it everything and does not pre-filter" — `persist.ts:959` DOES pre-filter through `unmappedBlockReasons`. This is precisely the decision deviations D5 records as reversed; the comment is a survivor of the pre-reversal draft. |
| medium | `worker/jobs/response-generation/__tests__/persist.test.ts:1302-1306` | The mixed-set case asserts only the call COUNT, never the argument, so nothing in the eval pins that mapped members are excluded from the signal. A call site that handed `autoDecision.blockReasons` verbatim (the pre-D5 shape, and exactly what the neighbouring comment describes) keeps all 18 titles green while the Sentry issue and the log line name a healthy, mapped code as a vocabulary hole. |
| low | `src/lib/refusals/write.ts:378` | Plan decision D3 ("the new latch does NOT clear on the enabled path") has no oracle. No case drives an enabled `writeRefusalEvent` — the only caller of `endDisabledEpisode` — between two `noteUnmappedBlockReasons` calls, so adding `unmappedSignalledThisProcess = false` to `endDisabledEpisode` survives the whole suite. Cases 6 and 7 pin only the opposite direction (the new signal not touching the episode latch). |
| low | `docs/superpowers/plans/fix-1105-unmapped-block-reason-signal-deviations.md` (D8) | D8 states "Owner signed off." for the `arch-review-log.md` surface amendment; `.feature/state.json`'s `surfaceAmendmentLog[0].reason` records `"auto-approved (1st amendment)"`. The amendment is legitimate either way, but the deviations record claims an approval the harness log says did not happen. |

## Appendix — below the 80% confidence bar

- **A1.** `persist.ts:960` guards with `if (unmapped.length > 0)` while
  `noteUnmappedBlockReasons` (`write.ts:508`) also returns on an empty list.
  Two owners of the same precondition. Harmless, and case 11 requires the
  helper's copy, so neither can simply be deleted — noting only that a future
  reader may take the call-site guard as load-bearing.
- **A2.** The Sentry message hard-codes `${REFUSAL_LEDGER_FLAG}=false`. True for
  the one call site; an exported helper called from an on-arm would emit a false
  statement. Not a defect today.
- **A3.** No lane-level case carries two unmapped members. The filter preserves
  order trivially and case 12 owns the ordering claim at the helper level, so
  the gap is theoretical.
- **A4.** `write.ts:507-508` tests the latch/cooldown BEFORE the empty check, so
  an empty call during a cooldown short-circuits on the wrong branch. No
  observable difference.
- **A5.** `noteUnmappedBlockReasons` takes `readonly string[]` where plan T2
  specified `readonly AutoApprovalBlockReason[]`. Correct under D5's reversal (an
  already-unmapped code is by definition outside the union), but the deviations
  file does not record the signature change with the reversal.
- **A6.** Comment-to-code ratio on the production diff (D7: ~5:1) is out of scope
  for this axis and is routed to the standards axis by D7 itself.

## VERDICT

The change implements the goal, honours all seven invariants and all five
non-goals, stays inside the allowed edit surface, and the two signals are
provably mutually exclusive. Guard 4's containment by non-execution is intact.
Two medium findings are both about the eval's grip on the D5 reversal — a stale
comment that documents the reverted design, and the one lane case that would not
notice if the reverted design came back.
