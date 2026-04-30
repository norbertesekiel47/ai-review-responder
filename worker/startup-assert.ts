// worker/startup-assert.ts
//
// Boot-time env-var assertions. Kept in a standalone module (rather than inside
// worker/index.ts) so unit tests can import the function without triggering the
// heavy top-level side effects of index.ts (Sentry.init, Fastify instance,
// BullMQ Worker construction which opens Redis connections, etc.).

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
  if (!process.env.STRIPE_PAYMENT_LINK_FOUNDING || !process.env.STRIPE_PAYMENT_LINK_STANDARD || !process.env.STRIPE_PAYMENT_LINK_PREMIUM) {
    throw new Error('[startup] SELF_SERVE_SIGNUP_ENABLED=true requires STRIPE_PAYMENT_LINK_FOUNDING + STRIPE_PAYMENT_LINK_STANDARD + STRIPE_PAYMENT_LINK_PREMIUM');
  }
}

/**
 * Boot-time assertion. When CHANNELS_SMS_ENABLED=true, verifies all required
 * Twilio env vars are set. Fail fast at startup rather than at first enrollment
 * or send. No-op when the flag is off or in MOCK_EXTERNAL_APIS mode.
 */
export function assertChannelsSmsEnv(): void {
  if (process.env.CHANNELS_SMS_ENABLED !== 'true') return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const required = [
    'WORKER_PUBLIC_URL',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_MESSAGING_SERVICE_SID',
    'TWILIO_VERIFY_SERVICE_SID',
  ];
  const missing = required.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
  if (missing.length > 0) {
    throw new Error(`CHANNELS_SMS_ENABLED=true but missing required env vars: ${missing.join(', ')}`);
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
 * Boot-time assertion for WhatsApp. Self-contained — does NOT depend on
 * assertChannelsSmsEnv (which early-returns when SMS flag is off). A
 * WA-on / SMS-off deployment otherwise boots with unverified Twilio config.
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
}
