import * as Sentry from '@sentry/node';
import { scrubSentryEvent } from '../src/lib/shared/sentry-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV ?? 'development',
  beforeSend(event) {
    return scrubSentryEvent(event, { scrubRequestData: true });
  },
});

export { Sentry };
