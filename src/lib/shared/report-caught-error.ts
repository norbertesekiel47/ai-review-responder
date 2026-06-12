import { captureException } from '@sentry/node';
import { createWorkerLogger } from './logger';

/**
 * Reports an error that a handler caught and HANDLED (the request continues
 * with a fallback/error response). Next.js `onRequestError` forwards only
 * UNCAUGHT route errors to Sentry, so handle-and-continue catch blocks are
 * invisible without this call.
 *
 * Runtime-safe in both web and worker: `@sentry/nextjs` re-exports the same
 * `@sentry/node` module instance, so the capture routes to whichever client
 * is initialized (Next server via instrumentation.ts, worker via
 * worker/sentry.ts) and the `scrubSentryEvent` beforeSend scrubber applies.
 * Node-runtime only — do not import from edge middleware.
 *
 * Emits one structured log line. Only the error name/message are serialized
 * (never the full error object — it may carry request payloads/PII), and the
 * `context` object passes the blocked-key sanitizer.
 */
export function reportCaughtError(
  endpoint: string,
  err: unknown,
  context?: Record<string, unknown>,
): void {
  const error = err instanceof Error ? err : new Error(String(err));
  try {
    captureException(error, { tags: { endpoint } });
  } catch {
    // Reporting must never break the already-handled response path.
  }
  createWorkerLogger(`[${endpoint}]`).error('Caught handled error', context ?? {}, error);
}
