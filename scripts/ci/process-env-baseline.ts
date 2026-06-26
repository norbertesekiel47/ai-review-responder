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
  // ── Stage-3 src-lib batch: FOUNDATIONAL import-time readers ────────────────
  // These read env at MODULE LOAD to construct a client/singleton or a limit
  // constant. Routing them through a config accessor would force an import-time
  // getServerConfig() parse (the accessor is lazy by design), so they stay
  // sanctioned process.env homes and their reads are left byte-for-byte.
  //
  // db/server.ts: top-level `postgres(DATABASE_POOL_URL!, { max: DB_POOL_MAX })`
  // and `createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!)` — the primary
  // Postgres.js + Supabase service clients, constructed at import.
  'src/lib/db/server.ts',
  // db/redis-cache.ts: getCacheRedisOptions() builds the ioredis cache client
  // options from REDIS_CACHE_URL/REDIS_CACHE_TOKEN (the `url!` non-null +
  // URL-shape branch is the singleton constructor).
  'src/lib/db/redis-cache.ts',
  // demos/fetch-reviews.ts: reads SERPAPI_API_KEY at MODULE TOP-LEVEL with a
  // module-load fail-fast throw (so the missing key surfaces at import, not at
  // first fetch). (MOCK_EXTERNAL_APIS is exempt #2.)
  'src/lib/demos/fetch-reviews.ts',
  // admin/cost-report-service.ts: the *_CENTS daily cost limits are read at
  // MODULE TOP-LEVEL to build the TIER_LIMITS_CENTS / GLOBAL_DAILY_LIMIT_CENTS
  // constants. CRITICAL cost-limit math — preserved byte-for-byte; allowlisted
  // rather than forced into an import-time parse.
  'src/lib/admin/cost-report-service.ts',
  // shared/logger.ts: the universal structured logger, imported by ~93 modules
  // ultra-early. Its only non-exempt read is LOG_SERVICE (a tolerate-absent
  // `?? 'worker'` service label); NODE_ENV is exempt #2. Routing the lowest-level
  // logging utility through getServerConfig() risks an import cycle and adds a
  // memoized parse to a hot path — allowlisted as a config-adjacent foundational
  // reader (see plan: revisit only with a proven no-cycle migration).
  'src/lib/shared/logger.ts',
]);

export function isAllowlisted(file: string): boolean {
  return ALLOWLIST_PREFIXES.some((prefix) => file.startsWith(prefix)) || ALLOWLIST_FILES.has(file);
}

export const PROCESS_ENV_BASELINE: ReadonlySet<string> = new Set<string>([
  'src/lib/account-offboarding/flags.ts',
  'src/lib/admin/business-detail/mappers.ts',
  // Stage-3 src-lib batch MIGRATED (removed): admin/impersonation/cookie.ts,
  // analytics/posthog.ts, costs/onboarding-demo-cost-guard.ts,
  // google/owner-leads-sheet.ts, shared/feedback-hmac.ts,
  // shared/session-cookie-secret.ts, shared/worker-public-url.ts — now read via
  // getServerConfig(). Stage-3 src-lib batch ALLOWLISTED (moved up to
  // ALLOWLIST_FILES): admin/cost-report-service.ts, db/redis-cache.ts,
  // db/server.ts, demos/fetch-reviews.ts, shared/logger.ts (import-time readers).
  // costs/tracker.ts STAYS below (CRITICAL cost guard, deferred — dynamic *_CENTS key).
  'src/lib/auth/require-owner-access.ts',
  'src/lib/auto-approval/flags.ts',
  'src/lib/channels/override.ts',
  'src/lib/costs/tracker.ts',
  'src/lib/db/auth.ts',
  'src/lib/db/browser.ts',
  'src/lib/locations/owner-route.ts',
  'src/lib/moderation/moderate.ts',
  // Stage-3 notification-channels batch removed the 5 fully-migrated SEND
  // adapters (email-channel.ts, telegram-client.ts, whatsapp-client.ts,
  // whatsapp-channel.ts, whatsapp-body.ts). They are reached only by the worker
  // (the getChannel() factory + auto-post-notice dispatch + telegram/twilio
  // ingress), so their channel-send secret reads (RESEND_FROM_EMAIL /
  // TELEGRAM_BOT_TOKEN / TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
  // TWILIO_WHATSAPP_NUMBER / WHATSAPP_APPROVAL_TEMPLATE_SID /
  // WHATSAPP_AUTOPOST_TEMPLATE_SID) now go through getWorkerConfig() — 4 new
  // rawOpt vars + 3 reused. No import-time reader → none allowlisted. index.ts
  // below STAYS: its only reads are the Stage-4 CHANNELS_*_ENABLED flags. Net 38 → 33.
  'src/lib/notifications/channels/index.ts',
  'src/lib/onboarding/admin-onboarding-service.ts',
  'src/lib/past-replies/flags.ts',
  'src/lib/payments/create-checkout-session.ts',
  'src/lib/payments/payment-link.ts',
  // Stage-3 serpapi-redis batch MIGRATED (removed): reviews/place-id-resolver.ts
  // (worker-only → getWorkerConfig()), reviews/serpapi-prefill.ts (Next-only) +
  // shared/rate-limit.ts (dual Next+worker) → getServerConfig(). All 3 fully
  // migrated: REDIS_CACHE_URL + SERPAPI_API_KEY switched opt→rawOpt and
  // SERPAPI_TIMEOUT_MS added (rawOpt); serpapi-prefill's module-level
  // SERPAPI_TIMEOUT_MS read was moved into fetchBusinessDetails. No import-time
  // readers remain, so none is allowlisted. Net 42 → 39.
  'src/lib/shared/csrf.ts',
  // (shared/feedback-hmac.ts, shared/session-cookie-secret.ts,
  //  shared/worker-public-url.ts migrated to getServerConfig() — Stage-3 src-lib
  //  batch; shared/logger.ts moved to ALLOWLIST_FILES. shared/rate-limit.ts
  //  migrated to getServerConfig() — Stage-3 serpapi-redis batch, see above.)
  // Stage-3 zernio-transport batch MIGRATED (removed): zernio/client/transport.ts —
  // ZERNIO_API_BASE / ZERNIO_API_KEY now read via getServerConfig() (rawOpt,
  // fallbacks intact), in-fn AFTER the mock short-circuit. MOCK_ZERNIO_LOCATION_COUNT
  // is exempted as a mock-fixture knob (audit isExemptIndicatorName), and
  // MOCK_EXTERNAL_APIS stays a direct exempt read (#2) — so no counted read remains
  // and no import-time reader → not allowlisted. Net 39 → 38.
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
