# Blast radius — importers of changed files (`feat-865-admin-halt-surface`)

Heuristic import-text search; verify semantic impact per caller.

## `src/app/admin/businesses/[id]/_components/SolicitationBatchPanel.tsx` — 1 importer(s)
- src/app/admin/businesses/[id]/BusinessDetailClient.tsx

## `src/app/admin/businesses/[id]/BusinessDetailClient.tsx` — 2 importer(s)
- src/app/admin/businesses/[id]/__tests__/BusinessDetailClient.test.tsx
- src/app/admin/businesses/[id]/page.tsx

## `src/app/admin/businesses/[id]/page.tsx` — 5 importer(s)
- src/app/__tests__/unsubscribe-landing.test.tsx
- src/app/(authenticated)/dashboard/connect/__tests__/console-restyle.test.tsx
- src/app/(authenticated)/dashboard/connect/__tests__/page.test.tsx
- src/app/(authenticated)/dashboard/connect/select-location/__tests__/page.test.tsx
- src/app/(public)/approve/[token]/__tests__/page.test.tsx

## `src/app/api/admin/solicitation/batch/halt/route.ts` — 82 importer(s)
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

## `src/lib/solicitation/approval.ts` — 13 importer(s)
- src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx
- src/app/api/admin/solicitation/batch/__tests__/routes.test.ts
- src/app/api/admin/solicitation/batch/halt/route.ts
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

## `src/lib/solicitation/batch-view.ts` — 17 importer(s)
- src/app/(authenticated)/dashboard/requests/__tests__/approval-panel.test.tsx
- src/app/(authenticated)/dashboard/requests/__tests__/batch-report.test.tsx
- src/app/(authenticated)/dashboard/requests/__tests__/requests-client.test.tsx
- src/app/(authenticated)/dashboard/requests/ApprovalPanel.tsx
- src/app/(authenticated)/dashboard/requests/AskList.tsx
- src/app/(authenticated)/dashboard/requests/BatchReport.tsx
- src/app/(authenticated)/dashboard/requests/RequestsClient.tsx
- src/app/admin/businesses/[id]/_components/__tests__/SolicitationBatchPanel.test.tsx
- src/app/admin/businesses/[id]/_components/SolicitationBatchPanel.tsx
- src/app/admin/businesses/[id]/BusinessDetailClient.tsx
- src/app/admin/businesses/[id]/page.tsx
- src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts
- src/app/api/dashboard/solicitation/batch/reviewed/route.ts
- src/app/api/dashboard/solicitation/batch/route.ts
- src/lib/solicitation/__tests__/batch-builder.integration.test.ts
- src/lib/solicitation/__tests__/batch-view.integration.test.ts
- src/lib/solicitation/__tests__/batch-view.test.ts

