# Blast radius — importers of changed files (`feat/1010-refusal-solicitation-singles`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/lib/refusals/write.ts` — 6 importer(s)
- src/lib/auto-approval/suspension.ts
- src/lib/refusals/__tests__/write.integration.test.ts
- src/lib/refusals/__tests__/write.test.ts
- src/lib/solicitation/approval.ts
- src/lib/solicitation/batch-builder.ts
- src/lib/solicitation/dispatch.ts

## `src/lib/solicitation/approval.ts` — 15 importer(s)
- src/app/(authenticated)/dashboard/requests/lane-writes.ts
- src/app/admin/businesses/[id]/_components/SolicitationBatchPanel.tsx
- src/app/api/admin/solicitation/batch/halt/route.ts
- src/app/api/dashboard/solicitation/batch/approve/route.ts
- src/app/api/dashboard/solicitation/batch/halt/route.ts
- src/app/api/dashboard/solicitation/batch/regenerate/route.ts
- src/app/api/dashboard/solicitation/batch/withdraw/route.ts
- src/lib/refusals/vocabulary.ts
- src/lib/solicitation/__tests__/approval-system-halt.integration.test.ts
- src/lib/solicitation/__tests__/approval.integration.test.ts
- src/lib/solicitation/__tests__/approval.test.ts
- src/lib/solicitation/__tests__/ask-generation.integration.test.ts
- src/lib/solicitation/__tests__/auto-approval.integration.test.ts
- src/lib/solicitation/__tests__/dispatch.integration.test.ts
- src/lib/solicitation/release.ts

## `src/lib/solicitation/batch-builder.ts` — 14 importer(s)
- src/lib/solicitation/__tests__/approval.integration.test.ts
- src/lib/solicitation/__tests__/auto-approval.integration.test.ts
- src/lib/solicitation/__tests__/batch-builder.integration.test.ts
- src/lib/solicitation/__tests__/batch-builder.test.ts
- src/lib/solicitation/__tests__/batch-purge-concurrency.integration.test.ts
- src/lib/solicitation/__tests__/dispatch.integration.test.ts
- src/lib/solicitation/approval.ts
- src/lib/solicitation/ask-generation.ts
- src/lib/solicitation/attribution.ts
- src/lib/solicitation/dispatch.ts
- worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
- worker/jobs/account-offboarding/purge-stages.ts
- worker/jobs/solicitation-batch/index.ts
- worker/jobs/solicitation-send/failed-hook.ts

## `src/lib/solicitation/dispatch.ts` — 5 importer(s)
- src/lib/refusals/vocabulary.ts
- src/lib/solicitation/__tests__/dispatch-gate.test.ts
- src/lib/solicitation/__tests__/dispatch.integration.test.ts
- src/lib/solicitation/__tests__/dispatch.test.ts
- worker/jobs/solicitation-send.ts
