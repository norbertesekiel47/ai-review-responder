# Blast radius — importers of changed files (`feat/625-consent-ledger`)

Heuristic import-text search; verify semantic impact per caller.

## `src/lib/account-offboarding/purge-verification.ts` — 2 importer(s)
- src/lib/account-offboarding/__tests__/purge-verification.test.ts
- worker/jobs/account-offboarding/purge-stages.ts

## `src/lib/account-offboarding/table-disposition.ts` — 3 importer(s)
- src/lib/account-offboarding/__tests__/purge-verification.test.ts
- src/lib/account-offboarding/__tests__/table-disposition.test.ts
- src/lib/account-offboarding/purge-verification.ts

## `src/lib/analytics/events.ts` — 15 importer(s)
- scripts/ci/analytics-events-audit.ts
- src/app/api/analytics/enqueue/route.ts
- src/app/api/auth/verify-otp/route.ts
- src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts
- src/app/api/zernio/connect/start/route.ts
- src/lib/account-offboarding/analytics.ts
- src/lib/analytics/__tests__/events.test.ts
- src/lib/analytics/activation-event.ts
- src/lib/analytics/enqueue.ts
- src/lib/analytics/trial-events.ts
- src/lib/competitors/named-rival.ts
- src/lib/reviews/process-review.ts
- src/lib/shared/__tests__/migration-094-consent-analytics-events.integration.test.ts
- src/lib/shared/logger.ts
- worker/jobs/response-generation/analytics.ts

## `src/lib/solicitation/attestation.ts` — 12 importer(s)
- src/app/(authenticated)/dashboard/requests/contacts/page.tsx
- src/lib/shared/__tests__/migration-090-solicitation-ask-evidence.integration.test.ts
- src/lib/solicitation/__tests__/attestation.test.ts
- src/lib/solicitation/__tests__/batch-builder.integration.test.ts
- src/lib/solicitation/__tests__/batch-builder.test.ts
- src/lib/solicitation/__tests__/batch-purge-concurrency.integration.test.ts
- src/lib/solicitation/__tests__/batch-view.integration.test.ts
- src/lib/solicitation/__tests__/contacts-repo.integration.test.ts
- src/lib/solicitation/__tests__/ingest.integration.test.ts
- src/lib/solicitation/__tests__/uploads.test.ts
- src/lib/solicitation/batch-builder.ts
- src/lib/solicitation/uploads.ts

## `src/lib/solicitation/batch-builder.ts` — 7 importer(s)
- src/lib/solicitation/__tests__/batch-builder.integration.test.ts
- src/lib/solicitation/__tests__/batch-builder.test.ts
- src/lib/solicitation/__tests__/batch-purge-concurrency.integration.test.ts
- worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
- worker/jobs/account-offboarding/purge-stages.ts
- worker/jobs/solicitation-batch/__tests__/index.test.ts
- worker/jobs/solicitation-batch/index.ts

## `src/lib/solicitation/batch-view.ts` — 10 importer(s)
- src/app/(authenticated)/dashboard/requests/__tests__/batch-report.test.tsx
- src/app/(authenticated)/dashboard/requests/__tests__/requests-client.test.tsx
- src/app/(authenticated)/dashboard/requests/BatchReport.tsx
- src/app/(authenticated)/dashboard/requests/RequestsClient.tsx
- src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts
- src/app/api/dashboard/solicitation/batch/reviewed/route.ts
- src/app/api/dashboard/solicitation/batch/route.ts
- src/lib/solicitation/__tests__/batch-builder.integration.test.ts
- src/lib/solicitation/__tests__/batch-view.integration.test.ts
- src/lib/solicitation/__tests__/batch-view.test.ts

## `src/lib/solicitation/contacts-repo.ts` — 4 importer(s)
- src/app/(authenticated)/dashboard/requests/contacts/ContactList.tsx
- src/app/api/dashboard/contacts/[id]/route.ts
- src/app/api/dashboard/contacts/route.ts
- src/lib/solicitation/__tests__/contacts-repo.integration.test.ts

## `src/lib/solicitation/ingest.ts` — 13 importer(s)
- src/app/(authenticated)/dashboard/requests/contacts/__tests__/contacts-ui.test.tsx
- src/app/(authenticated)/dashboard/requests/contacts/UploadCard.tsx
- src/lib/solicitation/__tests__/batch-builder.integration.test.ts
- src/lib/solicitation/__tests__/batch-purge-concurrency.integration.test.ts
- src/lib/solicitation/__tests__/contacts-repo.integration.test.ts
- src/lib/solicitation/__tests__/ingest.integration.test.ts
- src/lib/solicitation/__tests__/ingest.test.ts
- src/lib/solicitation/uploads.ts
- worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
- worker/jobs/account-offboarding/purge-stages.ts
- worker/jobs/csv-ingest/__tests__/index.test.ts
- worker/jobs/csv-ingest/failed-hook.ts
- worker/jobs/csv-ingest/index.ts

## `src/lib/solicitation/restraint-policy.ts` — 10 importer(s)
- src/app/(authenticated)/dashboard/requests/__tests__/batch-report.test.tsx
- src/app/(authenticated)/dashboard/requests/__tests__/requests-client.test.tsx
- src/app/(authenticated)/dashboard/requests/BatchReport.tsx
- src/app/(authenticated)/dashboard/requests/GhostPipeline.tsx
- src/lib/agents/run-spine.ts
- src/lib/solicitation/__tests__/batch-view.integration.test.ts
- src/lib/solicitation/__tests__/batch-view.test.ts
- src/lib/solicitation/__tests__/restraint-policy.test.ts
- src/lib/solicitation/batch-builder.ts
- src/lib/solicitation/batch-view.ts

## `worker/jobs/account-offboarding/purge-helpers.ts` — 1 importer(s)
- worker/jobs/account-offboarding/purge-stages.ts

## `worker/jobs/account-offboarding/purge-stages.ts` — 3 importer(s)
- src/lib/solicitation/__tests__/batch-purge-concurrency.integration.test.ts
- worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
- worker/jobs/account-offboarding/PurgeWorker.ts

