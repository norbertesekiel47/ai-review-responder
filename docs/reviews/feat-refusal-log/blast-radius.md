# Blast radius — importers of changed files (`feat/refusal-log`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/app/(authenticated)/dashboard/analytics/restraint/page.tsx` — 0 importer(s)
_none found (entry point, or dynamic/config-driven usage — check registration sites)_

## `src/app/api/dashboard/refusals/route.ts` — 1 importer(s)
- src/app/api/dashboard/__tests__/refusals-route.test.ts

## `src/components/dashboard/analytics/AnalyticsAggregateView.tsx` — 1 importer(s)
- src/components/dashboard/analytics/AnalyticsContent.tsx

## `src/components/dashboard/analytics/AnalyticsPerLocationView.tsx` — 1 importer(s)
- src/components/dashboard/analytics/AnalyticsContent.tsx

## `src/components/dashboard/analytics/AnalyticsTabs.tsx` — 4 importer(s)
- src/components/dashboard/analytics/AnalyticsAggregateView.tsx
- src/components/dashboard/analytics/AnalyticsPerLocationView.tsx
- src/components/dashboard/analytics/__tests__/AnalyticsTabs.test.tsx
- src/components/dashboard/restraint/RestraintContent.tsx

## `src/components/dashboard/restraint/RestraintContent.tsx` — 2 importer(s)
- src/app/(authenticated)/dashboard/analytics/restraint/page.tsx
- src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx

## `src/components/dashboard/restraint/RestraintReport.tsx` — 2 importer(s)
- src/components/dashboard/restraint/RestraintContent.tsx
- src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx

## `src/lib/agents/read.ts` — 15 importer(s)
- src/app/api/dashboard/agent-team/route.ts
- src/app/api/dashboard/reviews/[reviewId]/timeline/route.ts
- src/components/dashboard/timeline/RunStateBadge.tsx
- src/components/dashboard/timeline/RunTimeline.tsx
- src/components/dashboard/timeline/TimelineContent.tsx
- src/components/dashboard/timeline/TimelineEscalationActions.tsx
- src/components/dashboard/timeline/TimelineStepRow.tsx
- src/components/dashboard/timeline/__tests__/TimelineContent.test.tsx
- src/lib/agents/__tests__/read.integration.test.ts
- src/lib/agents/__tests__/read.test.ts
- src/lib/refusals/__tests__/read.test.ts
- src/lib/refusals/read.ts
- src/lib/solicitation/__tests__/release.integration.test.ts
- worker/background/pollers/health-alert/__tests__/checks.test.ts
- worker/background/pollers/health-alert/checks.ts

## `src/lib/refusals/read.ts` — 7 importer(s)
- src/app/api/dashboard/__tests__/refusals-route.test.ts
- src/app/api/dashboard/refusals/route.ts
- src/components/dashboard/restraint/RestraintContent.tsx
- src/components/dashboard/restraint/RestraintReport.tsx
- src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx
- src/lib/refusals/__tests__/read.integration.test.ts
- src/lib/refusals/__tests__/read.test.ts

## `src/lib/refusals/vocabulary.ts` — 6 importer(s)
- src/components/dashboard/restraint/RestraintContent.tsx
- src/components/dashboard/restraint/RestraintReport.tsx
- src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx
- src/lib/refusals/__tests__/read.test.ts
- src/lib/refusals/__tests__/vocabulary.test.ts
- src/lib/refusals/read.ts
