import * as Sentry from '@sentry/nextjs';
import { scrubSentryEvent } from '@/lib/shared/sentry-scrub';

export const onRequestError = Sentry.captureRequestError;

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
      beforeSend(event) {
        return scrubSentryEvent(event, { scrubRequestData: true });
      },
    });
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
