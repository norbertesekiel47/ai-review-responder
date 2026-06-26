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
  // Config-adjacent: the single owner of STRIPE_PRICE_ENV_VARS, the price-var
  // list that src/lib/config/{server,worker}.ts and config/stripe-shape.ts derive
  // their Stripe price schema fields from. Routing its tolerate-absent
  // process.env.STRIPE_PRICE_* reads through getServerConfig() would create a
  // circular import (config/server → price-tier-map → config/server), so it stays
  // a sanctioned process.env home and its reads are left exactly as-is (Stage-3
  // Stripe batch).
  'src/lib/payments/price-tier-map.ts',
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
  'src/lib/reviews/place-id-resolver.ts',
  'src/lib/reviews/serpapi-prefill.ts',
  'src/lib/shared/csrf.ts',
  'src/lib/shared/feedback-hmac.ts',
  'src/lib/shared/logger.ts',
  'src/lib/shared/rate-limit.ts',
  'src/lib/shared/session-cookie-secret.ts',
  'src/lib/shared/worker-public-url.ts',
  'src/lib/zernio/client/transport.ts',
  // Stage-3 worker-pollers batch removed the 15 fully-migrated poller files
  // (all their tuning/alerting reads now go through getWorkerConfig()). The 4
  // pollers below STAY: each still reads a Stage-4 *_ENABLED/*_DISABLED flag.
  'worker/background/pollers/CleanupAbandonedSignupsPoller.ts',
  'worker/background/pollers/EmailChannelReconcilePoller.ts',
  'worker/background/pollers/StripeLocationsReconcilePoller.ts',
  'worker/background/pollers/ZernioRecentReviewPoller.ts',
  'worker/background/schedulers/MonthlyImpactScheduler.ts',
  'worker/background/schedulers/OnboardingDripScheduler.ts',
  'worker/background/schedulers/RankingTrackingScheduler.ts',
  'worker/background/schedulers/WeeklySummaryScheduler.ts',
  'worker/index.ts',
  // Stage-3 worker-ingress batch removed the 4 fully-migrated ingress files
  // (resend.ts, telegram/telegram-verify.ts, twilio/twilio-delivery-status.ts,
  // twilio/twilio-whatsapp-inbound.ts) — their webhook-signature-secret reads
  // (RESEND_WEBHOOK_SECRET / ADMIN_NOTIFICATION_EMAIL / TELEGRAM_WEBHOOK_SECRET /
  // TWILIO_AUTH_TOKEN) now go through getWorkerConfig(). resend.ts's remaining
  // MOCK_EXTERNAL_APIS read is exempt (#2). The 2 ingress files below STAY: each
  // still reads a Stage-4 *_ENABLED flag (ZERNIO_PUBLISHING_ENABLED).
  'worker/ingress/stripe/shared.ts',
  'worker/ingress/zernio/zernio.ts',
  // Stage-3 worker-jobs batch removed the 12 fully-migrated job files (their
  // NEXT_PUBLIC_APP_URL / RESEND_FROM_EMAIL / ADMIN_NOTIFICATION_EMAIL /
  // SERPAPI_API_KEY / CSRF_SECRET / WHATSAPP_AUTOPOST_TEMPLATE_SID /
  // ZERNIO_INGEST_MAX_PAGES reads now go through getWorkerConfig()). The 4 below
  // STAY: each still reads a Stage-4 *_ENABLED/*_DISABLED flag.
  'worker/jobs/notification/eligibility.ts',
  'worker/jobs/publisher/ResponsePublisherWorker.ts',
  'worker/jobs/publisher/failed-hook.ts',
  'worker/jobs/zernio/zernio-ingest-shared.ts',
  'worker/redis-connection.ts',
  'worker/sentry.ts',
]);
