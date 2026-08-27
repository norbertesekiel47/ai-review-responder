# Blast radius — importers of changed files (`feat-qr-review-request`)

Resolved-specifier import search (TypeScript AST); verify semantic impact per caller.

## `src/app/(authenticated)/settings/review-qr/page.tsx` — 0 importer(s)
_none found (entry point, or dynamic/config-driven usage — check registration sites)_

## `src/app/(authenticated)/settings/review-qr/print/[businessId]/page.tsx` — 0 importer(s)
_none found (entry point, or dynamic/config-driven usage — check registration sites)_

## `src/app/(authenticated)/settings/review-qr/PrintButton.tsx` — 2 importer(s)
- src/app/(authenticated)/settings/review-qr/__tests__/PrintButton.test.tsx
- src/app/(authenticated)/settings/review-qr/print/[businessId]/page.tsx

## `src/app/(authenticated)/settings/review-qr/ReviewQrClient.tsx` — 2 importer(s)
- src/app/(authenticated)/settings/review-qr/__tests__/ReviewQrClient.test.tsx
- src/app/(authenticated)/settings/review-qr/page.tsx

## `src/app/q/[businessId]/route.ts` — 1 importer(s)
- src/app/q/[businessId]/__tests__/route.test.ts

## `src/components/dashboard/settings/SettingsSidebar.tsx` — 2 importer(s)
- src/app/(authenticated)/settings/layout.tsx
- src/components/dashboard/settings/__tests__/SettingsSidebar.test.tsx

## `src/lib/analytics/events.ts` — 17 importer(s)
- scripts/ci/analytics-events-audit.ts
- src/app/api/analytics/enqueue/route.ts
- src/app/api/auth/verify-otp/route.ts
- src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts
- src/app/api/zernio/connect/start/route.ts
- src/app/q/[businessId]/route.ts
- src/lib/account-offboarding/analytics.ts
- src/lib/analytics/__tests__/events.test.ts
- src/lib/analytics/activation-event.ts
- src/lib/analytics/enqueue.ts
- src/lib/analytics/trial-events.ts
- src/lib/competitors/named-rival.ts
- src/lib/payments/plan-activation.ts
- src/lib/reviews/process-review.ts
- src/lib/shared/__tests__/migration-115-qr-scan-analytics-event.integration.test.ts
- src/lib/shared/logger.ts
- worker/jobs/response-generation/analytics.ts

## `src/lib/locations/repo.ts` — 20 importer(s)
- src/__tests__/tenant-isolation.integration.test.ts
- src/app/(authenticated)/dashboard/add-location/page.tsx
- src/app/(authenticated)/settings/competitors/page.tsx
- src/app/(authenticated)/settings/voice/page.tsx
- src/app/api/account/settings/route.ts
- src/app/api/dashboard/policy.ts
- src/app/api/locations/add/route.ts
- src/app/api/locations/promote-primary/route.ts
- src/app/api/locations/reactivate/route.ts
- src/app/api/settings/voice/route.ts
- src/lib/admin/csv-import.ts
- src/lib/channels/overrides-view.ts
- src/lib/cross-area-flows/__tests__/cross-area-flows.test.ts
- src/lib/dashboard/__tests__/aggregate-service.degradation.test.ts
- src/lib/dashboard/__tests__/aggregate-service.test.ts
- src/lib/dashboard/aggregate-service.ts
- src/lib/locations/__tests__/repo.test.ts
- src/lib/locations/archive-location-tx.ts
- src/lib/locations/review-qr.ts
- src/lib/locations/settings-view.ts

## `src/lib/locations/review-qr.ts` — 7 importer(s)
- src/app/(authenticated)/settings/review-qr/ReviewQrClient.tsx
- src/app/(authenticated)/settings/review-qr/__tests__/ReviewQrClient.test.tsx
- src/app/(authenticated)/settings/review-qr/page.tsx
- src/app/(authenticated)/settings/review-qr/print/[businessId]/page.tsx
- src/app/q/[businessId]/route.ts
- src/lib/locations/__tests__/review-qr.integration.test.ts
- src/lib/locations/__tests__/review-qr.test.ts

## `src/lib/shared/subscription-status.ts` — 93 importer(s)
- src/app/(authenticated)/dashboard/connect/page.tsx
- src/app/admin/businesses/[id]/BusinessDetailClient.tsx
- src/app/admin/businesses/[id]/_components/ChannelsPanel.tsx
- src/app/admin/businesses/[id]/_components/PastDueExtensionPanel.tsx
- src/app/api/_shared/channels/resolve-actor.ts
- src/app/api/account/settings/route.ts
- src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts
- src/app/api/auth/finish-signup/route.ts
- src/app/api/auth/signup-status/route.ts
- src/app/api/billing/__tests__/checkout-params.test.ts
- src/app/api/billing/__tests__/checkout.test.ts
- src/app/api/billing/checkout/__tests__/route.test.ts
- src/app/api/billing/checkout/route.ts
- src/app/api/billing/portal/route.ts
- src/app/api/dashboard/channels/route.ts
- src/app/api/dashboard/route.ts
- src/app/api/onboarding/business/route.ts
- src/app/api/onboarding/demo/regenerate/route.ts
- src/app/api/onboarding/start/route.ts
- src/app/api/settings/route.ts
- src/app/api/signup/place-prefill/route.ts
- src/app/onboarding/business/guard.ts
- src/app/onboarding/demo/page.tsx
- src/app/onboarding/pay/PlanPickerClient.tsx
- src/app/onboarding/pay/page.tsx
- src/app/onboarding/payment-success/PaymentSuccessClient.tsx
- src/app/onboarding/start/page.tsx
- src/components/admin/ui/StatusBadge.tsx
- src/components/admin/ui/__tests__/StatusBadge.test.tsx
- src/components/dashboard/DashboardContent.tsx
- src/components/dashboard/aggregate/AggregateDashboardContent.tsx
- src/components/dashboard/reviews/ReviewsContent.tsx
- src/components/dashboard/settings/BillingPanel.tsx
- src/hooks/useSettingsForm.ts
- src/lib/__fixtures__/account-location.ts
- src/lib/accounts/quota.ts
- src/lib/accounts/repo.ts
- src/lib/accounts/tier-change.ts
- src/lib/admin/margin-service.ts
- src/lib/auth/require-owner-access.ts
- src/lib/auth/resolve-owner-scope.ts
- src/lib/auto-approval/__tests__/settings.test.ts
- src/lib/auto-approval/settings-guards.ts
- src/lib/cross-area-flows/__tests__/cross-area-flows.test.ts
- src/lib/dashboard/scope.ts
- src/lib/db/account-guard.ts
- src/lib/locations/__tests__/multi-location-mode.test.ts
- src/lib/locations/__tests__/review-qr.test.ts
- src/lib/locations/multi-location-mode.ts
- src/lib/locations/review-qr.ts
- src/lib/onboarding/__tests__/funnel-entry.test.ts
- src/lib/onboarding/__tests__/resend-invite.test.ts
- src/lib/onboarding/create-business.ts
- src/lib/onboarding/funnel-entry.ts
- src/lib/onboarding/resend-invite.ts
- src/lib/payments/__tests__/plan-activation.test.ts
- src/lib/payments/create-checkout-session.ts
- src/lib/payments/plan-activation.ts
- src/lib/responses/__tests__/judge-store.integration.test.ts
- src/lib/shared/__tests__/migration-105-checkout-attempt-coupon.integration.test.ts
- src/lib/shared/__tests__/subscription-status.test.ts
- src/lib/shared/__tests__/writable-subscription.test.ts
- src/lib/shared/past-due-recovery.ts
- src/lib/shared/subscription-eligibility-sql.ts
- src/lib/shared/subscription-guard.ts
- src/lib/shared/writable-subscription.ts
- src/lib/solicitation/__tests__/auto-approval.test.ts
- src/lib/solicitation/ask-generation.ts
- src/lib/solicitation/auto-approval.ts
- src/lib/solicitation/batch-builder.ts
- src/lib/solicitation/release.ts
- worker/__tests__/solicitation-attribution.test.ts
- worker/background/pollers/CancellationGracePoller.ts
- worker/background/pollers/StripeLocationsReconcilePoller.ts
- worker/background/pollers/billing-reconciliation/reconcile-account.ts
- worker/background/schedulers/OnboardingDripScheduler.ts
- worker/background/schedulers/__tests__/OnboardingDripScheduler.test.ts
- worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts
- worker/ingress/__tests__/stripe-activation-enqueue.test.ts
- worker/ingress/__tests__/stripe-checkout-completed.test.ts
- worker/ingress/__tests__/stripe-invoice-paid.test.ts
- worker/ingress/__tests__/stripe-subscription-deleted.test.ts
- worker/ingress/stripe/apply-subscription-state.ts
- worker/ingress/stripe/checkout-completed.ts
- worker/ingress/stripe/invoice-paid.ts
- worker/ingress/stripe/invoice-payment-failed.ts
- worker/ingress/stripe/subscription-updated.ts
- worker/jobs/OnboardingDemoWorker.ts
- worker/jobs/OnboardingDripWorker.ts
- worker/jobs/RankingTrackingWorker.ts
- worker/jobs/__tests__/onboarding-drip.integration.test.ts
- worker/jobs/billing/StripeSubscriptionMirrorSyncWorker.ts
- worker/jobs/billing/UpdateStripeOverageWorker.ts
