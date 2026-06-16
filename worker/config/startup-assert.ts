// worker/config/startup-assert.ts
//
// Boot-time env-var assertions. Kept in a standalone module (rather than inside
// worker/index.ts) so unit tests can import the function without triggering the
// heavy top-level side effects of index.ts (Sentry.init, Fastify instance,
// BullMQ Worker construction which opens Redis connections, etc.).

import { STRIPE_PRICE_ENV_VARS } from '../../src/lib/payments/price-tier-map';

const STRIPE_WORKER_REQUIRED_ENV = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  ...STRIPE_PRICE_ENV_VARS,
];

const SERVER_ONLY_FEATURE_OPTIONAL_BOOLEAN_ENV = [
  'ACCOUNT_OFFBOARDING_ENABLED',
  'AUTO_APPROVAL_ENABLED',
  'AUTO_APPROVAL_PROVIDER_MODERATION_READY',
  'STRIPE_TAX_ENABLED',
] as const;

function missingEnvVars(required: string[]): string[] {
  return required.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
}

function invalidOptionalBooleanEnv(required: readonly string[]): string[] {
  return required.filter((key) => {
    const value = process.env[key];
    return value !== undefined && value !== 'true' && value !== 'false';
  });
}

export function assertProductionMockModeEnv(): void {
  if (process.env.NODE_ENV === 'production' && process.env.MOCK_EXTERNAL_APIS === 'true') {
    throw new Error('[startup] NODE_ENV=production cannot run with MOCK_EXTERNAL_APIS=true');
  }
}

export function assertServerOnlyFeatureOptionalBooleansEnv(): void {
  const invalid = invalidOptionalBooleanEnv(SERVER_ONLY_FEATURE_OPTIONAL_BOOLEAN_ENV);
  if (invalid.length > 0) {
    throw new Error(
      `[startup] Optional server-only feature boolean env vars must be exactly 'true' or 'false': ${invalid.join(', ')}`,
    );
  }
}

export function assertStripeWorkerEnv(): void {
  if (process.env.NODE_ENV !== 'production' && process.env.MOCK_EXTERNAL_APIS === 'true') return;

  const missing = missingEnvVars(STRIPE_WORKER_REQUIRED_ENV);
  if (missing.length > 0) {
    throw new Error(`[startup] Worker requires ${missing.join(', ')}`);
  }
}

/**
 * Boot-time guard for workers whose correctness depends on serialized job
 * execution. UpdateStripeOverageWorker's operation-scoped Stripe idempotency
 * keys (overage-sync.ts) assume no two overage jobs run concurrently — its
 * registration must carry concurrency: 1. Called at the registration site in
 * worker/index.ts with the EFFECTIVE Worker options (worker.opts), so an edit
 * of the options object fails the boot instead of silently double-running jobs.
 */
export function assertSingleConcurrencyWorker(
  queueName: string,
  opts: { concurrency?: number },
): void {
  if (opts.concurrency !== 1) {
    throw new Error(
      `[startup] ${queueName} worker must be registered with concurrency: 1 `
        + `(operation-scoped idempotency keys assume serialized jobs); got ${String(opts.concurrency)}`,
    );
  }
}

/**
 * Boot-time assertion. ADMIN_NOTIFICATION_EMAIL is the recipient for every admin
 * exception / failover / engagement alert. When unset these alerts silently drop:
 * AdminExceptionWorker marks the outbox completed, NotificationFailoverPoller warns
 * and continues, and EngagementAlertWorker logs an error and fails the outbox —
 * unacceptable in production. Fail fast at boot instead.
 *
 * Production-only guard: fires only when NODE_ENV=production and MOCK_EXTERNAL_APIS
 * is not 'true', so dev / CI / tests are unaffected. (Intentionally narrower than
 * assertStripeWorkerEnv, which also fires in non-production non-mock environments —
 * admin alerts only matter in production.) The per-site runtime guards remain as
 * defense-in-depth.
 */
export function assertAdminNotificationEmail(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const value = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (!value || value.trim().length === 0) {
    throw new Error(
      '[startup] Worker requires ADMIN_NOTIFICATION_EMAIL in production (admin/failover/engagement alerts route here)',
    );
  }
}

/**
 * Boot-time warnings (non-fatal) for vars that degrade silently in production but
 * are not strictly required to boot:
 *   - LIST_UNSUBSCRIBE_EMAIL: marketing emails fall back to a non-functional
 *     mailbox and may fail Gmail/Outlook bulk-sender compliance.
 *   - SENTRY_DSN: Sentry no-ops, so production errors go untracked.
 *
 * Only warns in production (and non-mock) so dev / CI / tests stay quiet.
 */
export function warnMissingProductionEnv(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const checks: Array<{ key: string; message: string }> = [
    {
      key: 'LIST_UNSUBSCRIBE_EMAIL',
      message:
        'marketing emails will use a non-functional unsubscribe mailbox and may fail Gmail/Outlook bulk-sender compliance',
    },
    {
      key: 'SENTRY_DSN',
      message: 'Sentry is inert — production errors will not be tracked',
    },
  ];
  for (const { key, message } of checks) {
    const value = process.env[key];
    if (!value || value.trim().length === 0) {
      console.warn(`[startup] ${key} is unset — ${message}`);
    }
  }
}

export function assertWorkerStartupEnv(): void {
  assertProductionMockModeEnv();
  assertStripeWorkerEnv();
  assertAdminNotificationEmail();
  assertServerOnlyFeatureOptionalBooleansEnv();
}

/**
 * Boot-time assertion. When SELF_SERVE_SIGNUP_ENABLED=true, verifies all
 * required env vars are set. Fail fast at startup rather than at first
 * signup attempt. No-op when the flag is off.
 */
export function assertSelfServeSignupEnv(): void {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') return;
  if (!process.env.REDIS_CACHE_URL) {
    throw new Error('[startup] SELF_SERVE_SIGNUP_ENABLED=true requires REDIS_CACHE_URL (strict rate-limit mode)');
  }
  if (!process.env.NEXT_PUBLIC_APP_URL) {
    throw new Error('[startup] SELF_SERVE_SIGNUP_ENABLED=true requires NEXT_PUBLIC_APP_URL');
  }
  // Checkout Sessions replaced Payment Links — STRIPE_PRICE_* vars are
  // required instead of the obsolete payment-link URL vars.
  const missing = STRIPE_PRICE_ENV_VARS.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
  if (missing.length > 0) {
    throw new Error(
      `[startup] SELF_SERVE_SIGNUP_ENABLED=true requires ${missing.join(', ')}`,
    );
  }
}

/**
 * Validates the format of WORKER_PUBLIC_URL when it is set. Presence is enforced
 * by the caller's required-list check; this only checks format. In production,
 * requires https with no trailing slash or path segment. In non-production,
 * http or https are both accepted (e.g. http://localhost:3001), but no trailing
 * slash or path is allowed.
 */
function assertWorkerPublicUrlFormat(): void {
  const url = process.env.WORKER_PUBLIC_URL;
  if (!url) return; // presence is enforced by the caller's required-list check
  const isProd = process.env.NODE_ENV === 'production';
  const pattern = isProd ? /^https:\/\/[^/@]+$/ : /^https?:\/\/[^/@]+$/;
  if (!pattern.test(url)) {
    throw new Error(
      `WORKER_PUBLIC_URL must be ${isProd ? 'https://<host>' : 'http(s)://<host>'} ` +
        `with no trailing slash or path (got: ${url})`,
    );
  }
}

/**
 * Boot-time assertion. When CHANNELS_TELEGRAM_ENABLED=true, verifies all required
 * Telegram env vars are set. Fail fast at startup rather than on first webhook.
 * No-op when the flag is off or MOCK_EXTERNAL_APIS=true.
 */
export function assertChannelsTelegramEnv(): void {
  if (process.env.CHANNELS_TELEGRAM_ENABLED !== 'true') return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'];
  const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
  if (missing.length > 0) {
    throw new Error(`CHANNELS_TELEGRAM_ENABLED=true but missing required env vars: ${missing.join(', ')}`);
  }
}

/**
 * Boot-time assertion for WhatsApp. Self-contained — verifies all required
 * Twilio/WhatsApp env vars are set when CHANNELS_WHATSAPP_ENABLED=true.
 *
 * When CHANNELS_WHATSAPP_ENABLED=true:
 *   - verify all 7 required env vars non-empty
 *   - verify TWILIO_WHATSAPP_NUMBER matches /^whatsapp:\+\d{7,15}$/
 *   - verify WHATSAPP_APPROVAL_URL_BASE === NEXT_PUBLIC_APP_URL + '/approve/'
 *
 * No-op when flag is off or in MOCK_EXTERNAL_APIS=true.
 */
export function assertChannelsWhatsAppEnv(): void {
  if (process.env.CHANNELS_WHATSAPP_ENABLED !== 'true') return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const required = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_WHATSAPP_NUMBER',
    'WHATSAPP_APPROVAL_TEMPLATE_SID',
    'WHATSAPP_APPROVAL_URL_BASE',
    'WORKER_PUBLIC_URL',
    'NEXT_PUBLIC_APP_URL',
  ];
  const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
  if (missing.length > 0) {
    throw new Error(`CHANNELS_WHATSAPP_ENABLED=true but missing required env vars: ${missing.join(', ')}`);
  }
  // Format check — avoid logging the actual value even in the error message
  if (!/^whatsapp:\+\d{7,15}$/.test(process.env.TWILIO_WHATSAPP_NUMBER!)) {
    throw new Error("TWILIO_WHATSAPP_NUMBER must match format 'whatsapp:+<digits>' (7-15 digits)");
  }
  const expected = process.env.NEXT_PUBLIC_APP_URL!.replace(/\/$/, '') + '/approve/';
  if (process.env.WHATSAPP_APPROVAL_URL_BASE !== expected) {
    throw new Error(
      `WHATSAPP_APPROVAL_URL_BASE must equal NEXT_PUBLIC_APP_URL + '/approve/' (expected ${expected})`,
    );
  }
  assertWorkerPublicUrlFormat();
}

/**
 * Boot-time assertion. When ZERNIO_PUBLISHING_ENABLED=true, verifies all
 * required Zernio env vars are set. Fail fast at startup rather than on
 * first publish attempt or webhook. No-op when the flag is off or in
 * MOCK_EXTERNAL_APIS=true.
 *
 * ZERNIO_PROFILE_ID_PREFIX is OPTIONAL (defaults to 'repworth-prod-') and
 * intentionally not asserted.
 */
export function assertZernioPublishingEnv(): void {
  if (process.env.ZERNIO_PUBLISHING_ENABLED !== 'true') return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const required = [
    'ZERNIO_API_KEY',
    'ZERNIO_WEBHOOK_SECRET',
    'WORKER_PUBLIC_URL',
    'NEXT_PUBLIC_APP_URL',
  ];
  const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
  if (missing.length > 0) {
    throw new Error(`ZERNIO_PUBLISHING_ENABLED=true but missing required env vars: ${missing.join(', ')}`);
  }
  assertWorkerPublicUrlFormat();
}

/**
 * Boot-time assertion. When ACCOUNT_OFFBOARDING_ENABLED=true, verifies the env
 * vars the delete_data flow depends on: SESSION_COOKIE_SECRET (keep-my-data token
 * HMAC + fresh-auth stamp) and NEXT_PUBLIC_APP_URL (keep-my-data email link). The
 * AccountOffboardingEmailWorker already fails the outbox visibly when these are
 * missing; this fails fast at boot so the misconfig surfaces before any owner
 * triggers offboarding rather than stranding it at the confirmation email. No-op
 * when the flag is off or in MOCK_EXTERNAL_APIS=true.
 */
export function assertAccountOffboardingEnv(): void {
  if (process.env.ACCOUNT_OFFBOARDING_ENABLED !== 'true') return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const required = ['SESSION_COOKIE_SECRET', 'NEXT_PUBLIC_APP_URL'];
  const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
  if (missing.length > 0) {
    throw new Error(`ACCOUNT_OFFBOARDING_ENABLED=true but missing required env vars: ${missing.join(', ')}`);
  }
  // SESSION_COOKIE_SECRET is guaranteed present here by the missing-vars check above.
  const secret = process.env.SESSION_COOKIE_SECRET!;
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('SESSION_COOKIE_SECRET must be at least 32 bytes (256-bit HMAC key)');
  }
}
