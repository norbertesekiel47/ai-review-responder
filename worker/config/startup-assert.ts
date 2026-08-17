// worker/config/startup-assert.ts
//
// Boot-time env-var assertions. Kept in a standalone module (rather than inside
// worker/index.ts) so unit tests can import the function without triggering the
// heavy top-level side effects of index.ts (Sentry.init, Fastify instance,
// BullMQ Worker construction which opens Redis connections, etc.).

import {
  assertStripePriceIdsUnique,
  STRIPE_PRICE_ENV_VARS,
} from '../../src/lib/payments/price-tier-map';
import { assertTierDailyCostLimitsConfigured } from '../../src/lib/costs/tier-cost-limits';
import {
  deploymentLaneFields,
  requiresProductionConfig,
} from '../../src/lib/config/deployment-lane';

const STRIPE_WORKER_REQUIRED_ENV = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  ...STRIPE_PRICE_ENV_VARS,
];

// The pillars every worker job and poller depends on. They are consumed via
// non-null assertions deep in the data layer (postgres(DATABASE_POOL_URL!),
// createClient(SUPABASE_URL!, SUPABASE_SERVICE_KEY!)), so a missing/typo'd value
// otherwise boots "successfully", passes the dependency-light health check, and
// then fails on the FIRST query — jobs crash-loop and burn retries with an
// opaque error instead of a clear boot failure. (REDIS_QUEUE_URL already throws
// at module load via new URL(undefined), so it is covered by construction.)
const CORE_INFRA_REQUIRED_ENV = [
  'DATABASE_POOL_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'REDIS_QUEUE_URL',
];

const SERVER_ONLY_FEATURE_OPTIONAL_BOOLEAN_ENV = [
  'ACCOUNT_OFFBOARDING_ENABLED',
  'AUTOPILOT_PURCHASABLE',
  'AUTO_APPROVAL_ENABLED',
  'AUTO_APPROVAL_PROVIDER_MODERATION_READY',
  'GOVERNOR_ENABLED',
  'JUDGE_ENABLED',
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

/**
 * The lane a boot gate fired on, rendered as `<VARIABLE>=<lane>` — e.g.
 * `RAILWAY_ENVIRONMENT_NAME=production` or `NODE_ENV=production`. Every gate
 * below is now keyed off the deployment lane rather than NODE_ENV alone, so a
 * boot failure has to carry the lane AND the variable it was read from;
 * otherwise "why did this fire?" is unanswerable from the crash log.
 *
 * It is embedded in the THROWN message rather than logged or tagged on Sentry
 * deliberately: the gate that most needs the proof (assertAlertSinkEnv) fires
 * precisely when SENTRY_DSN is the missing thing, so any Sentry-routed
 * explanation would be inert exactly when it is needed.
 */
function laneProof(): string {
  const { deployment_lane: lane, lane_source: source } = deploymentLaneFields();
  if (!source) return `deployment lane ${lane} (neither RAILWAY_ENVIRONMENT_NAME nor NODE_ENV set)`;
  return `${source}=${lane}`;
}

export function assertProductionMockModeEnv(): void {
  if (requiresProductionConfig() && process.env.MOCK_EXTERNAL_APIS === 'true') {
    throw new Error(`[startup] ${laneProof()} cannot run with MOCK_EXTERNAL_APIS=true`);
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
  if (!requiresProductionConfig() && process.env.MOCK_EXTERNAL_APIS === 'true') return;

  const missing = missingEnvVars(STRIPE_WORKER_REQUIRED_ENV);
  if (missing.length > 0) {
    throw new Error(`[startup] Worker requires ${missing.join(', ')} (${laneProof()})`);
  }
  assertStripePriceIdsUnique();
}

/**
 * Fail fast at boot when a core-infrastructure connection string is missing,
 * rather than crash-looping on the first DB/Redis op. Gated identically to
 * assertStripeWorkerEnv: a no-op only in undeployed MOCK_EXTERNAL_APIS mode
 * (local dev / unit tests), enforced everywhere else — the mock-mode skip is
 * unavailable on any deployed lane, including one that leaves NODE_ENV unset.
 */
export function assertCoreInfraEnv(): void {
  if (!requiresProductionConfig() && process.env.MOCK_EXTERNAL_APIS === 'true') return;

  const missing = missingEnvVars(CORE_INFRA_REQUIRED_ENV);
  if (missing.length > 0) {
    throw new Error(`[startup] Worker requires ${missing.join(', ')} (${laneProof()})`);
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

const SUMMED_LLM_WORKER_SLOT_CAP = 9;
const FLAG_GATED_LLM_WORKER_SLOT_CAP = 1;
const FLAG_ON_LLM_ENVELOPE_CAP = 11;

/**
 * Boot-time guard for the per-process LLM worker-slot cap (ADR 0005 addendum,
 * amended 2026-07-20). The summed BullMQ concurrency across the LLM-calling
 * queues is a per-process worker-slot budget — the de-facto GLOBAL LLM
 * concurrency bound ONLY under single-replica deployment (ADR 0005). Effective
 * slots per entry = opts.concurrency ?? 1 (BullMQ's default — most of the
 * LLM workers register with bare workerOpts). Non-flag-gated entries must sum
 * to <= SUMMED_LLM_WORKER_SLOT_CAP; each flag-gated entry (judge_verdict,
 * generate_solicitation_asks) is capped separately at
 * FLAG_GATED_LLM_WORKER_SLOT_CAP so booting with the flag ON never trips the
 * sum. The all-flags-on worst case (non-gated sum + every flag-gated slot) is
 * additionally bounded by FLAG_ON_LLM_ENVELOPE_CAP — the ADR 0005 flag-on
 * envelope, 9+1+1 = 11 today — so a third flag-gated lane cannot silently
 * widen the worst case; adding one forces the global-semaphore conversation.
 * Raising the sum past ~10 requires building the
 * global Redis semaphore first (ADR 0005 deferral trigger).
 *
 * Scope note: per-job LLM fan-out (the demo Promise.allSettled over ≤15
 * reviews) is a sanctioned unguarded lane — bounded by the demo review-count
 * cap and admin rate limits, NOT by cost guards and NOT by this assert.
 *
 * Called at the registration site in worker/index.ts with the EFFECTIVE
 * Worker options (worker.opts), same as assertSingleConcurrencyWorker, so an
 * edit of any options object fails the boot instead of silently widening the
 * LLM concurrency envelope.
 */
export function assertSummedLlmWorkerSlots(
  entries: ReadonlyArray<{
    queueName: string;
    opts: { concurrency?: number };
    flagGated?: boolean;
  }>,
): void {
  const effectiveSlots = (opts: { concurrency?: number }): number => opts.concurrency ?? 1;

  const nonGated = entries.filter((entry) => !entry.flagGated);
  const summedSlots = nonGated.reduce((total, entry) => total + effectiveSlots(entry.opts), 0);
  if (summedSlots > SUMMED_LLM_WORKER_SLOT_CAP) {
    const inventory = nonGated
      .map((entry) => `${entry.queueName}=${effectiveSlots(entry.opts)}`)
      .join(', ');
    throw new Error(
      `[startup] Summed non-flag-gated LLM worker slots (${inventory}) total ${summedSlots}, `
        + `exceeding the worker-slot cap of ${SUMMED_LLM_WORKER_SLOT_CAP}. Per ADR 0005, raising `
        + `the sum past ~10 requires building the global Redis semaphore first.`,
    );
  }

  for (const entry of entries) {
    if (!entry.flagGated) continue;
    const slots = effectiveSlots(entry.opts);
    if (slots > FLAG_GATED_LLM_WORKER_SLOT_CAP) {
      throw new Error(
        `[startup] Flag-gated LLM queue ${entry.queueName} registered with ${slots} worker slots; `
          + `the flag-gated cap is ${FLAG_GATED_LLM_WORKER_SLOT_CAP}. Per ADR 0005, raising the `
          + `sum past ~10 requires building the global Redis semaphore first.`,
      );
    }
  }

  const flagGatedSlots = entries
    .filter((entry) => entry.flagGated)
    .reduce((total, entry) => total + effectiveSlots(entry.opts), 0);
  const flagOnWorstCase = summedSlots + flagGatedSlots;
  if (flagOnWorstCase > FLAG_ON_LLM_ENVELOPE_CAP) {
    const inventory = entries
      .map((entry) => `${entry.queueName}=${effectiveSlots(entry.opts)}${entry.flagGated ? ' (flag-gated)' : ''}`)
      .join(', ');
    throw new Error(
      `[startup] All-flags-on LLM worker slots (${inventory}) total ${flagOnWorstCase}, `
        + `exceeding the ADR 0005 flag-on envelope of ${FLAG_ON_LLM_ENVELOPE_CAP}. Per ADR 0005, `
        + `widening the worst case past ~10 requires building the global Redis semaphore first.`,
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
 * Deployed-lane guard: fires on any deployed lane (or NODE_ENV=production) when
 * MOCK_EXTERNAL_APIS is not 'true', so dev / CI / tests are unaffected.
 * (Intentionally narrower than assertStripeWorkerEnv, which also fires on
 * undeployed non-mock environments — admin alerts only matter once deployed.)
 * The per-site runtime guards remain as defense-in-depth.
 */
export function assertAdminNotificationEmail(): void {
  if (!requiresProductionConfig()) return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const value = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (!value || value.trim().length === 0) {
    throw new Error(
      `[startup] Worker requires ADMIN_NOTIFICATION_EMAIL (${laneProof()}) — admin/failover/engagement alerts route here`,
    );
  }
}

/**
 * Boot-time assertion. SENTRY_DSN is the mandatory non-email paging route for
 * P0/P1 alerts: HealthAlertPoller findings, cost-cap exhaustion, and the poller's
 * Sentry Cron-monitor heartbeat all route through Sentry → Slack/PagerDuty. Email
 * alerts share the Resend provider with the product, so a Resend outage would
 * blind both product and alerting; Sentry must be present so paging cannot be
 * silently inert in production. Deployed-lane-only (and non-mock), mirroring
 * assertAdminNotificationEmail. (Beta-launch gate, plan A1.)
 *
 * This gate is the reason the lane, not NODE_ENV, decides: production leaves
 * NODE_ENV unset, so keying off NODE_ENV made the one guard whose whole purpose
 * is "paging cannot be silently inert" itself silently inert (#611).
 */
export function assertAlertSinkEnv(): void {
  if (!requiresProductionConfig()) return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const value = process.env.SENTRY_DSN;
  if (!value || value.trim().length === 0) {
    throw new Error(
      `[startup] Worker requires SENTRY_DSN (${laneProof()}) — mandatory non-email alert sink for P0/P1 paging`,
    );
  }
}

/**
 * Boot-time warnings (non-fatal) for vars that degrade silently in production but
 * are not strictly required to boot:
 *   - LIST_UNSUBSCRIBE_EMAIL: marketing emails fall back to a non-functional
 *     mailbox and may fail Gmail/Outlook bulk-sender compliance.
 *
 * (SENTRY_DSN moved to assertAlertSinkEnv — it is now a hard production gate.)
 *
 * Only warns on a deployed lane (and non-mock) so dev / CI / tests stay quiet.
 */
export function warnMissingProductionEnv(): void {
  if (!requiresProductionConfig()) return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const checks: Array<{ key: string; message: string }> = [
    {
      key: 'LIST_UNSUBSCRIBE_EMAIL',
      message:
        'marketing emails will use a non-functional unsubscribe mailbox and may fail Gmail/Outlook bulk-sender compliance',
    },
  ];
  for (const { key, message } of checks) {
    const value = process.env[key];
    if (!value || value.trim().length === 0) {
      console.warn(`[startup] ${key} is unset (${laneProof()}) — ${message}`);
    }
  }
}

export function assertWorkerStartupEnv(): void {
  assertProductionMockModeEnv();
  assertCoreInfraEnv();
  assertStripeWorkerEnv();
  assertTierDailyCostLimitsConfigured();
  assertAdminNotificationEmail();
  assertAlertSinkEnv();
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
 * by the caller's required-list check; this only checks format. On a deployed
 * lane, requires https. Undeployed, http or https are both accepted (e.g.
 * http://localhost:3001). In all cases the value must be an origin-only URL —
 * no path, query string, fragment, trailing slash, or userinfo. (F-13/P3)
 *
 * Private helper reached from BOTH assertChannelsWhatsAppEnv and
 * assertZernioPublishingEnv, so the https requirement tightens on both.
 */
function assertWorkerPublicUrlFormat(): void {
  const raw = process.env.WORKER_PUBLIC_URL;
  if (!raw) return; // presence is enforced by the caller's required-list check
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`WORKER_PUBLIC_URL must be a valid origin URL (got: ${raw})`);
  }
  const httpsRequired = requiresProductionConfig();
  const protocolOk = httpsRequired ? url.protocol === 'https:' : url.protocol === 'https:' || url.protocol === 'http:';
  // raw === url.origin rejects path/query/fragment/trailing-slash/userinfo in one shot.
  if (!protocolOk || raw !== url.origin) {
    throw new Error(
      `WORKER_PUBLIC_URL must be an origin-only URL (${httpsRequired ? 'https://<host>' : 'http(s)://<host>'}, ` +
        `no path/query/fragment/trailing slash; got: ${raw}) (${laneProof()})`,
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

/**
 * Boot-time assertion for the solicitation Sending identity (#657, spec §9).
 * A worker that boots with sending enabled and no From address is a worker that
 * fails at dispatch time instead of boot time.
 *
 * When SOLICITATION_SEND_ENABLED=true:
 *   - verify all 4 solicitation env vars are non-empty
 *   - verify SOLICITATION_PLATFORM_DAILY_CAP parses as a non-negative integer
 *
 * An explicit 0 is VALID — that is the warm-up dial at rest, not a
 * misconfiguration. Unparseable is not: presence alone would let a typo reach
 * dispatch, where §9's "unparseable ⇒ 0" would silently stop every send.
 *
 * No-op when the flag is off or in MOCK_EXTERNAL_APIS=true.
 */
export function assertSolicitationSendEnv(): void {
  if (process.env.SOLICITATION_SEND_ENABLED !== 'true') return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const required = [
    'SOLICITATION_RESEND_API_KEY',
    'SOLICITATION_SEND_FROM_ADDRESS',
    'SOLICITATION_PLATFORM_DAILY_CAP',
    'SOLICITATION_UNSUBSCRIBE_MAILTO',
  ];
  const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
  if (missing.length > 0) {
    throw new Error(
      `SOLICITATION_SEND_ENABLED=true but missing required env vars: ${missing.join(', ')}`,
    );
  }
  // Names the var, never the value — the key is in the same required list.
  const cap = Number(process.env.SOLICITATION_PLATFORM_DAILY_CAP!.trim());
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error(
      'SOLICITATION_SEND_ENABLED=true but SOLICITATION_PLATFORM_DAILY_CAP is not a non-negative integer',
    );
  }
}
