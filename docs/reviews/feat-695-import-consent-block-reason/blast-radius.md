# Blast radius — importers of changed files (`feat-695-import-consent-block-reason`)

Heuristic import-text search; verify semantic impact per caller.

## `src/lib/shared/outbox-completion-reason.ts` — 12 importer(s)
- src/lib/shared/__tests__/outbox.test.ts
- src/lib/shared/outbox.ts
- worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts
- worker/background/pollers/health-alert/__tests__/checks.integration.test.ts
- worker/background/pollers/health-alert/checks.ts
- worker/background/pollers/NotificationFailoverPoller.ts
- worker/jobs/notification/__tests__/NotificationWorker.test.ts
- worker/jobs/notification/NotificationWorker.ts
- worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts
- worker/jobs/zernio/__tests__/job-eligibility.test.ts
- worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts
- worker/jobs/zernio/job-eligibility.ts

## `src/lib/shared/outbox.ts` — 76 importer(s)
- src/lib/account-offboarding/__tests__/outbox.test.ts
- src/lib/account-offboarding/confirm.ts
- src/lib/account-offboarding/keep-my-data.ts
- src/lib/account-offboarding/reactivate.ts
- src/lib/account-offboarding/reactivation-request.ts
- src/lib/account-offboarding/retry-billing.ts
- src/lib/demos/lifecycle.ts
- src/lib/shared/__tests__/outbox.test.ts
- src/lib/solicitation/__tests__/ask-generation.test.ts
- src/lib/solicitation/__tests__/batch-builder.test.ts
- src/lib/solicitation/ask-generation.ts
- src/lib/solicitation/batch-builder.ts
- worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts
- worker/background/pollers/AccountOffboardingAccessEndPoller.ts
- worker/background/pollers/AccountOffboardingPurgePoller.ts
- worker/background/pollers/AccountOffboardingPurgeReminderPoller.ts
- worker/background/pollers/AccountOffboardingTeardownRetryPoller.ts
- worker/jobs/__tests__/AutonomyAdminAlertWorker.test.ts
- worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts
- worker/jobs/account-offboarding/BillingScheduleWorker.ts
- worker/jobs/account-offboarding/purge-stages.ts
- worker/jobs/account-offboarding/PurgeWorker.ts
- worker/jobs/account-offboarding/ReactivationWorker.ts
- worker/jobs/account-offboarding/TeardownWorker.ts
- worker/jobs/AdminExceptionWorker.ts
- worker/jobs/auto-post-notice/AutoPostNoticeWorker.ts
- worker/jobs/autonomy-suspended-notice/__tests__/AutonomySuspendedNoticeWorker.test.ts
- worker/jobs/autonomy-suspended-notice/AutonomySuspendedNoticeWorker.ts
- worker/jobs/AutonomyAdminAlertWorker.ts
- worker/jobs/billing/StripeCheckoutReconcileWorker.ts
- worker/jobs/billing/StripeSubscriptionMirrorSyncWorker.ts
- worker/jobs/billing/UpdateStripeOverageWorker.ts
- worker/jobs/csv-ingest/__tests__/index.test.ts
- worker/jobs/csv-ingest/failed-hook.ts
- worker/jobs/csv-ingest/index.ts
- worker/jobs/DemoGenerationWorker.ts
- worker/jobs/DrainOwnerConnectWorker.ts
- worker/jobs/EngagementAlertWorker.ts
- worker/jobs/escalation-notice/EscalationNoticeWorker.ts
- worker/jobs/judge/failed-hook.ts
- worker/jobs/judge/JudgeWorker.ts
- worker/jobs/MonthlyImpactWorker.ts
- worker/jobs/notification/__tests__/dispatch-enrollment-account-scope.test.ts
- worker/jobs/notification/__tests__/NotificationWorker.whatsapp.test.ts
- worker/jobs/notification/NotificationWorker.ts
- worker/jobs/OnboardingDemoWorker.ts
- worker/jobs/OnboardingDripWorker.ts
- worker/jobs/OwnerEmailWorker.ts
- worker/jobs/pending-post-notice/PendingPostNoticeWorker.ts
- worker/jobs/PlaceIdValidationWorker.ts
- worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts
- worker/jobs/publisher/auto-policy-downgrade.ts
- worker/jobs/publisher/auto-policy-publish.ts
- worker/jobs/publisher/failed-hook.ts
- worker/jobs/publisher/load-context.ts
- worker/jobs/publisher/no-connection.ts
- worker/jobs/publisher/publisher-error-handlers.ts
- worker/jobs/publisher/ResponsePublisherWorker.ts
- worker/jobs/publisher/review-lookup.ts
- worker/jobs/publisher/veto-window-gate.ts
- worker/jobs/RankingTrackingWorker.ts
- worker/jobs/ResponseGeneratorWorker.ts
- worker/jobs/solicitation-batch/__tests__/generate.test.ts
- worker/jobs/solicitation-batch/__tests__/index.test.ts
- worker/jobs/solicitation-batch/failed-hook.ts
- worker/jobs/solicitation-batch/generate-failed-hook.ts
- worker/jobs/solicitation-batch/generate.ts
- worker/jobs/solicitation-batch/index.ts
- worker/jobs/summary-report-helpers.ts
- worker/jobs/WeeklySummaryWorker.ts
- worker/jobs/zernio/__tests__/zernio-ingest-shared.test.ts
- worker/jobs/zernio/ingest-failed-hook.ts
- worker/jobs/zernio/job-eligibility.ts
- worker/jobs/zernio/zernio-ingest-shared.ts
- worker/jobs/zernio/ZernioBackfillWorker.ts
- worker/jobs/zernio/ZernioReviewIngestWorker.ts

## `worker/jobs/notification/NotificationWorker.ts` — 6 importer(s)
- worker/index.ts
- worker/jobs/notification/__tests__/bounced-skip.test.ts
- worker/jobs/notification/__tests__/dispatch-enrollment-account-scope.test.ts
- worker/jobs/notification/__tests__/NotificationWorker-telegram.test.ts
- worker/jobs/notification/__tests__/NotificationWorker.test.ts
- worker/jobs/notification/__tests__/NotificationWorker.whatsapp.test.ts

## `worker/jobs/zernio/job-eligibility.ts` — 4 importer(s)
- worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts
- worker/jobs/zernio/__tests__/job-eligibility.test.ts
- worker/jobs/zernio/ZernioBackfillWorker.ts
- worker/jobs/zernio/ZernioReviewIngestWorker.ts

