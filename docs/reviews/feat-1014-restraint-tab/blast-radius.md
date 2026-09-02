# Blast radius — importers of changed files (`feat/1014-restraint-tab`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/app/(authenticated)/dashboard/analytics/restraint/page.tsx` — 0 importer(s)
_none found (entry point, or dynamic/config-driven usage — check registration sites)_

## `src/app/api/dashboard/refusals/route.ts` — 1 importer(s)
- src/app/api/dashboard/__tests__/refusals-route.test.ts

## `src/components/dashboard/analytics/AnalyticsAggregateView.tsx` — 1 importer(s)
- src/components/dashboard/analytics/AnalyticsContent.tsx

## `src/components/dashboard/analytics/AnalyticsContent.tsx` — 2 importer(s)
- src/app/(authenticated)/dashboard/analytics/page.tsx
- src/components/dashboard/analytics/__tests__/AnalyticsContent.test.tsx

## `src/components/dashboard/analytics/AnalyticsPerLocationView.tsx` — 1 importer(s)
- src/components/dashboard/analytics/AnalyticsContent.tsx

## `src/components/dashboard/analytics/AnalyticsTabs.tsx` — 5 importer(s)
- src/components/dashboard/analytics/AnalyticsAggregateView.tsx
- src/components/dashboard/analytics/AnalyticsContent.tsx
- src/components/dashboard/analytics/AnalyticsPerLocationView.tsx
- src/components/dashboard/analytics/__tests__/AnalyticsTabs.test.tsx
- src/components/dashboard/restraint/RestraintContent.tsx

## `src/components/dashboard/restraint/RestraintContent.tsx` — 2 importer(s)
- src/app/(authenticated)/dashboard/analytics/restraint/page.tsx
- src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx

## `src/components/dashboard/restraint/RestraintReport.tsx` — 2 importer(s)
- src/components/dashboard/restraint/RestraintContent.tsx
- src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx

## `src/components/dashboard/shell/DashboardStatePanel.tsx` — 4 importer(s)
- src/components/dashboard/analytics/AnalyticsContent.tsx
- src/components/dashboard/restraint/RestraintContent.tsx
- src/components/dashboard/reviews/ReviewsContent.tsx
- src/components/dashboard/shell/__tests__/DashboardStatePanel.test.tsx

## `src/lib/refusals/read.ts` — 6 importer(s)
- src/app/api/dashboard/__tests__/refusals-route.test.ts
- src/app/api/dashboard/refusals/route.ts
- src/components/dashboard/restraint/RestraintReport.tsx
- src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx
- src/lib/refusals/__tests__/read.integration.test.ts
- src/lib/refusals/__tests__/read.test.ts
