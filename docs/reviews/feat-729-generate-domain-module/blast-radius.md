# Blast radius — importers of changed files (`feat-729-generate-domain-module`)

Heuristic import-text search; verify semantic impact per caller.

## `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts` — 79 importer(s)
- src/__tests__/eslint-boundaries.test.ts
- src/app/__tests__/unsubscribe-landing.test.tsx
- src/app/api/account/offboarding/__tests__/fresh-auth.test.ts
- src/app/api/account/settings/__tests__/route-plan-presentation.test.ts
- src/app/api/admin/businesses/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/channels/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts
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

## `src/lib/reviews/on-demand-generate.ts` — 1 importer(s)
- src/app/api/dashboard/reviews/[reviewId]/generate/route.ts

## `src/lib/shared/response-status-sql.ts` — 6 importer(s)
- src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts
- src/app/api/dashboard/past-replies/[responseId]/retry/route.ts
- src/app/api/dashboard/past-replies/draft/route.ts
- src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts
- src/lib/reviews/on-demand-generate.ts
- src/lib/shared/__tests__/response-status-sql.test.ts

