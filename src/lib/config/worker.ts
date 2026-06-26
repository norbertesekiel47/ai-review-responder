// src/lib/config/worker.ts
//
// WORKER lane — Railway worker-process env. Self-loads .env.local before the
// first parse so a worker module imported outside worker/index.ts can't parse an
// empty env. Root schema is shape-only; getWorkerConfig is lazy + memoized.
// assertWorkerConfig mirrors worker/config/startup-assert.ts CORE_INFRA_REQUIRED_ENV
// (no more) so no env that boots today newly fails.
import { z } from 'zod';
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';
import { ensureWorkerDotenvLoaded } from './dotenv-load';
import { optionalVar, rawOptionalVar, requirePresent, requirePresentIn, requiredVar } from './schema-helpers';
import {
  STRIPE_REQUIRED_VARS,
  narrowStripeConfig,
  type StripeEnvConfig,
} from './stripe-shape';

const nonEmpty = requiredVar;
const opt = optionalVar;
// Raw passthrough for MIGRATED reads whose call site does its own normalization
// (!value / `envInterval ? parseInt`). Preserves ''/'   '/unset exactly like the
// old process.env.X (convention #7). Do NOT use the collapsing `opt` for these.
const rawOpt = rawOptionalVar;

const stripePriceShape = Object.fromEntries(
  STRIPE_PRICE_ENV_VARS.map((name) => [name, opt]),
) as Record<(typeof STRIPE_PRICE_ENV_VARS)[number], typeof opt>;

const workerSchema = z.object({
  DATABASE_POOL_URL: nonEmpty,
  SUPABASE_URL: nonEmpty,
  SUPABASE_SERVICE_KEY: nonEmpty,
  REDIS_QUEUE_URL: nonEmpty,
  // subsystem secrets (optional)
  STRIPE_SECRET_KEY: opt,
  // Migrated raw read: worker/ingress/stripe.ts does `if (!webhookSecret)` on the
  // RAW value, so rawOptionalVar (not the collapsing opt) keeps the truthy check
  // byte-identical to the old process.env.STRIPE_WEBHOOK_SECRET (#7).
  // getWorkerStripeConfig/narrowStripeConfig still treat whitespace as absent.
  STRIPE_WEBHOOK_SECRET: rawOpt,
  ...stripePriceShape,
  RESEND_API_KEY: opt,
  // Migrated raw read (Stage-3 worker-jobs batch): RankingTrackingWorker passes
  // SERPAPI_API_KEY straight to the SerpAPI SDK (`api_key: cfg.SERPAPI_API_KEY`)
  // with no `?.trim()` and no presence assert (tolerate-read), so rawOptionalVar
  // keeps `''`/`'   '` byte-identical to the old raw `process.env.SERPAPI_API_KEY`
  // (#7). getWorkerSerpapiConfig/assertWorkerSerpapiConfig still treat whitespace
  // as absent via requirePresentIn/requirePresent.
  SERPAPI_API_KEY: rawOpt,
  OPENAI_API_KEY: opt,
  ANTHROPIC_API_KEY: opt,
  // shape-only optionals (presence owned by startup-assert.ts this Stage)
  REDIS_CACHE_URL: opt,
  // Migrated raw reads (Stage-3 worker-pollers batch): NotificationFailoverPoller
  // reads ADMIN_NOTIFICATION_EMAIL raw (`if (adminEmail)` / `if (!adminEmail)`) and
  // drift-alert.ts reads SENTRY_DSN raw (`if (X)` Sentry-vs-warn gate), so rawOpt
  // keeps `'   '` truthy (#7). The boot asserts (assertAdminNotificationEmail /
  // assertAlertSinkEnv in worker/config/startup-assert.ts) read process.env directly
  // with their own trim check, so whitespace-as-absent boot semantics are unchanged.
  ADMIN_NOTIFICATION_EMAIL: rawOpt,
  SENTRY_DSN: rawOpt,
  WORKER_PUBLIC_URL: opt,
  DATABASE_URL: opt,
  // Migrated raw read: StripeLocationsReconcilePoller owns its own
  // `envInterval ? parseInt(envInterval, 10) : NaN` parse + default, so
  // rawOptionalVar preserves ''/'   '/unset exactly like the old raw read (#7).
  STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS: rawOpt,

  // ── Stage-3 worker-pollers batch ──────────────────────────────────────────
  // Every poller-tuning var below is read at its call site with the site's own
  // `process.env.X ? parse : DEFAULT` (or `parseInt(X || '', 10)` + Finite/range)
  // guard, so rawOptionalVar preserves ''/'   '/unset byte-for-byte (#7). All
  // poller files are worker-only → worker lane (getWorkerConfig).
  ACCOUNT_OFFBOARDING_ACCESS_END_INTERVAL_MS: rawOpt,
  ACCOUNT_OFFBOARDING_ACCESS_END_BATCH_SIZE: rawOpt,
  ACCOUNT_OFFBOARDING_PURGE_INTERVAL_MS: rawOpt,
  ACCOUNT_OFFBOARDING_PURGE_BATCH_SIZE: rawOpt,
  ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS: rawOpt,
  ACCOUNT_OFFBOARDING_PURGE_REMINDER_INTERVAL_MS: rawOpt,
  ACCOUNT_OFFBOARDING_PURGE_REMINDER_BATCH_SIZE: rawOpt,
  ACCOUNT_OFFBOARDING_REACTIVATION_RESET_INTERVAL_MS: rawOpt,
  ACCOUNT_OFFBOARDING_REACTIVATION_RESET_BATCH_SIZE: rawOpt,
  ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_INTERVAL_MS: rawOpt,
  ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_BATCH_SIZE: rawOpt,
  ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_COOLDOWN_MS: rawOpt,
  ACCOUNT_OFFBOARDING_TEARDOWN_MAX_RETRIES: rawOpt,
  ANALYTICS_DISPATCH_POLL_INTERVAL_MS: rawOpt,
  ANALYTICS_DISPATCH_BATCH_SIZE: rawOpt,
  ARCHIVAL_INTERVAL_MS: rawOpt,
  CANCELLATION_GRACE_INTERVAL_MS: rawOpt,
  CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE: rawOpt,
  CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS: rawOpt,
  EMAIL_CHANNEL_RECONCILE_BATCH_SIZE: rawOpt,
  EMAIL_CHANNEL_RECONCILE_INTERVAL_MS: rawOpt,
  ENGAGEMENT_MONITOR_INTERVAL_MS: rawOpt,
  HEALTH_ALERT_POLL_INTERVAL_MS: rawOpt,
  NOTIFICATION_FAILOVER_INTERVAL_MS: rawOpt,
  OUTBOX_POLL_INTERVAL_MS: rawOpt,
  OUTBOX_BATCH_SIZE: rawOpt,
  OUTBOX_DISPATCH_TIMEOUT_MS: rawOpt,
  OUTBOX_POLL_MAX_CYCLE_MS: rawOpt,
  ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS: rawOpt,
  ZERNIO_RECENT_REVIEW_POLL_PAGE_SIZE: rawOpt,
  ZERNIO_RECENT_REVIEW_POLL_MAX_PAGES: rawOpt,
  ZERNIO_RECENT_REVIEW_POLL_MAX_CONNECTIONS: rawOpt,
  ZERNIO_RECENT_REVIEW_POLL_CONCURRENCY: rawOpt,
  ZERNIO_RECENT_REVIEW_POLL_DEADLINE_MS: rawOpt,
  ZERNIO_RECENT_REVIEW_POLL_INTERVAL_MS: rawOpt,
  HEALTH_ALERT_PENDING_AGE_S: rawOpt,
  HEALTH_ALERT_FAILED_WINDOW_S: rawOpt,
  HEALTH_ALERT_FAILED_THRESHOLD: rawOpt,
  HEALTH_ALERT_STALE_DISPATCHING_S: rawOpt,
  HEALTH_ALERT_FLAGGED_OPEN_THRESHOLD: rawOpt,
  HEALTH_ALERT_ZERO_DELIVERY_WINDOW_S: rawOpt,
  HEALTH_ALERT_MONITOR_SLUG: rawOpt,

  // ── Stage-3 worker-jobs batch ─────────────────────────────────────────────
  // worker/jobs/** non-flag reads. All worker-only (no Next-route consumer) →
  // worker lane. Each call site owns its own truthy/`!`/`parseInt` guard, so
  // rawOptionalVar preserves ''/'   '/unset byte-for-byte (#7).
  // NEXT_PUBLIC_APP_URL is migrated here (NOT exempt under convention #1): the
  // exemption guards Next BUILD-TIME inlining, but the tsx worker never bundles,
  // so a worker read of it is a plain runtime process.env read with no inlining to
  // break (Convention #1 refinement — see the worker-jobs plan doc).
  NEXT_PUBLIC_APP_URL: rawOpt,
  RESEND_FROM_EMAIL: rawOpt,
  CSRF_SECRET: rawOpt,
  WHATSAPP_AUTOPOST_TEMPLATE_SID: rawOpt,
  ZERNIO_INGEST_MAX_PAGES: rawOpt,

  // ── Stage-3 worker-ingress batch ──────────────────────────────────────────
  // Webhook SIGNATURE-VERIFICATION secrets. Each is migrated from a raw
  // process.env read in a worker/ingress/** handler and is compared RAW in the
  // verification primitive: RESEND/ZERNIO feed createHmac(...) directly,
  // TELEGRAM is one side of timingSafeEqual(Buffer.from(...,'utf8')), and
  // TWILIO_AUTH_TOKEN is passed raw to twilio.validateRequest(...). Each call
  // site owns its own `if (!secret)` presence gate (fail-closed reject in prod,
  // fail-open only in MOCK_EXTERNAL_APIS). So rawOptionalVar preserves
  // ''/'   '/unset byte-for-byte (#7) — the collapsing optionalVar could map a
  // whitespace secret to undefined and FLIP a verification outcome (security
  // hole or spurious reject). No asserting accessor (#5): a throw would replace
  // the handler's own 401/false behavior. (ADMIN_NOTIFICATION_EMAIL — the
  // resend.ts hard-bounce alert recipient — is ALREADY rawOpt above.)
  RESEND_WEBHOOK_SECRET: rawOpt,
  TELEGRAM_WEBHOOK_SECRET: rawOpt,
  TWILIO_AUTH_TOKEN: rawOpt,
  ZERNIO_WEBHOOK_SECRET: rawOpt,
});

export type WorkerConfig = z.infer<typeof workerSchema>;

export const WORKER_REQUIRED_VARS = [
  'DATABASE_POOL_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'REDIS_QUEUE_URL',
] as const;

let memo: WorkerConfig | undefined;

// Stage-2 foundation: the per-subsystem accessors/asserts below have no
// production consumer YET — Stage 3 migrates the raw worker process.env reads onto
// them in batches (wiring a subsystem assert before its subsystem uses
// getXConfig() would be premature). Suppress the "unused-export" finding until
// their batch consumes them. getWorkerConfig itself IS now consumed (Stage-3
// Stripe batch: worker/ingress/stripe.ts, StripeLocationsReconcilePoller.ts), so
// it carries no suppression.

/** Lazy, memoized parse — self-loads dotenv first. NEVER at import time. */
export function getWorkerConfig(): WorkerConfig {
  if (!memo) {
    ensureWorkerDotenvLoaded();
    memo = workerSchema.parse(process.env);
  }
  return memo;
}

/**
 * Test-only: clear the memo so the NEXT getWorkerConfig() re-parses the current
 * process.env. Used by poller tests that mutate a migrated tuning var mid-file and
 * assert the parsed result (production env is immutable, so this seam never runs in
 * prod). Clears ONLY the memo — NOT ensureWorkerDotenvLoaded's `loaded` flag — so a
 * test's `delete process.env.X` is never repopulated from a real .env.local.
 */
export function resetWorkerConfigForTests(): void {
  memo = undefined;
}

// Same carve-out as assertCoreInfraEnv: a no-op only in non-prod MOCK mode.
function mockSkip(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.MOCK_EXTERNAL_APIS === 'true';
}

/** Worker core-infra boot assert. Mirrors CORE_INFRA_REQUIRED_ENV. */
export function assertWorkerConfig(): void {
  ensureWorkerDotenvLoaded();
  if (mockSkip()) return;
  requirePresent(WORKER_REQUIRED_VARS, 'core-infra');
}

export type WorkerStripeConfig = StripeEnvConfig;

// fallow-ignore-next-line unused-export
export function assertWorkerStripeConfig(): void {
  requirePresent(STRIPE_REQUIRED_VARS, 'stripe');
}

export function getWorkerStripeConfig(): WorkerStripeConfig {
  return narrowStripeConfig(getWorkerConfig(), 'stripe');
}

// fallow-ignore-next-line unused-export
export function assertWorkerResendConfig(): void { requirePresent(['RESEND_API_KEY'], 'resend'); }
// fallow-ignore-next-line unused-export
export function getWorkerResendConfig(): { RESEND_API_KEY: string } {
  const cfg = getWorkerConfig();
  requirePresentIn(cfg, ['RESEND_API_KEY'], 'resend');
  return { RESEND_API_KEY: cfg.RESEND_API_KEY! };
}

// fallow-ignore-next-line unused-export
export function assertWorkerSerpapiConfig(): void { requirePresent(['SERPAPI_API_KEY'], 'serpapi'); }
// fallow-ignore-next-line unused-export
export function getWorkerSerpapiConfig(): { SERPAPI_API_KEY: string } {
  const cfg = getWorkerConfig();
  requirePresentIn(cfg, ['SERPAPI_API_KEY'], 'serpapi');
  return { SERPAPI_API_KEY: cfg.SERPAPI_API_KEY! };
}

// fallow-ignore-next-line unused-export
export function assertWorkerOpenAiConfig(): void { requirePresent(['OPENAI_API_KEY'], 'openai'); }
// fallow-ignore-next-line unused-export
export function getWorkerOpenAiConfig(): { OPENAI_API_KEY: string } {
  const cfg = getWorkerConfig();
  requirePresentIn(cfg, ['OPENAI_API_KEY'], 'openai');
  return { OPENAI_API_KEY: cfg.OPENAI_API_KEY! };
}

// fallow-ignore-next-line unused-export
export function assertWorkerAnthropicConfig(): void { requirePresent(['ANTHROPIC_API_KEY'], 'anthropic'); }
// fallow-ignore-next-line unused-export
export function getWorkerAnthropicConfig(): { ANTHROPIC_API_KEY: string } {
  const cfg = getWorkerConfig();
  requirePresentIn(cfg, ['ANTHROPIC_API_KEY'], 'anthropic');
  return { ANTHROPIC_API_KEY: cfg.ANTHROPIC_API_KEY! };
}
