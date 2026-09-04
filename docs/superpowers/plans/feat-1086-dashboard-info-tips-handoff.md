# Handoff — feat/1086-dashboard-info-tips

Resume with `/feature-resume feat/1086-dashboard-info-tips`.

## Where this run is

**Step 4 complete — T1 through T5 built. Next is the verify gate (step 6),
then the review wave (step 7), then the red-team pass (step 7.5).** Phase
`executing`. Updated 2026-09-03.

Three commits carry the work: the primitive and its first three placements, the
remaining placements, and the docs. Five tips across four surfaces; two of the
six planned surfaces deliberately carry none, each pinned by a test.

`allowed_edit_surface` was amended **once**, with owner approval, to admit six
existing dashboard test files. `feature-state.sh` will now REFUSE a second
amendment without an explicit reason — do not work around that, re-plan.

## Read these, by path

| What | Where |
|---|---|
| Locked scope contract | `docs/superpowers/plans/feat-1086-dashboard-info-tips-intake.json` |
| Plan, and the four assumptions | `docs/superpowers/plans/feat-1086-dashboard-info-tips.md` |
| **Every departure, with its reason** | `docs/superpowers/plans/feat-1086-dashboard-info-tips-deviations.md` |
| Decision ticket | `gh issue view 1086` |
| Build ticket | `gh issue view 1094` |

## Two things a reviewer will reach for, and the answers

**"Why not `useMenuPopover`?"** Deviation D1. The short form: that hook
preventDefaults Arrow/Home/End before it checks whether a `menuitem` exists, and
a tip has none. A test named "does not swallow arrow keys while it is open"
pins it.

**"Why do two surfaces have no tip?"** Deviation D4. Assumption 4. Both
omissions are pinned by their own test.

## The one thing that decides the design

**There is no tooltip primitive in this repo**, and **hover does not exist on a
phone** — the Console hides `.sidebar` below 768px. Any design that assumes a
mouse is wrong before it is written.

## Do this first

T3 exists so the owner sees three placements at 390px and 1440px before the
remaining ones are built. Show them, then continue — do not build all six and
then ask.

## Assumptions to confirm or overrule

Four, in the plan. The most consequential is #4: a tip is warranted only when a
better LABEL would not do. That is what turns "wherever necessary" into
something testable, and the owner has not seen it.

## Coordinate with #1088

Charts get no tips here. If that boundary moves, both intakes change.

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

## Reproduce the fallow gate properly

`pnpm test:coverage && pnpm ci:fallow:coverage` — nothing else predicts CI's
`fallow` job. A bare `fallow audit` reported clean three separate times on
feat/1090, feat/1093 and feat/1092 while CI failed.
