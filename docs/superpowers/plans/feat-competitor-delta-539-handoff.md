# Feature Handoff: Competitor Delta Line (#539)

## Current checkpoint

- Branch: `feat/competitor-delta-539`
- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-competitor-delta-539`
- Phase: `plan_approved`
- Enforcement: armed; edit-surface and stop-gate probes both returned the required exit code 2 after plan sign-off.
- Plan review: adversarial round 1 `REVISE`; round 2 `APPROVED`.

## Read in this order

1. Intake/drift contract:
   `docs/superpowers/plans/feat-competitor-delta-539-intake.json`
2. Approved implementation plan:
   `docs/superpowers/plans/2026-07-24-competitor-delta-539.md`
3. Domain glossary:
   `CONTEXT.md`, section `Competitor Delta`
4. Issue sources:
   GitHub tickets `#539`, `#532`, and wayfinder map `#528`
5. Shipped persistence precedent:
   `supabase/migrations/084_competitor_snapshots.sql`,
   `supabase/migrations/085_competitor_rating_numeric.sql`, and ticket `#538`
6. Deviations:
   `docs/superpowers/plans/feat-competitor-delta-539-deviations.md` if created

## Execution boundary

Execute the plan's single TDD tracer through the existing public seams:
`handleWeeklySummary` and `buildWeeklyValueReportHtml`. Do not introduce a new
module, dependency, schema/flag change, scheduler change, external call, or
Named rival persistence. Ticket #546 remains the owner-pick integration.

After the first delegated task, compare every changed path with
`allowed_edit_surface` before any further execution.
