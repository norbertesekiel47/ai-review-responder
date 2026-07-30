# Blast radius — importers of changed files (`feat-624-spine-lifecycle-fanout`)

Heuristic import-text search; verify semantic impact per caller.

## `src/components/dashboard/timeline/RunStateBadge.tsx` — 1 importer(s)
- src/components/dashboard/timeline/RunTimeline.tsx

## `src/lib/account-offboarding/purge-verification.ts` — 2 importer(s)
- src/lib/account-offboarding/__tests__/purge-verification.test.ts
- worker/jobs/account-offboarding/purge-stages.ts

## `src/lib/account-offboarding/table-disposition.ts` — 3 importer(s)
- src/lib/account-offboarding/__tests__/purge-verification.test.ts
- src/lib/account-offboarding/__tests__/table-disposition.test.ts
- src/lib/account-offboarding/purge-verification.ts

## `src/lib/agents/read.ts` — 14 importer(s)
- src/app/api/dashboard/agent-team/__tests__/route.test.ts
- src/app/api/dashboard/agent-team/route.ts
- src/app/api/dashboard/reviews/[reviewId]/timeline/__tests__/route.test.ts
- src/app/api/dashboard/reviews/[reviewId]/timeline/route.ts
- src/components/dashboard/timeline/__tests__/TimelineContent.test.tsx
- src/components/dashboard/timeline/RunStateBadge.tsx
- src/components/dashboard/timeline/RunTimeline.tsx
- src/components/dashboard/timeline/TimelineContent.tsx
- src/components/dashboard/timeline/TimelineEscalationActions.tsx
- src/components/dashboard/timeline/TimelineStepRow.tsx
- src/lib/agents/__tests__/read.integration.test.ts
- src/lib/agents/__tests__/read.test.ts
- worker/background/pollers/health-alert/__tests__/checks.test.ts
- worker/background/pollers/health-alert/checks.ts

## `src/lib/agents/run-spine.ts` — 41 importer(s)
- src/components/dashboard/timeline/TimelineStepRow.tsx
- src/lib/agents/__tests__/read.integration.test.ts
- src/lib/agents/__tests__/run-spine.integration.test.ts
- src/lib/agents/__tests__/run-spine.test.ts
- src/lib/agents/read.ts
- src/lib/approval/__tests__/owner-decision-outcomes.integration.test.ts
- src/lib/approval/__tests__/session-mode.test.ts
- src/lib/approval/__tests__/token-mode.test.ts
- src/lib/approval/__tests__/veto.integration.test.ts
- src/lib/approval/__tests__/veto.test.ts
- src/lib/approval/outcomes.ts
- src/lib/approval/veto.ts
- src/lib/escalations/__tests__/raise.integration.test.ts
- src/lib/escalations/__tests__/raise.test.ts
- src/lib/escalations/__tests__/transitions.integration.test.ts
- src/lib/escalations/__tests__/transitions.test.ts
- src/lib/escalations/raise.ts
- src/lib/escalations/transitions.ts
- src/lib/reviews/__tests__/process-review.test.ts
- src/lib/reviews/__tests__/triage.test.ts
- src/lib/reviews/process-review.ts
- src/lib/reviews/triage.ts
- src/lib/solicitation/__tests__/batch-builder.integration.test.ts
- src/lib/solicitation/__tests__/batch-builder.test.ts
- src/lib/solicitation/__tests__/outreach-close.integration.test.ts
- src/lib/solicitation/batch-builder.ts
- src/lib/solicitation/outreach.ts
- worker/background/pollers/health-alert/__tests__/checks.integration.test.ts
- worker/background/pollers/health-alert/checks.ts
- worker/jobs/__tests__/terminal-failure-checkpoints.integration.test.ts
- worker/jobs/escalation-notice/EscalationNoticeWorker.ts
- worker/jobs/publisher/__tests__/edit-publish.test.ts
- worker/jobs/publisher/__tests__/mark-posted.test.ts
- worker/jobs/publisher/failed-hook.ts
- worker/jobs/publisher/mark-posted.ts
- worker/jobs/response-generation/__tests__/persist.test.ts
- worker/jobs/response-generation/persist.ts
- worker/jobs/ResponseGeneratorWorker.ts
- worker/jobs/solicitation-batch/__tests__/index.test.ts
- worker/jobs/solicitation-batch/failed-hook.ts
- worker/jobs/WeeklySummaryWorker.ts

## `src/lib/solicitation/batch-builder.ts` — 7 importer(s)
- src/lib/solicitation/__tests__/batch-builder.integration.test.ts
- src/lib/solicitation/__tests__/batch-builder.test.ts
- src/lib/solicitation/__tests__/batch-purge-concurrency.integration.test.ts
- worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
- worker/jobs/account-offboarding/purge-stages.ts
- worker/jobs/solicitation-batch/__tests__/index.test.ts
- worker/jobs/solicitation-batch/index.ts

## `src/lib/solicitation/outreach.ts` — 2 importer(s)
- src/lib/solicitation/__tests__/outreach-close.integration.test.ts
- src/lib/solicitation/__tests__/outreach.test.ts

## `worker/background/pollers/ArchivalPoller.ts` — 2 importer(s)
- worker/background/pollers/__tests__/ArchivalPoller.test.ts
- worker/index.ts

## `worker/background/pollers/health-alert/checks.ts` — 8 importer(s)
- scripts/health-bundle-differential.ts
- worker/background/pollers/health-alert/__tests__/checks.integration.test.ts
- worker/background/pollers/health-alert/__tests__/checks.test.ts
- worker/background/pollers/health-alert/__tests__/emit.test.ts
- worker/background/pollers/health-alert/emit.ts
- worker/background/pollers/health-alert/replica-cardinality.ts
- worker/background/pollers/HealthAlertPoller.ts
- worker/background/pollers/NotificationFailoverPoller.ts

## `worker/jobs/account-offboarding/purge-stages.ts` — 3 importer(s)
- src/lib/solicitation/__tests__/batch-purge-concurrency.integration.test.ts
- worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
- worker/jobs/account-offboarding/PurgeWorker.ts

