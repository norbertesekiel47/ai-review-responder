# Blast radius — importers of changed files (`feat-731-maintainability-bundle`)

Heuristic import-text search; verify semantic impact per caller.

## `src/lib/costs/tracker.ts` — 21 importer(s)
- src/app/(authenticated)/dashboard/reviews/history/PastRepliesClient.tsx
- src/components/dashboard/reviews/PastReplyCard.tsx
- src/lib/costs/__tests__/cost-guard.test.ts
- src/lib/costs/cost-guard.ts
- src/lib/past-replies/__tests__/load-replies.integration.test.ts
- src/lib/past-replies/__tests__/reviews-list.test.ts
- src/lib/past-replies/load-replies.ts
- src/lib/responses/__tests__/generator.test.ts
- src/lib/responses/__tests__/judge.test.ts
- src/lib/responses/__tests__/review-summary.test.ts
- src/lib/responses/generator.ts
- src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts
- src/lib/shared/__tests__/security.test.ts
- src/lib/shared/dashboard-regen-rate-limit.ts
- src/lib/solicitation/__tests__/ask-generation.integration.test.ts
- src/lib/solicitation/__tests__/ask-generation.test.ts
- src/lib/solicitation/ask-generation.ts
- worker/jobs/__tests__/ResponseGeneratorWorker.test.ts
- worker/jobs/response-generation/__tests__/generate-draft.test.ts
- worker/jobs/response-generation/generate-draft.ts
- worker/jobs/solicitation-batch/__tests__/generate.test.ts

## `src/lib/past-replies/load-replies.ts` — 3 importer(s)
- src/app/(authenticated)/dashboard/reviews/history/page.tsx
- src/lib/past-replies/__tests__/load-replies.integration.test.ts
- src/lib/past-replies/__tests__/reviews-list.test.ts

## `src/lib/past-replies/replies-view.ts` — 7 importer(s)
- src/app/(authenticated)/dashboard/reviews/history/page.tsx
- src/components/dashboard/reviews/__tests__/past-reply-card-states.test.tsx
- src/components/dashboard/reviews/PastReplyCard.tsx
- src/lib/past-replies/__tests__/load-replies.integration.test.ts
- src/lib/past-replies/__tests__/replies-view.test.ts
- src/lib/past-replies/__tests__/reviews-list.test.ts
- src/lib/past-replies/load-replies.ts

## `src/lib/shared/dashboard-regen-rate-limit.ts` — 8 importer(s)
- src/app/api/dashboard/past-replies/__tests__/draft.test.ts
- src/app/api/dashboard/past-replies/draft/route.ts
- src/app/api/dashboard/reviews/__tests__/actions.test.ts
- src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/generate-version.integration.test.ts
- src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts
- src/app/api/dashboard/reviews/[reviewId]/generate/route.ts
- src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts
- src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts

