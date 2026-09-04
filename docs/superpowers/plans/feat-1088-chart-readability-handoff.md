# Handoff — feat/1088-chart-readability

Resume with `/feature-resume feat/1088-chart-readability`.

> **This file was stale for the whole of T2–T6, and review F9 caught it.** It
> still said "T1 done — 1 of 6 tracers", "no production code yet" and "four are
> `it.fails`", none of which had been true for six commits, and it pinned a
> phase SHA that two rebases had left off the branch. It is rewritten to HEAD
> below. **The deviations file is the authoritative record** — it was kept
> current throughout. If the two ever disagree again, believe the deviations
> file and fix this one.

## Where this run is

**Step 6 done — all six tracers complete, review round 1 triaged and fixed.**
Execution is finished. What remains is the post-fix gate, the review gate, the
status check (it prints WAIVED) and the `reviewed` transition.

Read `docs/superpowers/plans/feat-1088-chart-readability-deviations.md` before
anything else. It carries the corrected measurement, every tracer's decisions,
the owner rulings and the full review-round record.

## What shipped

| Tracer | What it did |
|---|---|
| T1 | The five promised tests, four red on purpose |
| T2 | Every chart states its window where it speaks (G1, G5) |
| T3 | `VelocityAxisUnit` — the velocity y-axis names its unit (G2) |
| T4 | One reworked chart, rendered before/after at 390px and 1440px |
| T5 | Chart-level names on both `Recent*` charts (G6); one week-label owner across the velocity pair (G3); the owner-authorised `avg` overlap fix |
| T6 | Deviations + `arch-review-log.md` |

All five promised titles are plain `it(` and green. No `it.fails` remains.

## Three things a resuming session must not re-derive

1. **The ticket's original measurement was FALSE.** It claimed four of five
   charts were silent to a screen reader. Every chart already spoke. The real
   gap was the missing unit and window. Do not "restore" the aria-label work
   the plan first proposed — the deviations file explains why it was void.
2. **The line not to cross.** Presentation only. `src/lib/kpi/fragments.ts`
   owns the **Review-time anchor** (ADR 0019 / #688 / #757) and is outside the
   edit surface. A chart that buckets wrongly is a separate `RISK=high` ticket.
3. **Surface amendment 1 of 2 is SPENT** (the intake's two `__tests__`
   directory entries needed a trailing `/*`). One remains before the abort
   trigger. Do not spend it casually.

## The guard, and this session's output style

`scripts/arm-check.sh` reports ARMED and the hook IS registered. But
`.claude/hooks/edit-surface-guard.sh` is a **PreToolUse hook on
`Edit`/`Write`/`MultiEdit`**, so a session that routes file changes through
Bash bypasses it entirely.

**This session ran under exactly such an output style and made the opposite
call**, per `working-rules.md` § Worktree path discipline, which overrides the
output style. Every repo edit went through Write/Edit. That was not theoretical:
`bash-write-guard.sh` blocked a `cp` during the F1 mutation test, and the
mutation was re-run through Edit instead. **A future session resuming this
branch must make the same call, and say so out loud when it does.**

## Follow-ups recorded, not done

Five, listed at the end of the deviations file. Two matter most:

- **F2 — colour-blind readers.** The stacked velocity chart and both aggregate
  ranking views separate series by colour alone, over a ramp whose positions
  2/3/6 are the deuteranopia confusion set. `edge_cases[4]` is unmet. It needs
  its own ticket; the deferral is now recorded rather than silent.
- **F6 — G5 is only nominally closed for sighted readers.** The ranking x-axis
  draws one unthinned label per date, so at real cadence ~26 labels overlap at
  both intake widths. The fix belongs in `RankingCard`'s header, which is
  outside this edit surface.

## Reproduce the fallow gate properly

`pnpm test:coverage && pnpm ci:fallow:coverage` — nothing else predicts CI's
`fallow` job. A bare `fallow audit` reported clean three separate times on
feat/1090, feat/1093 and feat/1092 while CI failed.
