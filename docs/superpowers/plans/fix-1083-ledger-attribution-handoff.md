# Handoff — fix/1083-ledger-attribution

Written at the step 3 → 4 boundary. Everything below is a POINTER. Nothing here
restates a decision; read the referenced file.

## Where to start

| Read | Path |
|---|---|
| Ticket | [#1083](https://github.com/RepWorth/ai-review-responder/issues/1083) |
| Locked intake | `docs/superpowers/plans/fix-1083-ledger-attribution-intake.json` |
| Approved plan | `docs/superpowers/plans/fix-1083-ledger-attribution.md` |
| Deviations (D1–D3, all ACCEPT) | `docs/superpowers/plans/fix-1083-ledger-attribution-deviations.md` |
| Machine state | `.feature/state.json`, `.feature/progress.json` |
| Glossary terms this run touches | `CONTEXT.md` § Refusal ledger — **Refusal**, **Refusal source**, **Refusal category**, **Restraint tab** (all LOCKED) |
| The term this run coins | **Ledger attribution** — T5 adds it to `CONTEXT.md` |
| Ledger folder rules | `docs/directory.md` § `refusals/` |
| Owner-safe projection | `docs/adr/0023-refusal-log-owner-safe-projection.md` |

## State

- Branch `fix/1083-ledger-attribution`, worktree
  `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-1083-ledger-attribution`
- Base `2be0c3236d3251682ef7342aca65deed958cc692`
- Phase `plan_approved`. Plan review rounds: **3 of 3, closed APPROVED**.
- Surface amendments: **0**. Gate rounds: **0**.
- Enforcement ARMED (edit-surface guard + stop gate).

## Codex session

Round 1 cold, rounds 2 and 3 resumed from it:
`01a06c0a-8277-7820-86a2-68338d94d8b9`

Resume it only for a further **verification** round. Never for an independent
axis — a resumed session is anchored on its own conclusions.

Round transcripts: `.feature/plan-round-{1,2,3}-output.txt` (untracked scratch).
The durable record is the plan's **Review appendix**.

## What step 4 executes

Six tracers, registered in `.feature/progress.json`. T2 and T3 both edit
`src/lib/refusals/write.ts`, so they are **serial**, not parallel. T4 follows
T2. T6 is orchestrator work, not a subagent task.

The eval is sixteen titles in the intake's `tests_to_add`, split twelve
(`write.test.ts`) / four (`persist.test.ts`). Titles are matched **verbatim** by
the `promised-tests` gate row, and none contains an apostrophe (#1108).

## The three traps most likely to be re-broken

1. **The set-arm guard starts at the row map (`write.ts:904`), not the INSERT
   (`write.ts:925`).** Round 1 F2. `toISOString()` at `:922` throws on a
   type-valid `new Date(NaN)`.
2. **Do not hoist `uuidv7()` above the `try` in the single-row arm.** It is a
   tagged-template interpolation at `write.ts:791`, so it already evaluates
   inside the guard. Round 2 R2-c added the test that catches the hoist.
3. **`endDisabledEpisode()` stays outside both guards.** It is not a write and
   must not report as one.

## Cost read-back

Pending. Run `node .agents/skills/feature/scripts/phase-cost.mjs` at step 8 and
paste the table below.
