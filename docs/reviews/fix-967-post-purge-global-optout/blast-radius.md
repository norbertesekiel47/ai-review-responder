# Blast radius — importers of changed files (`fix-967-post-purge-global-optout`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `worker/ingress/resend/solicitation-lane.ts` — 3 importer(s)
- worker/ingress/__tests__/resend-solicitation-lane.integration.test.ts
- worker/ingress/__tests__/resend-solicitation-routing.test.ts
- worker/ingress/resend.ts

## `worker/jobs/account-offboarding/purge-stages.ts` — 5 importer(s)
- src/lib/solicitation/__tests__/batch-purge-concurrency.integration.test.ts
- worker/jobs/account-offboarding/PurgeWorker.ts
- worker/jobs/account-offboarding/__tests__/analytics-scrub.integration.test.ts
- worker/jobs/account-offboarding/__tests__/approval-audit-log-scrub.integration.test.ts
- worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
