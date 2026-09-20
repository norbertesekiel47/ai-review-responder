# Blast radius — importers of changed files (`fix/1361-locations-route-fault-status`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/lib/approval/http-routes.ts` — 13 importer(s)
- src/app/api/approve/[token]/approve/route.ts
- src/app/api/approve/[token]/edit/route.ts
- src/app/api/approve/[token]/regenerate/route.ts
- src/app/api/approve/[token]/session/route.ts
- src/app/api/approve/[token]/veto/route.ts
- src/app/api/dashboard/reviews/[reviewId]/approve/route.ts
- src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts
- src/app/api/dashboard/reviews/[reviewId]/edit/route.ts
- src/app/api/dashboard/reviews/[reviewId]/generate/route.ts
- src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts
- src/app/api/dashboard/reviews/[reviewId]/timeline/route.ts
- src/lib/approval/__tests__/http-routes.test.ts
- src/lib/escalations/http-routes.ts

## `src/lib/locations/owner-route.ts` — 6 importer(s)
- src/app/api/locations/add/route.ts
- src/app/api/locations/archive/route.ts
- src/app/api/locations/promote-primary/route.ts
- src/app/api/locations/reactivate/route.ts
- src/app/api/settings/voice/report-card/route.ts
- src/lib/locations/__tests__/owner-route.test.ts
