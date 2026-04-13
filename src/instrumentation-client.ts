import * as Sentry from '@sentry/nextjs';

// Required by @sentry/nextjs to instrument client-side navigations
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  beforeSend(event) {
    return scrubSensitiveData(event);
  },
});

/** Recursively scrub sensitive keys from any object */
function scrubObject(obj: Record<string, unknown>): void {
  const sensitiveKeys = /key|secret|token|password|authorization/i;
  for (const key of Object.keys(obj)) {
    if (sensitiveKeys.test(key)) {
      obj[key] = '[REDACTED]';
    } else if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      scrubObject(obj[key] as Record<string, unknown>);
    }
  }
}

function scrubSensitiveData(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.extra) {
    scrubObject(event.extra as Record<string, unknown>);
  }
  if (event.request?.headers) {
    scrubObject(event.request.headers as Record<string, unknown>);
  }
  return event;
}
