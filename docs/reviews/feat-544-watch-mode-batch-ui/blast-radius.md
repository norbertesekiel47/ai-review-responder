# Blast radius — importers of changed files (`feat-544-watch-mode-batch-ui`)

Heuristic import-text search; verify semantic impact per caller.

## `src/app/(authenticated)/dashboard/requests/BatchReport.tsx` — 2 importer(s)
- src/app/(authenticated)/dashboard/requests/RequestsClient.tsx
- src/app/(authenticated)/dashboard/requests/__tests__/batch-report.test.tsx

## `src/app/(authenticated)/dashboard/requests/GhostPipeline.tsx` — 1 importer(s)
- src/app/(authenticated)/dashboard/requests/RequestsClient.tsx

## `src/app/(authenticated)/dashboard/requests/RequestsClient.tsx` — 2 importer(s)
- src/app/(authenticated)/dashboard/requests/__tests__/requests-client.test.tsx
- src/app/(authenticated)/dashboard/requests/page.tsx

## `src/app/(authenticated)/dashboard/requests/contacts/ContactList.tsx` — 2 importer(s)
- src/app/(authenticated)/dashboard/requests/contacts/ContactsClient.tsx
- src/app/(authenticated)/dashboard/requests/contacts/__tests__/contacts-ui.test.tsx

## `src/app/(authenticated)/dashboard/requests/contacts/ContactsClient.tsx` — 1 importer(s)
- src/app/(authenticated)/dashboard/requests/contacts/page.tsx

## `src/app/(authenticated)/dashboard/requests/contacts/UploadCard.tsx` — 2 importer(s)
- src/app/(authenticated)/dashboard/requests/contacts/ContactsClient.tsx
- src/app/(authenticated)/dashboard/requests/contacts/__tests__/contacts-ui.test.tsx

## `src/app/(authenticated)/dashboard/requests/contacts/page.tsx` — 4 importer(s)
- src/app/(authenticated)/dashboard/connect/__tests__/console-restyle.test.tsx
- src/app/(authenticated)/dashboard/connect/__tests__/page.test.tsx
- src/app/(authenticated)/dashboard/connect/select-location/__tests__/page.test.tsx
- src/app/(public)/approve/[token]/__tests__/page.test.tsx

## `src/app/(authenticated)/dashboard/requests/page.tsx` — 4 importer(s)
- src/app/(authenticated)/dashboard/connect/__tests__/console-restyle.test.tsx
- src/app/(authenticated)/dashboard/connect/__tests__/page.test.tsx
- src/app/(authenticated)/dashboard/connect/select-location/__tests__/page.test.tsx
- src/app/(public)/approve/[token]/__tests__/page.test.tsx

## `src/app/(authenticated)/layout.tsx` — 0 importer(s)
_none found (entry point, or dynamic/config-driven usage — check registration sites)_

## `src/app/api/dashboard/solicitation/batch/reviewed/route.ts` — 73 importer(s)
- src/__tests__/eslint-boundaries.test.ts
- src/app/api/account/offboarding/__tests__/fresh-auth.test.ts
- src/app/api/account/settings/__tests__/route-plan-presentation.test.ts
- src/app/api/admin/businesses/[id]/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/channels/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts
- src/app/api/admin/businesses/__tests__/route.test.ts
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
- src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts
- src/app/api/dashboard/channels/telegram/__tests__/start.test.ts
- src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts
- src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts
- src/app/api/dashboard/channels/whatsapp/__tests__/enroll-e2e.integration.test.ts
- src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts
- src/app/api/dashboard/contacts/__tests__/flag-404.test.ts
- src/app/api/dashboard/escalations/__tests__/route.test.ts
- src/app/api/dashboard/kpis/__tests__/route.test.ts
- src/app/api/dashboard/reviews/[reviewId]/timeline/__tests__/route.test.ts
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
- src/app/api/settings/voice/__tests__/route.test.ts
- src/app/api/settings/voice/report-card/__tests__/route.test.ts
- src/app/api/signup/__tests__/place-prefill.test.ts
- src/app/api/zernio/connect/callback/__tests__/route.test.ts
- src/app/api/zernio/connect/cancel/__tests__/route.test.ts
- src/app/api/zernio/connect/select-location/__tests__/route.test.ts
- src/app/api/zernio/connect/start/__tests__/route.test.ts
- src/app/api/zernio/disconnect/__tests__/route.test.ts
- src/app/r/google/[responseId]/__tests__/route.test.ts
- worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts

## `src/app/api/dashboard/solicitation/batch/route.ts` — 73 importer(s)
- src/__tests__/eslint-boundaries.test.ts
- src/app/api/account/offboarding/__tests__/fresh-auth.test.ts
- src/app/api/account/settings/__tests__/route-plan-presentation.test.ts
- src/app/api/admin/businesses/[id]/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/channels/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts
- src/app/api/admin/businesses/__tests__/route.test.ts
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
- src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts
- src/app/api/dashboard/channels/telegram/__tests__/start.test.ts
- src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts
- src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts
- src/app/api/dashboard/channels/whatsapp/__tests__/enroll-e2e.integration.test.ts
- src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts
- src/app/api/dashboard/contacts/__tests__/flag-404.test.ts
- src/app/api/dashboard/escalations/__tests__/route.test.ts
- src/app/api/dashboard/kpis/__tests__/route.test.ts
- src/app/api/dashboard/reviews/[reviewId]/timeline/__tests__/route.test.ts
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
- src/app/api/settings/voice/__tests__/route.test.ts
- src/app/api/settings/voice/report-card/__tests__/route.test.ts
- src/app/api/signup/__tests__/place-prefill.test.ts
- src/app/api/zernio/connect/callback/__tests__/route.test.ts
- src/app/api/zernio/connect/cancel/__tests__/route.test.ts
- src/app/api/zernio/connect/select-location/__tests__/route.test.ts
- src/app/api/zernio/connect/start/__tests__/route.test.ts
- src/app/api/zernio/disconnect/__tests__/route.test.ts
- src/app/r/google/[responseId]/__tests__/route.test.ts
- worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts

## `src/app/api/dashboard/solicitation/scope-param.ts` — 2 importer(s)
- src/app/(authenticated)/dashboard/requests/RequestsClient.tsx
- src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts

## `src/components/dashboard/shell/MobileTabBar.tsx` — 2 importer(s)
- src/app/(authenticated)/layout.tsx
- src/components/dashboard/__tests__/MobileTabBar.test.tsx

## `src/components/dashboard/shell/Sidebar.tsx` — 2 importer(s)
- src/app/(authenticated)/layout.tsx
- src/components/dashboard/__tests__/Sidebar.test.tsx

## `src/lib/solicitation/batch-view.ts` — 9 importer(s)
- src/app/(authenticated)/dashboard/requests/BatchReport.tsx
- src/app/(authenticated)/dashboard/requests/RequestsClient.tsx
- src/app/(authenticated)/dashboard/requests/__tests__/batch-report.test.tsx
- src/app/(authenticated)/dashboard/requests/__tests__/requests-client.test.tsx
- src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts
- src/app/api/dashboard/solicitation/batch/reviewed/route.ts
- src/app/api/dashboard/solicitation/batch/route.ts
- src/lib/solicitation/__tests__/batch-view.integration.test.ts
- src/lib/solicitation/__tests__/batch-view.test.ts

