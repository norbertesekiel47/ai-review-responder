# Handoff — feat/1088-chart-readability

Resume with `/feature-resume feat/1088-chart-readability`.

## Where this run is

**Step 3 complete, step 4 not started.** Phase `plan_approved`. No code written.
Prepared 2026-09-03.

## Read these, by path

| What | Where |
|---|---|
| Locked scope contract | `docs/superpowers/plans/feat-1088-chart-readability-intake.json` |
| Plan, with the measurement | `docs/superpowers/plans/feat-1088-chart-readability.md` |
| Decision ticket | `gh issue view 1088` |
| Build ticket | `gh issue view 1095` |

## The measurement that makes this buildable

**Four of five charts have no accessible name at all** — `VelocityChart`,
`RankingChart`, `RecentRatingBreakdown`, `RecentSentimentMix`. Only
`ReputationTrendChart` does, and it is the in-tree precedent to copy.

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
