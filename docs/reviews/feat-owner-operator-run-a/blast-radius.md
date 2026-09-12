# Blast radius — importers of changed files (`feat/owner-operator-run-a`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/app/api/operator/conversation/route.ts` — 1 importer(s)
- src/app/api/operator/__tests__/conversation-route.test.ts

## `src/app/api/operator/turns/[id]/route.ts` — 1 importer(s)
- src/app/api/operator/__tests__/turn-get-route.test.ts

## `src/app/api/operator/turns/route.ts` — 1 importer(s)
- src/app/api/operator/__tests__/turns-route.test.ts

## `src/app/api/settings/voice/route.ts` — 2 importer(s)
- src/app/api/settings/__tests__/voice-route.test.ts
- src/app/api/settings/voice/__tests__/route.test.ts

## `src/lib/account-offboarding/purge-verification.ts` — 6 importer(s)
- src/lib/account-offboarding/__tests__/purge-verification.test.ts
- src/lib/account-offboarding/__tests__/table-disposition.test.ts
- src/lib/agents/operator/__tests__/turn-worker.integration.test.ts
- worker/jobs/account-offboarding/__tests__/approval-audit-log-scrub.integration.test.ts
- worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts
- worker/jobs/account-offboarding/purge-stages.ts

## `src/lib/account-offboarding/table-disposition.ts` — 4 importer(s)
- src/lib/account-offboarding/__tests__/purge-verification.test.ts
- src/lib/account-offboarding/__tests__/table-disposition.test.ts
- src/lib/account-offboarding/purge-verification.ts
- src/lib/shared/__tests__/migration-098-suppression-corrections.integration.test.ts

## `src/lib/agents/operator/authorize.ts` — 2 importer(s)
- src/lib/agents/operator/__tests__/authorize.test.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts

## `src/lib/agents/operator/catalog.ts` — 6 importer(s)
- src/lib/agents/operator/__tests__/catalog.test.ts
- src/lib/agents/operator/context.ts
- src/lib/agents/operator/prompt.ts
- src/lib/agents/operator/proposals.ts
- src/lib/agents/operator/render.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts

## `src/lib/agents/operator/context.ts` — 9 importer(s)
- src/lib/agents/operator/__tests__/context.test.ts
- src/lib/agents/operator/__tests__/model-call.test.ts
- src/lib/agents/operator/__tests__/render.test.ts
- src/lib/agents/operator/__tests__/snapshot.integration.test.ts
- src/lib/agents/operator/model-call.ts
- src/lib/agents/operator/prompt.ts
- src/lib/agents/operator/render.ts
- src/lib/agents/operator/turns.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts

## `src/lib/agents/operator/flags.ts` — 4 importer(s)
- src/app/api/operator/conversation/route.ts
- src/app/api/operator/turns/[id]/route.ts
- src/app/api/operator/turns/route.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts

## `src/lib/agents/operator/model-call.ts` — 2 importer(s)
- src/lib/agents/operator/__tests__/model-call.test.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts

## `src/lib/agents/operator/prompt.ts` — 3 importer(s)
- src/lib/agents/operator/__tests__/model-call.test.ts
- src/lib/agents/operator/__tests__/snapshot.integration.test.ts
- src/lib/agents/operator/model-call.ts

## `src/lib/agents/operator/proposals.ts` — 4 importer(s)
- src/lib/agents/operator/__tests__/proposals.test.ts
- src/lib/agents/operator/context.ts
- src/lib/agents/operator/turns.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts

## `src/lib/agents/operator/render.ts` — 5 importer(s)
- src/lib/agents/operator/__tests__/render.test.ts
- src/lib/agents/operator/context.ts
- src/lib/agents/operator/model-call.ts
- src/lib/agents/operator/turns.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts

## `src/lib/agents/operator/schema.ts` — 14 importer(s)
- src/lib/agents/operator/__tests__/proposals.test.ts
- src/lib/agents/operator/__tests__/schema.test.ts
- src/lib/agents/operator/__tests__/snapshot.integration.test.ts
- src/lib/agents/operator/__tests__/turn-worker.integration.test.ts
- src/lib/agents/operator/context.ts
- src/lib/agents/operator/model-call.ts
- src/lib/agents/operator/prompt.ts
- src/lib/agents/operator/proposals.ts
- src/lib/agents/operator/render.ts
- src/lib/agents/operator/turns.ts
- src/lib/llm/tasks.ts
- src/lib/responses/__tests__/model-pinning.test.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts
- worker/jobs/agent-turn/failed-hook.ts

## `src/lib/agents/operator/turns.ts` — 7 importer(s)
- src/app/api/operator/conversation/route.ts
- src/app/api/operator/turns/[id]/route.ts
- src/app/api/operator/turns/route.ts
- src/lib/agents/operator/__tests__/turn-worker.integration.test.ts
- src/lib/agents/operator/__tests__/turns.test.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts
- worker/jobs/agent-turn/failed-hook.ts

## `src/lib/llm/tasks.ts` — 5 importer(s)
- src/lib/llm/run-task.ts
- src/lib/responses/__tests__/model-pinning.test.ts
- src/lib/solicitation/__tests__/ask-generation.integration.test.ts
- src/lib/solicitation/__tests__/ask-generation.test.ts
- src/lib/solicitation/__tests__/auto-approval.integration.test.ts

## `src/lib/llm/types.ts` — 16 importer(s)
- src/lib/agents/operator/model-call.ts
- src/lib/agents/operator/prompt.ts
- src/lib/llm/__tests__/anthropic-provider.test.ts
- src/lib/llm/__tests__/circuit-breaker.test.ts
- src/lib/llm/__tests__/run-task.test.ts
- src/lib/llm/anthropic-provider.ts
- src/lib/llm/circuit-breaker.ts
- src/lib/llm/openai-provider.ts
- src/lib/llm/run-task.ts
- src/lib/llm/tasks.ts
- src/lib/responses/generator.ts
- src/lib/responses/judge.ts
- src/lib/responses/review-summary.ts
- src/lib/reviews/triage.ts
- src/lib/solicitation/ask-generation.ts
- src/lib/solicitation/ask-prompt-policy.ts

## `src/lib/responses/voice-settings.ts` — 7 importer(s)
- src/app/api/settings/voice/__tests__/route.test.ts
- src/app/api/settings/voice/route.ts
- src/lib/agents/operator/catalog.ts
- src/lib/agents/operator/context.ts
- src/lib/agents/operator/turns.ts
- src/lib/responses/__tests__/voice-settings.test.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts

## `src/lib/shared/job-outbox-helpers.ts` — 39 importer(s)
- src/app/api/admin/flagged/route.ts
- src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts
- src/app/api/dashboard/past-replies/[responseId]/retry/route.ts
- src/app/api/dashboard/past-replies/draft/route.ts
- src/app/api/dashboard/past-replies/publish/route.ts
- src/app/api/onboarding/business/route.ts
- src/app/api/onboarding/start/route.ts
- src/lib/admin/csv-import.ts
- src/lib/agents/operator/turns.ts
- src/lib/approval/__tests__/veto.integration.test.ts
- src/lib/approval/callback-mode.ts
- src/lib/approval/session-mode.ts
- src/lib/approval/token-mode.ts
- src/lib/approval/veto.ts
- src/lib/auto-approval/suspension.ts
- src/lib/escalations/raise.ts
- src/lib/locations/add-location-tx.ts
- src/lib/locations/archive-location-tx.ts
- src/lib/reviews/on-demand-generate.ts
- src/lib/reviews/process-review.ts
- src/lib/shared/__tests__/job-outbox-helpers-attribution.integration.test.ts
- src/lib/shared/__tests__/job-outbox-helpers.test.ts
- src/lib/solicitation/__tests__/batch-builder.integration.test.ts
- src/lib/solicitation/approval.ts
- src/lib/solicitation/auto-approval.ts
- src/lib/solicitation/batch-builder.ts
- src/lib/solicitation/ingest.ts
- src/lib/solicitation/release.ts
- src/lib/solicitation/uploads.ts
- worker/__tests__/solicitation-attribution.integration.test.ts
- worker/background/pollers/JudgeSweepPoller.ts
- worker/background/pollers/NotificationFailoverPoller.ts
- worker/ingress/stripe/apply-subscription-state.ts
- worker/ingress/stripe/subscription-updated.ts
- worker/jobs/ResponseGeneratorWorker.ts
- worker/jobs/publisher/auto-policy-downgrade.ts
- worker/jobs/publisher/mark-posted.ts
- worker/jobs/publisher/veto-window-gate.ts
- worker/jobs/response-generation/persist.ts

## `src/lib/shared/queue-names.ts` — 80 importer(s)
- scripts/burst-drill-load.ts
- scripts/ci/outbox-seam-audit.ts
- scripts/ci/outbox-topics-audit.ts
- src/app/api/admin/businesses/[id]/zernio-queue/route.ts
- src/app/api/admin/demos/generate/route.ts
- src/app/api/auth/signup-status/route.ts
- src/app/api/dashboard/reviews/[reviewId]/draft-status/__tests__/route.test.ts
- src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts
- src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/generate-version.integration.test.ts
- src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts
- src/app/api/feedback/route.ts
- src/app/api/onboarding/demo/regenerate/route.ts
- src/app/api/onboarding/start/route.ts
- src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts
- src/lib/account-offboarding/__tests__/confirm-cancel-only.test.ts
- src/lib/account-offboarding/__tests__/confirm-delete-data.test.ts
- src/lib/account-offboarding/__tests__/keep-my-data.test.ts
- src/lib/account-offboarding/__tests__/outbox.test.ts
- src/lib/account-offboarding/__tests__/reactivate.test.ts
- src/lib/account-offboarding/outbox.ts
- src/lib/approval/__tests__/veto.integration.test.ts
- src/lib/approval/correlation.ts
- src/lib/approval/veto.ts
- src/lib/auto-approval/__tests__/suspension.integration.test.ts
- src/lib/locations/archive-location-tx.ts
- src/lib/past-replies/load-replies.ts
- src/lib/responses/__tests__/judge-store.integration.test.ts
- src/lib/responses/generation-state.ts
- src/lib/responses/judge-health.ts
- src/lib/responses/judge-store.ts
- src/lib/reviews/__tests__/on-demand-generate.test.ts
- src/lib/reviews/__tests__/process-review-attribution.integration.test.ts
- src/lib/reviews/import-consent.ts
- src/lib/reviews/import-offer-view.ts
- src/lib/reviews/process-review.ts
- src/lib/shared/__tests__/job-outbox-helpers-attribution.integration.test.ts
- src/lib/shared/__tests__/job-outbox-helpers.test.ts
- src/lib/shared/job-outbox-helpers.ts
- src/lib/solicitation/__tests__/approval.integration.test.ts
- src/lib/solicitation/__tests__/auto-approval.integration.test.ts
- src/lib/solicitation/__tests__/batch-builder.integration.test.ts
- src/lib/solicitation/__tests__/batch-purge-concurrency.integration.test.ts
- src/lib/solicitation/__tests__/dispatch.integration.test.ts
- src/lib/solicitation/__tests__/ingest.integration.test.ts
- src/lib/solicitation/__tests__/release.integration.test.ts
- src/lib/solicitation/__tests__/uploads.test.ts
- src/lib/solicitation/batch-view.ts
- src/lib/solicitation/release.ts
- worker/__tests__/job-failure-sink.test.ts
- worker/__tests__/queue-routing.test.ts
- worker/__tests__/solicitation-attribution.test.ts
- worker/background/pollers/EngagementMonitorPoller.ts
- worker/background/pollers/NotificationFailoverPoller.ts
- worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts
- worker/background/pollers/health-alert/__tests__/checks.integration.test.ts
- worker/background/pollers/health-alert/__tests__/checks.test.ts
- worker/background/pollers/health-alert/checks.ts
- worker/background/schedulers/MonthlyImpactScheduler.ts
- worker/background/schedulers/OnboardingDripScheduler.ts
- worker/background/schedulers/RankingTrackingScheduler.ts
- worker/background/schedulers/WeeklySummaryScheduler.ts
- worker/background/schedulers/__tests__/AutonomyGovernorScheduler.integration.test.ts
- worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts
- worker/ingress/zernio/zernio.ts
- worker/internal/__tests__/queue-health.test.ts
- worker/internal/queue-health.ts
- worker/jobs/DrainOwnerConnectWorker.ts
- worker/jobs/__tests__/onboarding-drip.integration.test.ts
- worker/jobs/account-offboarding/__tests__/BillingScheduleWorker.test.ts
- worker/jobs/account-offboarding/teardown-outbox.ts
- worker/jobs/publisher/__tests__/auto-policy-downgrade.integration.test.ts
- worker/jobs/publisher/__tests__/veto-window-gate.integration.test.ts
- worker/jobs/publisher/failed-hook.ts
- worker/jobs/publisher/publisher-error-handlers.ts
- worker/jobs/publisher/review-lookup.ts
- worker/jobs/response-generation/__tests__/on-demand-lane.property.test.ts
- worker/jobs/response-generation/__tests__/persist.test.ts
- worker/jobs/zernio/ingest-failed-hook.ts
- worker/jobs/zernio/zernio-ingest-shared.ts
- worker/queues.ts

## `src/lib/shared/worker-types.ts` — 139 importer(s)
- scripts/ws8-staging-smoke.ts
- src/app/api/admin/flagged/route.ts
- src/app/api/dashboard/past-replies/draft/route.ts
- src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/generate-version.integration.test.ts
- src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts
- src/app/api/feedback/route.ts
- src/app/api/onboarding/business/route.ts
- src/app/api/onboarding/start/route.ts
- src/lib/account-offboarding/email-dedup.ts
- src/lib/account-offboarding/outbox.ts
- src/lib/agents/operator/__tests__/turn-worker.integration.test.ts
- src/lib/approval/__tests__/service.test.ts
- src/lib/approval/audit.ts
- src/lib/approval/callback-mode.ts
- src/lib/approval/errors.ts
- src/lib/approval/session-mode.ts
- src/lib/approval/token-mode.ts
- src/lib/auto-approval/governor.ts
- src/lib/auto-approval/suspension.ts
- src/lib/demos/types.ts
- src/lib/locations/archive-location-tx.ts
- src/lib/refusals/vocabulary.ts
- src/lib/reviews/__tests__/on-demand-generate.test.ts
- src/lib/reviews/import-consent.ts
- src/lib/reviews/on-demand-generate.ts
- src/lib/reviews/process-review.ts
- src/lib/shared/job-outbox-helpers.ts
- src/lib/solicitation/__tests__/batch-builder.integration.test.ts
- src/lib/zernio/auth-error-fallback.ts
- worker/__tests__/correlation-chain.test.ts
- worker/__tests__/solicitation-attribution.integration.test.ts
- worker/__tests__/solicitation-attribution.test.ts
- worker/background/pollers/EngagementMonitorPoller.ts
- worker/background/pollers/NotificationFailoverPoller.ts
- worker/background/schedulers/OnboardingDripScheduler.ts
- worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts
- worker/index.ts
- worker/ingress/zernio/__tests__/zernio-fanout-archived.integration.test.ts
- worker/ingress/zernio/__tests__/zernio-webhook.test.ts
- worker/ingress/zernio/zernio.ts
- worker/jobs/AdminExceptionWorker.ts
- worker/jobs/AutonomyAdminAlertWorker.ts
- worker/jobs/DrainOwnerConnectWorker.ts
- worker/jobs/EngagementAlertWorker.ts
- worker/jobs/MonthlyImpactWorker.ts
- worker/jobs/OnboardingDemoWorker.ts
- worker/jobs/OnboardingDripWorker.ts
- worker/jobs/OwnerEmailWorker.ts
- worker/jobs/PlaceIdValidationWorker.ts
- worker/jobs/RankingTrackingWorker.ts
- worker/jobs/ResponseGeneratorWorker.ts
- worker/jobs/WeeklySummaryWorker.ts
- worker/jobs/__tests__/AdminExceptionWorker.test.ts
- worker/jobs/__tests__/AutonomyAdminAlertWorker.test.ts
- worker/jobs/__tests__/EngagementAlertWorker.test.ts
- worker/jobs/__tests__/MonthlyImpactWorker.test.ts
- worker/jobs/__tests__/OnboardingDripWorker.test.ts
- worker/jobs/__tests__/PlaceIdValidationWorker.test.ts
- worker/jobs/__tests__/RankingTrackingWorker.test.ts
- worker/jobs/__tests__/ResponseGeneratorWorker.test.ts
- worker/jobs/__tests__/WeeklySummaryWorker.test.ts
- worker/jobs/__tests__/onboarding-drip.integration.test.ts
- worker/jobs/__tests__/solicitation-send-failed-hook.test.ts
- worker/jobs/__tests__/solicitation-send.test.ts
- worker/jobs/__tests__/summary-report-helpers.test.ts
- worker/jobs/__tests__/terminal-failure-checkpoints.integration.test.ts
- worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts
- worker/jobs/account-offboarding/BillingScheduleWorker.ts
- worker/jobs/account-offboarding/PurgeWorker.ts
- worker/jobs/account-offboarding/ReactivationWorker.ts
- worker/jobs/account-offboarding/TeardownWorker.ts
- worker/jobs/account-offboarding/__tests__/AccountOffboardingEmailWorker.test.ts
- worker/jobs/account-offboarding/__tests__/BillingScheduleWorker.test.ts
- worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts
- worker/jobs/account-offboarding/__tests__/ReactivationWorker.test.ts
- worker/jobs/account-offboarding/__tests__/TeardownWorker.test.ts
- worker/jobs/agent-turn/AgentTurnWorker.ts
- worker/jobs/agent-turn/__tests__/AgentTurnWorker.test.ts
- worker/jobs/agent-turn/failed-hook.ts
- worker/jobs/auto-post-notice/AutoPostNoticeWorker.ts
- worker/jobs/autonomy-suspended-notice/AutonomySuspendedNoticeWorker.ts
- worker/jobs/autonomy-suspended-notice/__tests__/AutonomySuspendedNoticeWorker.test.ts
- worker/jobs/autonomy-suspended-notice/context.ts
- worker/jobs/billing/StripeCheckoutReconcileWorker.ts
- worker/jobs/billing/StripeSubscriptionMirrorSyncWorker.ts
- worker/jobs/billing/__tests__/StripeSubscriptionMirrorSyncWorker.test.ts
- worker/jobs/csv-ingest/__tests__/index.test.ts
- worker/jobs/csv-ingest/failed-hook.ts
- worker/jobs/csv-ingest/index.ts
- worker/jobs/escalation-notice/EscalationNoticeWorker.ts
- worker/jobs/escalation-notice/__tests__/EscalationNoticeWorker.test.ts
- worker/jobs/judge/JudgeWorker.ts
- worker/jobs/judge/__tests__/JudgeWorker.test.ts
- worker/jobs/judge/__tests__/failed-hook.test.ts
- worker/jobs/judge/failed-hook.ts
- worker/jobs/notification/NotificationWorker.ts
- worker/jobs/notification/__tests__/NotificationWorker-telegram.test.ts
- worker/jobs/notification/__tests__/NotificationWorker.test.ts
- worker/jobs/pending-post-notice/PendingPostNoticeWorker.ts
- worker/jobs/pending-post-notice/__tests__/PendingPostNoticeWorker.test.ts
- worker/jobs/publisher/ResponsePublisherWorker.ts
- worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
- worker/jobs/publisher/__tests__/auto-policy-downgrade.integration.test.ts
- worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts
- worker/jobs/publisher/__tests__/failed-hook.test.ts
- worker/jobs/publisher/auto-policy-downgrade.ts
- worker/jobs/publisher/edit-publish-tx.ts
- worker/jobs/publisher/failed-hook.ts
- worker/jobs/publisher/no-connection.ts
- worker/jobs/publisher/publisher-error-handlers.ts
- worker/jobs/response-generation/__tests__/auto-approval.test.ts
- worker/jobs/response-generation/__tests__/content-freshness-gate.integration.test.ts
- worker/jobs/response-generation/__tests__/load-context.test.ts
- worker/jobs/response-generation/__tests__/on-demand-lane.property.test.ts
- worker/jobs/response-generation/__tests__/persist.test.ts
- worker/jobs/response-generation/__tests__/refusal-write.integration.test.ts
- worker/jobs/response-generation/auto-approval.ts
- worker/jobs/response-generation/load-context.ts
- worker/jobs/response-generation/persist.ts
- worker/jobs/solicitation-attribution/SolicitationAttributionWorker.ts
- worker/jobs/solicitation-batch/__tests__/generate.test.ts
- worker/jobs/solicitation-batch/__tests__/index.test.ts
- worker/jobs/solicitation-batch/failed-hook.ts
- worker/jobs/solicitation-batch/generate-failed-hook.ts
- worker/jobs/solicitation-batch/generate.ts
- worker/jobs/solicitation-batch/index.ts
- worker/jobs/solicitation-send.ts
- worker/jobs/solicitation-send/failed-hook.ts
- worker/jobs/solicitation-veto-notice/SolicitationVetoNoticeWorker.ts
- worker/jobs/solicitation-veto-notice/__tests__/SolicitationVetoNoticeWorker.test.ts
- worker/jobs/summary-report-helpers.ts
- worker/jobs/zernio/ZernioBackfillWorker.ts
- worker/jobs/zernio/ZernioReviewIngestWorker.ts
- worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts
- worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts
- worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts
- worker/jobs/zernio/__tests__/zernio-end-to-end.integration.test.ts
- worker/jobs/zernio/ingest-failed-hook.ts
- worker/jobs/zernio/job-eligibility.ts

## `worker/config/startup-assert.ts` — 3 importer(s)
- worker/config/__tests__/startup-assertion.test.ts
- worker/config/startup-side-effect-guard.ts
- worker/index.ts

## `worker/index.ts` — 0 importer(s)
_none found (entry point, or dynamic/config-driven usage — check registration sites)_

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

## `worker/jobs/agent-turn/AgentTurnWorker.ts` — 3 importer(s)
- src/lib/agents/operator/__tests__/turn-worker.integration.test.ts
- worker/index.ts
- worker/jobs/agent-turn/__tests__/AgentTurnWorker.test.ts

## `worker/jobs/agent-turn/constants.ts` — 1 importer(s)
- worker/jobs/agent-turn/AgentTurnWorker.ts

## `worker/jobs/agent-turn/failed-hook.ts` — 1 importer(s)
- worker/index.ts

## `worker/queues.ts` — 4 importer(s)
- worker/__tests__/queue-routing.test.ts
- worker/__tests__/solicitation-attribution.test.ts
- worker/background/pollers/OutboxPoller.ts
- worker/index.ts
