# Plan review round 3 — triage verdicts (#656)

Full report: `plan-review-round3-codex.md`. Verdict: **REVISE**.
Reviewer: `codex exec`, read-only sandbox, **verification-only** brief.
**Round 3 of max 3 — the CAP.** `planReviewRounds=3`.

## Outcome in one line

Round 3 found **no defect in the design, no missing test, no false citation, and
no unaddressed round-2 disposition of substance**. Both items it raised are
wording, both are accepted, and both are fixed. The plan did not change shape.

## Round-2 disposition verification

| Item | Round-3 status | Triage |
|---|---|---|
| d2 — offboarding block | ADDRESSED | Verified placement: scope at plan `:624`, gate at `:636-639`, body parse only at `:641`. The false "subscription gate covers offboarding" claim is gone. |
| d3 — third broken fixture | ADDRESSED | **Plus a useful confirmation we did not have:** the reviewer enumerated every flag-on/send-positive path and found exactly two — the unit enqueue case (`batch-builder.test.ts:662`) and the integration case (`:508`) — both covered by T6 Step 5 items 2 and 3. The third flag-on unit case (`batch-builder.test.ts:618`) has **zero sends**, so the new gate is never evaluated there. **No fourth fixture breaks.** |
| d4 — `convert_to` volatility | ADDRESSED | Independently re-confirmed against PG16's catalog (`convert_to` `s`; `encode`, `sha256` `i`) — matching our own `pg_proc` probe. |
| f10 — non-blocking pre-flight | ADDRESSED | The reviewer **executed** both simulated failure modes and the valid state: exit 1, exit 1, exit 0. |
| d1 — narrowed digest guarantee | **PARTIALLY ADDRESSED** | **ACCEPT.** Three of four statement sites were narrowed (Architecture `:7`, Glossary `:34`, Design decisions #1 `:43-46`); the **T2 migration comment** still opened "The attestation covers THESE BYTES", which over-reads in exactly the way the owner decision forbids. A migration comment is read by every future schema author, so this is the one site where the loose phrasing would have done the most damage. Rewritten to state what the CHECK binds *and* what it does not, citing the owner decision. |

## Intake v3 consistency

Six of seven checks PASS on the reviewer's own mechanical count: 47 `tests_to_add`
entries; `allowed_edit_surface` unchanged at 20 globs (confirmed unchanged from
`70274f79`); all 47 titles verbatim in the plan; per-suite table sums to 47; route
suite listed as 9; the offboarding title wired through intake `:103` → plan `:256`,
`:636-652`.

## Defects introduced by a fix

| # | Sev | Verdict | Note |
|---|---|---|---|
| 1 | Low | **ACCEPT (my brief's fault, not a real stale count)** | The remaining `46` was in "v2 had 46; round 2 added the offboarding refusal" — accurate *history*, not a stale count. But my round-3 brief said "no surviving `46` anywhere in the plan", which is over-literal, and a numeral that reads as a live count in a document whose live count is 47 is a genuine trip hazard. Reworded to "v2 promised one fewer", which keeps the history and removes the ambiguity. |

## Cap reached — what happens next

`planReviewRounds=3` is the cap and the verdict is REVISE, so under feature.md's
round-3 rule on a `RISK=high` branch this **escalates to the owner** rather than
being decided by the runner.

The escalation is deliberately narrow: there is **no disagreement to resolve**.
Both round-3 items were accepted and applied; nothing was rejected on scope or on
merit. The only open question is procedural — whether the applied fixes are
sufficient to treat the plan as approved, or whether a fourth round (outside the
cap) should confirm them.
