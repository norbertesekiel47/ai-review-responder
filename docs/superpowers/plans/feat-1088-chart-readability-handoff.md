# Handoff — feat/1088-chart-readability

Resume with `/feature-resume feat/1088-chart-readability`.

## Where this run is

**Step 4, tracer T1 (eval tests) dispatched.** Phase `executing`. No production
code written. Prepared 2026-09-03; resumed and corrected 2026-09-04.

Rebased onto `origin/main` at `dec98bab` while still at `plan_approved`, so both
#1087 and #1086 are taken and the `console.css` overlap closed at zero cost.

## Read these, by path

| What | Where |
|---|---|
| Locked scope contract | `docs/superpowers/plans/feat-1088-chart-readability-intake.json` |
| Plan, with the CORRECTED measurement | `docs/superpowers/plans/feat-1088-chart-readability.md` |
| **Why the original measurement was wrong** | `docs/superpowers/plans/feat-1088-chart-readability-deviations.md` |
| Decision ticket | `gh issue view 1088` |
| Build ticket | `gh issue view 1095` |

## The measurement — CORRECTED 2026-09-04. Do not trust the old one.

> This section previously read: *"Four of five charts have no accessible name at
> all."* **That was false**, and it was the ticket's whole justification. The
> grep behind it searched `aria-label`, `role="img"` and `<title>`, and missed
> the `sr-only` table pattern two of the charts use.

**Every one of the five charts is already reachable by a screen reader.**
`VelocityChart` (L76) and `RankingChart` (L72) each render an `sr-only`
`<table>` with a `<caption>` and mark the SVG `aria-hidden="true"` — exposing
the FULL data series, which is stronger than the `aria-label` summary the plan
first proposed to copy onto them. `ReputationTrendChart` (L91) uses
`role="img"` + `aria-label`. The two `Recent*` charts label every row (L40, L55)
but carry no chart-level name.

`.sr-only` is Tailwind v4's built-in visually-hidden utility (`globals.css:1`).

**Tracer T2 as originally written had no work in it and is replaced.** The gap
is not silence — it is that the charts give numbers with no unit and no period.
Six gaps (G1–G6) replace the false one; the plan table cites each to a line.

The intake is NOT amended: every `goal` line, `user_visible_behavior` line and
invariant survived. Deviations entry, not a surface amendment.

## The empty-series edge case was re-pointed

Owner ruled 2026-09-04: both `Recent*` charts keep `return null` at `total === 0`
— deliberate, so the caller drops the slot cleanly. The intake edge case now
targets `ReputationTrendChart`, whose empty state (L82) names neither its unit
nor its window. The promised-test title is UNCHANGED — the gate matches the
exact string, and retitling would trade a real check for a green row.

## The line not to cross

This is **presentation only**. `src/lib/kpi/fragments.ts` owns the bucketing
(ADR 0019 / #688 / #757) and is deliberately OUTSIDE the edit surface. A chart
that is wrong because it buckets wrongly is a separate `RISK=high` ticket — do
not fix it quietly here.

## Do this first

T4 shows the owner ONE reworked chart at 390px and 1440px before the rest are
touched. Five charts redesigned before anyone has reacted is the failure mode
this ordering exists to prevent.

## Coordinate with #1086

Charts take NO info tips. A missing unit is a LABEL fix and belongs here. If
that boundary moves, both intakes change.

## The guard says ARMED. Verify that it binds.

`scripts/arm-check.sh` reports ARMED and is telling the truth — the hook IS
registered. But `.claude/hooks/edit-surface-guard.sh` is a **PreToolUse hook on
`Edit` / `Write` / `MultiEdit`**, and its own header names the gap:

> Known gap (inherent to PreToolUse): file changes made through Bash … routing
> repo edits through Bash during a feature run.

A session whose output mode routes file changes through **Bash** bypasses the
guard entirely. On feat/1092 three files landed outside the declared surface and
nothing stopped them. If that is this session, **enforce the surface by hand**:
diff every commit's `--name-only` against `allowed_edit_surface` before
committing, and handle `->` rename entries on BOTH sides.

**Confirmed on 2026-09-04: this warning fired.** The resuming session ran under
an output style that instructs file changes through Bash — exactly the bypass
described above. The project rule in
`.agents/skills/feature/references/working-rules.md` § Worktree path discipline
("No bash writes to repo files") **overrides the output style**, and the session
routed every repo edit through Write/Edit so the guard bound. Any future session
resuming this branch must make the same call, and say so out loud when it does.

## Reproduce the fallow gate properly

`pnpm test:coverage && pnpm ci:fallow:coverage` — nothing else predicts CI's
`fallow` job. A bare `fallow audit` reported clean three separate times on
feat/1090, feat/1093 and feat/1092 while CI failed.
