# Blast radius — importers of changed files (`feat-675-consented-import-selection`)

Heuristic import-text search; verify semantic impact per caller.

## `src/lib/config/worker.ts` — 92 importer(s)
- scripts/ci/config-coverage-audit.ts
- src/lib/notifications/channels/__tests__/email-channel.test.ts
- src/lib/notifications/channels/__tests__/telegram-client.test.ts
- src/lib/notifications/channels/__tests__/whatsapp-body.test.ts
- src/lib/notifications/channels/__tests__/whatsapp-channel.test.ts
- src/lib/notifications/channels/__tests__/whatsapp-client.test.ts
- src/lib/notifications/channels/email-channel.ts
- src/lib/notifications/channels/telegram-client.ts
- src/lib/notifications/channels/whatsapp-body.ts
- src/lib/notifications/channels/whatsapp-channel.ts
- src/lib/notifications/channels/whatsapp-client.ts
- src/lib/reviews/__tests__/place-id-resolver.test.ts
- src/lib/reviews/place-id-resolver.ts
- worker/background/pollers/__tests__/AccountOffboardingPurgePoller.test.ts
- worker/background/pollers/__tests__/AnalyticsDispatchPoller.test.ts
- worker/background/pollers/__tests__/CleanupAbandonedSignupsPoller.test.ts
- worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts
- worker/background/pollers/__tests__/truncation-alert.test.ts
- worker/background/pollers/__tests__/ZernioRecentReviewPoller.test.ts
- worker/background/pollers/AccountOffboardingAccessEndPoller.ts
- worker/background/pollers/AccountOffboardingPurgePoller.ts
- worker/background/pollers/AccountOffboardingPurgeReminderPoller.ts
- worker/background/pollers/AccountOffboardingReactivationResetPoller.ts
- worker/background/pollers/AccountOffboardingTeardownRetryPoller.ts
- worker/background/pollers/AnalyticsDispatchPoller.ts
- worker/background/pollers/ArchivalPoller.ts
- worker/background/pollers/billing-reconciliation/drift-alert.ts
- worker/background/pollers/billing-reconciliation/truncation-alert.ts
- worker/background/pollers/CancellationGracePoller.ts
- worker/background/pollers/CleanupAbandonedSignupsPoller.ts
- worker/background/pollers/EmailChannelReconcilePoller.ts
- worker/background/pollers/EngagementMonitorPoller.ts
- worker/background/pollers/health-alert/__tests__/checks.test.ts
- worker/background/pollers/health-alert/checks.ts
- worker/background/pollers/health-alert/emit.ts
- worker/background/pollers/HealthAlertPoller.ts
- worker/background/pollers/JudgeSweepPoller.ts
- worker/background/pollers/NotificationFailoverPoller.ts
- worker/background/pollers/OutboxPoller.ts
- worker/background/pollers/StripeLocationsReconcilePoller.ts
- worker/background/pollers/ZernioRecentReviewPoller.ts
- worker/background/schedulers/__tests__/AutonomyGovernorScheduler.test.ts
- worker/background/schedulers/AutonomyGovernorScheduler.ts
- worker/index.ts
- worker/ingress/__tests__/resend-webhook-bounce.test.ts
- worker/ingress/__tests__/resend-webhook-signature.test.ts
- worker/ingress/__tests__/unsubscribe-rate-limit.test.ts
- worker/ingress/__tests__/unsubscribe.test.ts
- worker/ingress/resend.ts
- worker/ingress/stripe.ts
- worker/ingress/telegram/__tests__/telegram-verify.test.ts
- worker/ingress/telegram/telegram-verify.ts
- worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts
- worker/ingress/twilio/twilio-delivery-status.ts
- worker/ingress/twilio/twilio-whatsapp-inbound.ts
- worker/ingress/unsubscribe.ts
- worker/ingress/zernio/__tests__/zernio-webhook.test.ts
- worker/ingress/zernio/zernio.ts
- worker/jobs/__tests__/AutonomyAdminAlertWorker.test.ts
- worker/jobs/__tests__/EngagementAlertWorker.test.ts
- worker/jobs/account-offboarding/__tests__/AccountOffboardingEmailWorker.test.ts
- worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts
- worker/jobs/AdminExceptionWorker.ts
- worker/jobs/auto-post-notice/__tests__/dispatch.test.ts
- worker/jobs/auto-post-notice/AutoPostNoticeWorker.ts
- worker/jobs/auto-post-notice/dispatch.ts
- worker/jobs/autonomy-suspended-notice/__tests__/AutonomySuspendedNoticeWorker.test.ts
- worker/jobs/autonomy-suspended-notice/__tests__/dispatch.test.ts
- worker/jobs/autonomy-suspended-notice/AutonomySuspendedNoticeWorker.ts
- worker/jobs/autonomy-suspended-notice/dispatch.ts
- worker/jobs/AutonomyAdminAlertWorker.ts
- worker/jobs/EngagementAlertWorker.ts
- worker/jobs/escalation-notice/__tests__/dispatch.test.ts
- worker/jobs/escalation-notice/__tests__/EscalationNoticeWorker.test.ts
- worker/jobs/escalation-notice/dispatch.ts
- worker/jobs/escalation-notice/EscalationNoticeWorker.ts
- worker/jobs/MonthlyImpactWorker.ts
- worker/jobs/notification/NotificationWorker.ts
- worker/jobs/OnboardingDripWorker.ts
- worker/jobs/OwnerEmailWorker.ts
- worker/jobs/pending-post-notice/__tests__/dispatch.test.ts
- worker/jobs/pending-post-notice/__tests__/PendingPostNoticeWorker.test.ts
- worker/jobs/pending-post-notice/dispatch.ts
- worker/jobs/pending-post-notice/PendingPostNoticeWorker.ts
- worker/jobs/RankingTrackingWorker.ts
- worker/jobs/WeeklySummaryWorker.ts
- worker/jobs/zernio/__tests__/zernio-ingest-shared.test.ts
- worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts
- worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts
- worker/jobs/zernio/zernio-ingest-shared.ts
- worker/jobs/zernio/ZernioBackfillWorker.ts
- worker/jobs/zernio/ZernioReviewIngestWorker.ts

## `src/lib/reviews/process-review.ts` — 5 importer(s)
- src/lib/reviews/__tests__/import-review.integration.test.ts
- src/lib/reviews/__tests__/process-review.test.ts
- worker/background/pollers/ZernioRecentReviewPoller.ts
- worker/jobs/zernio/ZernioBackfillWorker.ts
- worker/jobs/zernio/ZernioReviewIngestWorker.ts

## `worker/background/pollers/ZernioRecentReviewPoller.ts` — 2 importer(s)
- worker/background/pollers/__tests__/ZernioRecentReviewPoller.test.ts
- worker/index.ts

## `worker/jobs/zernio/zernio-ingest-shared.ts` — 5 importer(s)
- scripts/zernio-backfill-external-replies.ts
- worker/background/pollers/ZernioRecentReviewPoller.ts
- worker/jobs/zernio/__tests__/zernio-ingest-shared.test.ts
- worker/jobs/zernio/ZernioBackfillWorker.ts
- worker/jobs/zernio/ZernioReviewIngestWorker.ts

## `worker/jobs/zernio/ZernioBackfillWorker.ts` — 2 importer(s)
- worker/index.ts
- worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts

