# Blast radius — importers of changed files (`feat/1186-admin-api-cors`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/lib/config/admin-origins.ts` — 3 importer(s)
- src/__tests__/proxy.test.ts
- src/lib/config/__tests__/admin-origins.test.ts
- src/proxy.ts

## `src/lib/config/flags.ts` — 26 importer(s)
- src/app/api/dashboard/refusals/route.ts
- src/lib/account-offboarding/flags.ts
- src/lib/admin/business-detail/mappers.ts
- src/lib/auth/flags.ts
- src/lib/auto-approval/flags.ts
- src/lib/auto-approval/settings.ts
- src/lib/auto-approval/solicitation-settings.ts
- src/lib/config/__tests__/flags.test.ts
- src/lib/config/admin-origins.ts
- src/lib/db/admission.ts
- src/lib/escalations/flags.ts
- src/lib/llm/flags.ts
- src/lib/locations/flags.ts
- src/lib/moderation/flags.ts
- src/lib/notifications/channels/flags.ts
- src/lib/notifications/flags.ts
- src/lib/onboarding/flags.ts
- src/lib/past-replies/__tests__/flags.test.ts
- src/lib/past-replies/flags.ts
- src/lib/payments/flags.ts
- src/lib/publishing/flags.ts
- src/lib/ranking/flags.ts
- src/lib/refusals/write.ts
- src/lib/responses/judge-flags.ts
- src/lib/reviews/flags.ts
- src/lib/solicitation/flags.ts

## `src/lib/shared/csrf.ts` — 21 importer(s)
- src/app/api/analytics/enqueue/route.ts
- src/app/api/auth/finish-signup/route.ts
- src/app/api/auth/login-attempt/route.ts
- src/app/api/auth/mfa/challenge/route.ts
- src/app/api/auth/reset-password/route.ts
- src/app/api/auth/verify-otp/route.ts
- src/app/api/dashboard/past-replies/_shared/edit-reply-request.ts
- src/app/api/onboarding/business/route.ts
- src/app/api/onboarding/demo/regenerate/route.ts
- src/app/api/onboarding/select-plan/route.ts
- src/app/api/onboarding/start/route.ts
- src/app/api/zernio/connect/_shared/finalize/__tests__/finalize-modules.test.ts
- src/app/api/zernio/connect/_shared/finalize/authorize.ts
- src/app/api/zernio/connect/cancel/route.ts
- src/app/api/zernio/connect/start/route.ts
- src/app/api/zernio/disconnect/route.ts
- src/lib/account-offboarding/destructive-auth.ts
- src/lib/auth/route-helpers.ts
- src/lib/config/admin-origins.ts
- src/lib/locations/owner-route.ts
- src/lib/shared/__tests__/csrf.test.ts

## `src/proxy.ts` — 1 importer(s)
- src/__tests__/proxy.test.ts
