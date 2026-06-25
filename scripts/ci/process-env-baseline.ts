// scripts/ci/process-env-baseline.ts
//
// Committed baseline: in-scope files (src/lib/**, worker/**) that read a
// NON-EXEMPT process.env var TODAY, outside the sanctioned config home. Generated
// by the audit's own scan (do NOT hand-edit entries). Shrinks to 0 over Stage 3 as
// reads migrate onto the config accessors. Adding a NEW reader requires migrating
// it instead — that is the point of this guard.
//
// EXEMPT env indicators (NODE_ENV, MOCK_EXTERNAL_APIS, VERCEL_*) are NOT config —
// they stay direct process.env reads and the audit does not count them (Stage-3
// convention #2). A file that reads ONLY exempt indicators is therefore not in
// this baseline (e.g. src/lib/shared/mock-mode.ts, src/lib/approval/cookies.ts).
//
// ALLOWLIST = the only sanctioned process.env homes. Stage 4 will add the shared
// `readFlag` primitive's module here when it lands (the per-feature flags.ts
// accessors route through readFlag, which becomes the allowlisted env reader).

const ALLOWLIST_PREFIXES = ['src/lib/config/'] as const;
const ALLOWLIST_FILES = new Set<string>([
  'worker/env.ts',
  'worker/config/startup-assert.ts',
]);

export function isAllowlisted(file: string): boolean {
  return ALLOWLIST_PREFIXES.some((prefix) => file.startsWith(prefix)) || ALLOWLIST_FILES.has(file);
}

export const PROCESS_ENV_BASELINE: ReadonlySet<string> = new Set<string>([
  'src/lib/account-offboarding/flags.ts',
  'src/lib/admin/business-detail/mappers.ts',
  'src/lib/admin/cost-report-service.ts',
  'src/lib/admin/impersonation/cookie.ts',
  'src/lib/analytics/posthog.ts',
  'src/lib/auth/require-owner-access.ts',
  'src/lib/auto-approval/flags.ts',
  'src/lib/channels/override.ts',
  'src/lib/costs/onboarding-demo-cost-guard.ts',
  'src/lib/costs/tracker.ts',
  'src/lib/db/auth.ts',
  'src/lib/db/browser.ts',
  'src/lib/db/redis-cache.ts',
  'src/lib/db/server.ts',
  'src/lib/demos/fetch-reviews.ts',
  'src/lib/google/owner-leads-sheet.ts',
  'src/lib/locations/owner-route.ts',
  'src/lib/moderation/moderate.ts',
  'src/lib/notifications/channels/email-channel.ts',
  'src/lib/notifications/channels/index.ts',
  'src/lib/notifications/channels/telegram-client.ts',
  'src/lib/notifications/channels/whatsapp-body.ts',
  'src/lib/notifications/channels/whatsapp-channel.ts',
  'src/lib/notifications/channels/whatsapp-client.ts',
  'src/lib/onboarding/admin-onboarding-service.ts',
  'src/lib/past-replies/flags.ts',
  'src/lib/payments/create-checkout-session.ts',
  'src/lib/payments/payment-link.ts',
  'src/lib/payments/price-tier-map.ts',
  'src/lib/payments/stripe-client.ts',
  'src/lib/reviews/place-id-resolver.ts',
  'src/lib/reviews/serpapi-prefill.ts',
  'src/lib/shared/csrf.ts',
  'src/lib/shared/feedback-hmac.ts',
  'src/lib/shared/logger.ts',
  'src/lib/shared/rate-limit.ts',
  'src/lib/shared/session-cookie-secret.ts',
  'src/lib/shared/worker-public-url.ts',
  'src/lib/zernio/client/transport.ts',
  'worker/background/pollers/AccountOffboardingAccessEndPoller.ts',
  'worker/background/pollers/AccountOffboardingPurgePoller.ts',
  'worker/background/pollers/AccountOffboardingPurgeReminderPoller.ts',
  'worker/background/pollers/AccountOffboardingReactivationResetPoller.ts',
  'worker/background/pollers/AccountOffboardingTeardownRetryPoller.ts',
  'worker/background/pollers/AnalyticsDispatchPoller.ts',
  'worker/background/pollers/ArchivalPoller.ts',
  'worker/background/pollers/CancellationGracePoller.ts',
  'worker/background/pollers/CleanupAbandonedSignupsPoller.ts',
  'worker/background/pollers/EmailChannelReconcilePoller.ts',
  'worker/background/pollers/EngagementMonitorPoller.ts',
  'worker/background/pollers/HealthAlertPoller.ts',
  'worker/background/pollers/NotificationFailoverPoller.ts',
  'worker/background/pollers/OutboxPoller.ts',
  'worker/background/pollers/StripeLocationsReconcilePoller.ts',
  'worker/background/pollers/ZernioRecentReviewPoller.ts',
  'worker/background/pollers/billing-reconciliation/drift-alert.ts',
  'worker/background/pollers/health-alert/checks.ts',
  'worker/background/pollers/health-alert/emit.ts',
  'worker/background/schedulers/MonthlyImpactScheduler.ts',
  'worker/background/schedulers/OnboardingDripScheduler.ts',
  'worker/background/schedulers/RankingTrackingScheduler.ts',
  'worker/background/schedulers/WeeklySummaryScheduler.ts',
  'worker/index.ts',
  'worker/ingress/resend.ts',
  'worker/ingress/stripe.ts',
  'worker/ingress/stripe/shared.ts',
  'worker/ingress/telegram/telegram-verify.ts',
  'worker/ingress/twilio/twilio-delivery-status.ts',
  'worker/ingress/twilio/twilio-whatsapp-inbound.ts',
  'worker/ingress/zernio/zernio.ts',
  'worker/jobs/AdminExceptionWorker.ts',
  'worker/jobs/EngagementAlertWorker.ts',
  'worker/jobs/MonthlyImpactWorker.ts',
  'worker/jobs/OnboardingDripWorker.ts',
  'worker/jobs/OwnerEmailWorker.ts',
  'worker/jobs/RankingTrackingWorker.ts',
  'worker/jobs/WeeklySummaryWorker.ts',
  'worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts',
  'worker/jobs/auto-post-notice/AutoPostNoticeWorker.ts',
  'worker/jobs/auto-post-notice/dispatch.ts',
  'worker/jobs/notification/NotificationWorker.ts',
  'worker/jobs/notification/eligibility.ts',
  'worker/jobs/publisher/ResponsePublisherWorker.ts',
  'worker/jobs/publisher/failed-hook.ts',
  'worker/jobs/zernio/ZernioReviewIngestWorker.ts',
  'worker/jobs/zernio/zernio-ingest-shared.ts',
  'worker/redis-connection.ts',
  'worker/sentry.ts',
]);
