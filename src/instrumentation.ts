import * as Sentry from '@sentry/nextjs';
import { scrubSentryEvent } from '@/lib/shared/sentry-scrub';
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';
import { assertCoreAppConfig } from '@/lib/config/server';

export const onRequestError = Sentry.captureRequestError;

// Soft config-drift surface (no throw — preview deploys legitimately run without
// billing env): if STRIPE_SECRET_KEY is set but price vars are missing, tier
// changes fail closed with missing_price_config. Surface it loudly here so the
// env drift can't masquerade as a code bug.
function reportStripePriceDrift(): void {
  if (!process.env.STRIPE_SECRET_KEY) return;
  const missing = STRIPE_PRICE_ENV_VARS.filter(
    (name) => !process.env[name] || process.env[name]!.trim().length === 0,
  );
  if (missing.length === 0) return;
  const message = `[instrumentation] STRIPE_SECRET_KEY is set but Stripe price env vars are missing: ${missing.join(', ')} — tier changes needing them will fail closed with missing_price_config (env drift, not a code bug).`;
  console.error(message);
  Sentry.captureMessage(message, 'error');
}

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (
      process.env.NODE_ENV === 'production' &&
      (!process.env.SENTRY_DSN || process.env.SENTRY_DSN.trim().length === 0)
    ) {
      console.warn(
        '[instrumentation] SENTRY_DSN is unset — Sentry is inert; production errors will not be tracked.',
      );
    }
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
      beforeSend(event) {
        return scrubSentryEvent(event, { scrubRequestData: true });
      },
    });

    // Core-app config gate (Stage 2): the minimum EVERY Next server process
    // needs to serve ANY route — Supabase URL/anon + app URL. Runs once per
    // server process at register(); nodejs-runtime-guarded so an edge split can't
    // skip or break it. It deliberately does NOT require the server DB creds
    // (SUPABASE_URL/SUPABASE_SERVICE_KEY/DATABASE_POOL_URL): those are a server-DB
    // subsystem asserted at DB-use via getServerDbConfig in Stage 3, so a static/
    // marketing render or a UI-only preview that lacks them still boots.
    assertCoreAppConfig();

    reportStripePriceDrift();
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
      beforeSend(event) {
        return scrubSentryEvent(event, { scrubRequestData: true });
      },
    });
  }
}
