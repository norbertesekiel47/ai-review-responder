# Blast radius — importers of changed files (`feat-860-ask-regeneration-surface`)

Heuristic import-text search; verify semantic impact per caller.

## `src/app/(authenticated)/dashboard/requests/ApprovalActions.tsx` — 1 importer(s)
- src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx

## `src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx` — 2 importer(s)
- src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx
- src/app/(authenticated)/dashboard/requests/RequestsClient.tsx

## `src/app/(authenticated)/dashboard/requests/AskList.tsx` — 1 importer(s)
- src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx

## `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx` — 2 importer(s)
- src/app/(authenticated)/dashboard/requests/__tests__/requests-client.test.tsx
- src/app/(authenticated)/dashboard/requests/page.tsx

## `src/app/api/dashboard/solicitation/batch/regenerate/route.ts` — 82 importer(s)
- src/__tests__/eslint-boundaries.test.ts
- src/app/__tests__/unsubscribe-landing.test.tsx
- src/app/api/account/offboarding/__tests__/fresh-auth.test.ts
- src/app/api/account/settings/__tests__/route-plan-presentation.test.ts
- src/app/api/admin/businesses/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/channels/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts
- src/app/api/admin/channels/__tests__/bindings.test.ts
- src/app/api/admin/channels/telegram/__tests__/cancel.test.ts
- src/app/api/admin/channels/telegram/__tests__/disable.test.ts
- src/app/api/admin/channels/telegram/__tests__/start.test.ts
- src/app/api/admin/channels/whatsapp/__tests__/cancel.test.ts
- src/app/api/admin/channels/whatsapp/__tests__/disable.test.ts
- src/app/api/admin/channels/whatsapp/__tests__/start.test.ts
- src/app/api/admin/demos/generate/__tests__/route.test.ts
- src/app/api/admin/flagged/__tests__/route.test.ts
- src/app/api/admin/jobs/__tests__/route.test.ts
- src/app/api/admin/locations/csv-import/__tests__/route.test.ts
- src/app/api/admin/nav-counts/__tests__/route.test.ts
- src/app/api/auth/__tests__/callback.test.ts
- src/app/api/auth/__tests__/finish-signup.test.ts
- src/app/api/auth/__tests__/forgot-password.test.ts
- src/app/api/auth/__tests__/login-attempt.test.ts
- src/app/api/auth/__tests__/mfa-challenge.test.ts
- src/app/api/auth/__tests__/resend-confirmation.test.ts
- src/app/api/auth/__tests__/reset-password.test.ts
- src/app/api/auth/__tests__/signup-status.test.ts
- src/app/api/auth/__tests__/signup.test.ts
- src/app/api/auth/__tests__/verify-otp.test.ts
- src/app/api/billing/__tests__/checkout-params.test.ts
- src/app/api/billing/__tests__/checkout.test.ts
- src/app/api/billing/__tests__/portal.test.ts
- src/app/api/billing/checkout/__tests__/route.test.ts
- src/app/api/billing/tier-change/__tests__/route.test.ts
- src/app/api/dashboard/__tests__/route.test.ts
- src/app/api/dashboard/__tests__/scope-route.test.ts
- src/app/api/dashboard/agent-team/__tests__/route.test.ts
- src/app/api/dashboard/channels/__tests__/status-get.test.ts
- src/app/api/dashboard/channels/telegram/__tests__/cancel.test.ts
- src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts
- src/app/api/dashboard/channels/telegram/__tests__/start.test.ts
- src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts
- src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts
- src/app/api/dashboard/channels/whatsapp/__tests__/enroll-e2e.integration.test.ts
- src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts
- src/app/api/dashboard/contacts/__tests__/flag-404.test.ts
- src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts
- src/app/api/dashboard/escalations/__tests__/route.test.ts
- src/app/api/dashboard/import-offer/__tests__/route.test.ts
- src/app/api/dashboard/reviews/[reviewId]/timeline/__tests__/route.test.ts
- src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts
- src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts
- src/app/api/feedback/__tests__/route.test.ts
- src/app/api/health/__tests__/route.test.ts
- src/app/api/locations/__tests__/add.test.ts
- src/app/api/locations/__tests__/archive.test.ts
- src/app/api/locations/__tests__/promote-primary.test.ts
- src/app/api/locations/display-label/__tests__/route.test.ts
- src/app/api/locations/reactivate/__tests__/route.test.ts
- src/app/api/onboarding/__tests__/business.test.ts
- src/app/api/onboarding/__tests__/select-plan.test.ts
- src/app/api/onboarding/demo/status/__tests__/route.test.ts
- src/app/api/onboarding/start/__tests__/route.test.ts
- src/app/api/settings/__tests__/route.test.ts
- src/app/api/settings/auto-approval/__tests__/route.test.ts
- src/app/api/settings/channels/override/__tests__/route.test.ts
- src/app/api/settings/channels/overrides/__tests__/route.test.ts
- src/app/api/settings/competitors/__tests__/route.test.ts
- src/app/api/settings/postal-address/__tests__/route.test.ts
- src/app/api/settings/voice/__tests__/route.test.ts
- src/app/api/settings/voice/report-card/__tests__/route.test.ts
- src/app/api/signup/__tests__/place-prefill.test.ts
- src/app/api/zernio/connect/callback/__tests__/route.test.ts
- src/app/api/zernio/connect/cancel/__tests__/route.test.ts
- src/app/api/zernio/connect/select-location/__tests__/route.test.ts
- src/app/api/zernio/connect/start/__tests__/route.test.ts
- src/app/api/zernio/disconnect/__tests__/route.test.ts
- src/app/r/google/[responseId]/__tests__/route.test.ts
- worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts

## `src/lib/agents/run-spine.ts` — 46 importer(s)
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
- src/lib/solicitation/__tests__/approval.test.ts
- src/lib/solicitation/__tests__/ask-generation.test.ts
- src/lib/solicitation/__tests__/batch-builder.integration.test.ts
- src/lib/solicitation/__tests__/batch-builder.test.ts
- src/lib/solicitation/__tests__/outreach-close.integration.test.ts
- src/lib/solicitation/approval.ts
- src/lib/solicitation/ask-generation.ts
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
- worker/jobs/response-generation/__tests__/on-demand-lane.property.test.ts
- worker/jobs/response-generation/__tests__/persist.test.ts
- worker/jobs/response-generation/persist.ts
- worker/jobs/ResponseGeneratorWorker.ts
- worker/jobs/solicitation-batch/__tests__/index.test.ts
- worker/jobs/solicitation-batch/failed-hook.ts
- worker/jobs/WeeklySummaryWorker.ts

## `src/lib/costs/tracker.ts` — 26 importer(s)
- src/app/(authenticated)/dashboard/requests/AskList.tsx
- src/app/(authenticated)/dashboard/reviews/history/PastRepliesClient.tsx
- src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts
- src/app/api/dashboard/solicitation/batch/regenerate/route.ts
- src/components/dashboard/reviews/PastReplyCard.tsx
- src/lib/costs/__tests__/cost-guard.test.ts
- src/lib/costs/cost-guard.ts
- src/lib/past-replies/__tests__/load-replies.integration.test.ts
- src/lib/past-replies/__tests__/reviews-list.test.ts
- src/lib/past-replies/load-replies.ts
- src/lib/responses/__tests__/generator.test.ts
- src/lib/responses/__tests__/judge.test.ts
- src/lib/responses/__tests__/review-summary.test.ts
- src/lib/responses/generator.ts
- src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts
- src/lib/shared/__tests__/security.test.ts
- src/lib/shared/dashboard-regen-rate-limit.ts
- src/lib/solicitation/__tests__/ask-generation.integration.test.ts
- src/lib/solicitation/__tests__/ask-generation.test.ts
- src/lib/solicitation/__tests__/batch-view.test.ts
- src/lib/solicitation/ask-generation.ts
- src/lib/solicitation/batch-view.ts
- worker/jobs/__tests__/ResponseGeneratorWorker.test.ts
- worker/jobs/response-generation/__tests__/generate-draft.test.ts
- worker/jobs/response-generation/generate-draft.ts
- worker/jobs/solicitation-batch/__tests__/generate.test.ts

## `src/lib/shared/dashboard-regen-rate-limit.ts` — 10 importer(s)
- src/app/api/dashboard/past-replies/__tests__/draft.test.ts
- src/app/api/dashboard/past-replies/draft/route.ts
- src/app/api/dashboard/reviews/__tests__/actions.test.ts
- src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/generate-version.integration.test.ts
- src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts
- src/app/api/dashboard/reviews/[reviewId]/generate/route.ts
- src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts
- src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts
- src/app/api/dashboard/solicitation/batch/regenerate/route.ts
- src/lib/shared/__tests__/dashboard-regen-rate-limit.test.ts

## `src/lib/solicitation/approval.ts` — 11 importer(s)
- src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx
- src/app/api/dashboard/solicitation/batch/__tests__/approval-routes.test.ts
- src/app/api/dashboard/solicitation/batch/approve/route.ts
- src/app/api/dashboard/solicitation/batch/halt/route.ts
- src/app/api/dashboard/solicitation/batch/regenerate/route.ts
- src/lib/notifications/__tests__/template-prefix.test.ts
- src/lib/notifications/email.ts
- src/lib/notifications/email/__tests__/approval-idempotency.test.ts
- src/lib/solicitation/__tests__/approval.integration.test.ts
- src/lib/solicitation/__tests__/approval.test.ts
- src/lib/solicitation/__tests__/ask-generation.integration.test.ts

## `src/lib/solicitation/ask-generation.ts` — 5 importer(s)
- src/lib/solicitation/__tests__/ask-generation.integration.test.ts
- src/lib/solicitation/__tests__/ask-generation.test.ts
- worker/jobs/solicitation-batch/__tests__/generate.test.ts
- worker/jobs/solicitation-batch/generate-failed-hook.ts
- worker/jobs/solicitation-batch/generate.ts

## `src/lib/solicitation/batch-view.ts` — 13 importer(s)
- src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx
- src/app/(authenticated)/dashboard/requests/__tests__/batch-report.test.tsx
- src/app/(authenticated)/dashboard/requests/__tests__/requests-client.test.tsx
- src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx
- src/app/(authenticated)/dashboard/requests/AskList.tsx
- src/app/(authenticated)/dashboard/requests/BatchReport.tsx
- src/app/(authenticated)/dashboard/requests/RequestsClient.tsx
- src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts
- src/app/api/dashboard/solicitation/batch/reviewed/route.ts
- src/app/api/dashboard/solicitation/batch/route.ts
- src/lib/solicitation/__tests__/batch-builder.integration.test.ts
- src/lib/solicitation/__tests__/batch-view.integration.test.ts
- src/lib/solicitation/__tests__/batch-view.test.ts

