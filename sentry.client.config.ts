import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  beforeSend(event) {
    return scrubSensitiveData(event);
  },
});

function scrubSensitiveData(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const sensitiveKeys = /key|secret|token|password|authorization/i;
  if (event.extra) {
    for (const key of Object.keys(event.extra)) {
      if (sensitiveKeys.test(key)) {
        event.extra[key] = '[REDACTED]';
      }
    }
  }
  if (event.request?.headers) {
    for (const key of Object.keys(event.request.headers)) {
      if (sensitiveKeys.test(key)) {
        event.request.headers[key] = '[REDACTED]';
      }
    }
  }
  return event;
}
