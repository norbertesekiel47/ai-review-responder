# Blast radius — importers of changed files (`feat/1009-refusal-ledger-write-path`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/lib/auto-approval/suspension.ts` — 9 importer(s)
- src/app/admin/autonomy/page.tsx
- src/app/api/admin/autonomy/suspensions/route.ts
- src/app/api/admin/autonomy/unsuspend/route.ts
- src/lib/auto-approval/__tests__/suspension.integration.test.ts
- src/lib/auto-approval/__tests__/suspension.test.ts
- worker/background/schedulers/AutonomyGovernorScheduler.ts
- worker/background/schedulers/__tests__/AutonomyGovernorScheduler.integration.test.ts
- worker/jobs/autonomy-suspended-notice/context.ts
- worker/jobs/judge/JudgeWorker.ts

## `src/lib/refusals/vocabulary.ts` — 3 importer(s)
- src/lib/auto-approval/suspension.ts
- src/lib/refusals/__tests__/vocabulary.test.ts
- src/lib/refusals/write.ts

## `src/lib/refusals/write.ts` — 3 importer(s)
- src/lib/auto-approval/suspension.ts
- src/lib/refusals/__tests__/write.integration.test.ts
- src/lib/refusals/__tests__/write.test.ts

## `worker/background/pollers/ArchivalPoller.ts` — 3 importer(s)
- worker/background/pollers/__tests__/ArchivalPoller.integration.test.ts
- worker/background/pollers/__tests__/ArchivalPoller.test.ts
- worker/index.ts

## `worker/background/schedulers/AutonomyGovernorScheduler.ts` — 3 importer(s)
- worker/background/schedulers/__tests__/AutonomyGovernorScheduler.integration.test.ts
- worker/background/schedulers/__tests__/AutonomyGovernorScheduler.test.ts
- worker/index.ts
