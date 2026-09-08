# Blast radius — importers of changed files (`feat/1183-admin-transport-seam`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/lib/auth/admin-mfa-gate.ts` — 25 importer(s)
- src/app/api/_shared/channels/resolve-actor.ts
- src/app/api/admin/autonomy/suspensions/route.ts
- src/app/api/admin/autonomy/unsuspend/route.ts
- src/app/api/admin/billing/grant-extension/route.ts
- src/app/api/admin/businesses/[id]/keywords/route.ts
- src/app/api/admin/businesses/[id]/ranking/route.ts
- src/app/api/admin/businesses/[id]/resend-invite/route.ts
- src/app/api/admin/businesses/[id]/route.ts
- src/app/api/admin/businesses/[id]/zernio-queue/route.ts
- src/app/api/admin/businesses/route.ts
- src/app/api/admin/demos/generate/route.ts
- src/app/api/admin/flagged/route.ts
- src/app/api/admin/impersonation/end/route.ts
- src/app/api/admin/impersonation/start/route.ts
- src/app/api/admin/locations/csv-import/route.ts
- src/app/api/admin/offboardings/[offboardingId]/provider-disposition/route.ts
- src/app/api/admin/offboardings/route.ts
- src/app/api/admin/solicitation/batch/halt/route.ts
- src/app/api/admin/solicitation/breaker/reset/route.ts
- src/app/api/admin/solicitation/breaker/route.ts
- src/app/api/admin/suppressions/correct/route.ts
- src/app/api/admin/suppressions/lookup/route.ts
- src/app/api/admin/suppressions/route.ts
- src/lib/auth/__tests__/admin-mfa-gate.test.ts
- src/lib/auth/__tests__/admin-transport-seam.test.ts

## `src/lib/auth/admin-transport.ts` — 2 importer(s)
- src/lib/auth/__tests__/admin-transport.test.ts
- src/lib/auth/verified-identity.ts

## `src/lib/auth/verified-identity.ts` — 2 importer(s)
- src/lib/auth/__tests__/verified-identity.test.ts
- src/lib/auth/admin-mfa-gate.ts

## `src/lib/db/auth.ts` — 59 importer(s)
- src/app/api/_shared/channels/__tests__/resolve-actor.test.ts
- src/app/api/admin/autonomy/__tests__/routes.test.ts
- src/app/api/admin/billing/grant-extension/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts
- src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts
- src/app/api/admin/businesses/__tests__/route.test.ts
- src/app/api/admin/channels/whatsapp/__tests__/start.test.ts
- src/app/api/admin/costs/__tests__/route.test.ts
- src/app/api/admin/costs/route.ts
- src/app/api/admin/demos/generate/__tests__/route.test.ts
- src/app/api/admin/flagged/__tests__/route.test.ts
- src/app/api/admin/impersonation/end/__tests__/route.test.ts
- src/app/api/admin/impersonation/start/__tests__/route.test.ts
- src/app/api/admin/locations/csv-import/__tests__/route.test.ts
- src/app/api/admin/offboardings/__tests__/route.test.ts
- src/app/api/admin/solicitation/batch/__tests__/routes.test.ts
- src/app/api/billing/__tests__/checkout.test.ts
- src/app/api/billing/__tests__/portal.test.ts
- src/app/api/billing/tier-change/__tests__/route.test.ts
- src/app/api/dashboard/__tests__/route.test.ts
- src/app/api/dashboard/channels/telegram/__tests__/start.test.ts
- src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts
- src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts
- src/app/api/dashboard/past-replies/__tests__/draft-status.test.ts
- src/app/api/dashboard/past-replies/__tests__/draft.test.ts
- src/app/api/dashboard/past-replies/__tests__/publish.test.ts
- src/app/api/dashboard/past-replies/__tests__/restore-original.test.ts
- src/app/api/dashboard/past-replies/__tests__/retry.test.ts
- src/app/api/dashboard/policy.ts
- src/app/api/dashboard/reviews/__tests__/actions.test.ts
- src/app/api/locations/__tests__/add.test.ts
- src/app/api/locations/__tests__/archive.test.ts
- src/app/api/locations/__tests__/promote-primary.test.ts
- src/app/api/locations/reactivate/__tests__/route.test.ts
- src/app/api/settings/__tests__/route.test.ts
- src/app/api/settings/channels/override/__tests__/route.test.ts
- src/app/api/settings/channels/overrides/__tests__/route.test.ts
- src/app/api/settings/postal-address/__tests__/route.test.ts
- src/app/api/settings/voice/__tests__/route.test.ts
- src/app/api/zernio/connect/_shared/callback/claim-and-verify.ts
- src/app/api/zernio/connect/_shared/finalize/__tests__/finalize-modules.test.ts
- src/app/api/zernio/connect/_shared/finalize/authorize.ts
- src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts
- src/app/api/zernio/connect/cancel/route.ts
- src/app/api/zernio/connect/start/route.ts
- src/app/api/zernio/disconnect/route.ts
- src/lib/account-offboarding/destructive-auth.ts
- src/lib/approval/__tests__/http-routes.test.ts
- src/lib/approval/http-routes.ts
- src/lib/auth/__tests__/admin-transport-seam.test.ts
- src/lib/auth/__tests__/resolve-owner-scope.test.ts
- src/lib/auth/__tests__/route-helpers.test.ts
- src/lib/auth/admin-mfa-gate.ts
- src/lib/auth/resolve-owner-scope.ts
- src/lib/auth/route-helpers.ts
- src/lib/auth/verified-identity.ts
- src/lib/db/__tests__/auth.test.ts
- src/lib/locations/__tests__/owner-route.test.ts
- src/lib/locations/owner-route.ts
