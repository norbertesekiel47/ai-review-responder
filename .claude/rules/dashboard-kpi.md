---
paths:
  - "src/lib/dashboard/**"
  - "src/lib/kpi/**"
  - "src/app/api/dashboard/route.ts"
---

# Dashboard and KPI rules

## Read first

- ADR `docs/adr/0019-kpi-review-time-anchor.md` (the Review-time anchor) and the fragments' single owner `src/lib/kpi/fragments.ts`.
- File map: `docs/directory/lib-dashboard-locations-accounts.md` § `dashboard/`; `docs/directory/lib-platform.md` § `kpi/`.
- `ci:pool-fanout` (`.claude/CLAUDE.md` § Dev commands) fails any `Promise` combinator over ≥2 DB-issuing elements in `src/lib/{admin,dashboard,locations}` — sequence dashboard reads.
- Skill `repworth-brand-design` for any dashboard UI; every chart states what it plots, in what unit, over what window (#1088).

## Traps

- No trap clauses were moved from `.claude/CLAUDE.md`; the anchoring rules in the moved KPI bullet below are the traps (reputation metrics on the Review-time anchor, workflow metrics on `detected_at`, timeSaved on `approved_at`).

## Rules

- **Customer KPIs**: the dashboard payload (`src/lib/dashboard/*`) is the ONE KPI stack — per-location `getActiveDashboardData` and per-account `fetchPerLocationAggregateSlices`, served by `GET /api/dashboard`. Reputation metrics bucket on the **Review-time anchor** `LEAST(review_date, detected_at)` via the single-owner fragments in `src/lib/kpi/fragments.ts` (#688/#757, ADR 0019): velocity, rating breakdown, avg star and sentiment trend per-location; velocity and rating breakdown in the aggregate. Workflow metrics stay on `detected_at` (response rate, the aggregate `windowedReceived`/`windowedResponded` counters), timeSaved keys on `approved_at`, and the recent-review feed orders on `detected_at`. `src/lib/kpi/` holds only the window vocabulary (`types.ts`) and those fragments — the consumer-less `getLocationKpiSummary`/`getAccountKpiSummary` and their dedicated KPI route were deleted in #757.
