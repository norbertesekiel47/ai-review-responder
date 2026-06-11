import * as Sentry from '@sentry/nextjs';
import { scrubSentryEvent } from '@/lib/shared/sentry-scrub';
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';

export const onRequestError = Sentry.captureRequestError;

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

    // Soft assertion (no throw — preview deploys legitimately run without
    // billing env): the worker boot-asserts these on Railway, but nothing else
    // checks the Next.js runtime, and tier-change fails closed (500
    // missing_price_config) when an overage price var is missing here. Surface
    // the config drift loudly instead of letting it masquerade as a code bug.
    if (process.env.STRIPE_SECRET_KEY) {
      const missing = STRIPE_PRICE_ENV_VARS.filter(
        (name) => !process.env[name] || process.env[name]!.trim().length === 0,
      );
      if (missing.length > 0) {
        const message = `[instrumentation] STRIPE_SECRET_KEY is set but Stripe price env vars are missing: ${missing.join(', ')} — tier changes needing them will fail closed with missing_price_config (env drift, not a code bug).`;
        console.error(message);
        Sentry.captureMessage(message, 'error');
      }
    }
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
