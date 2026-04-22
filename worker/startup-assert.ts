// worker/startup-assert.ts
//
// Boot-time env-var assertions. Kept in a standalone module (rather than inside
// worker/index.ts) so unit tests can import the function without triggering the
// heavy top-level side effects of index.ts (Sentry.init, Fastify instance,
// BullMQ Worker construction which opens Redis connections, etc.).

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
