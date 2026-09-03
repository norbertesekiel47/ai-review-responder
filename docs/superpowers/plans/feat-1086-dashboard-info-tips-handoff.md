# Handoff — feat/1086-dashboard-info-tips

Resume with `/feature-resume feat/1086-dashboard-info-tips`.

## Where this run is

**Step 3 complete, step 4 not started.** Phase `plan_approved`. No code written.
Prepared 2026-09-03.

## Read these, by path

| What | Where |
|---|---|
| Locked scope contract | `docs/superpowers/plans/feat-1086-dashboard-info-tips-intake.json` |
| Plan, and the four assumptions | `docs/superpowers/plans/feat-1086-dashboard-info-tips.md` |
| Decision ticket | `gh issue view 1086` |
| Build ticket | `gh issue view 1094` |

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
