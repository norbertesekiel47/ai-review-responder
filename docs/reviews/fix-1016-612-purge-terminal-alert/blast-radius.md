# Blast radius — importers of changed files (`fix/1016-612-purge-terminal-alert`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `worker/jobs/account-offboarding/purge-stages.ts` — 9 importer(s)
- src/lib/account-offboarding/__tests__/purge-verification.test.ts
- src/lib/agents/operator/__tests__/turn-worker.integration.test.ts
- src/lib/solicitation/__tests__/batch-purge-concurrency.integration.test.ts
- worker/jobs/account-offboarding/PurgeWorker.ts
- worker/jobs/account-offboarding/__tests__/analytics-scrub.integration.test.ts
- worker/jobs/account-offboarding/__tests__/approval-audit-log-scrub.integration.test.ts
- worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
- worker/jobs/account-offboarding/__tests__/stripe-customer-redaction-guard.integration.test.ts
- worker/jobs/account-offboarding/__tests__/stripe-customer-redaction-stage.test.ts

## `worker/jobs/account-offboarding/PurgeWorker.ts` — 3 importer(s)
- worker/index.ts
- worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts
- worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
