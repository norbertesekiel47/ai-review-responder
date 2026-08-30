# Blast radius — importers of changed files (`feat/1008-migration-116-refusal-events`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/lib/account-offboarding/purge-verification.ts` — 4 importer(s)
- src/lib/account-offboarding/__tests__/purge-verification.test.ts
- worker/jobs/account-offboarding/__tests__/approval-audit-log-scrub.integration.test.ts
- worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
- worker/jobs/account-offboarding/purge-stages.ts

## `src/lib/account-offboarding/table-disposition.ts` — 4 importer(s)
- src/lib/account-offboarding/__tests__/purge-verification.test.ts
- src/lib/account-offboarding/__tests__/table-disposition.test.ts
- src/lib/account-offboarding/purge-verification.ts
- src/lib/shared/__tests__/migration-098-suppression-corrections.integration.test.ts

## `worker/jobs/account-offboarding/purge-stages.ts` — 5 importer(s)
- src/lib/solicitation/__tests__/batch-purge-concurrency.integration.test.ts
- worker/jobs/account-offboarding/PurgeWorker.ts
- worker/jobs/account-offboarding/__tests__/analytics-scrub.integration.test.ts
- worker/jobs/account-offboarding/__tests__/approval-audit-log-scrub.integration.test.ts
- worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
