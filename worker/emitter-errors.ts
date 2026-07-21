// Non-fatal 'error' sink for BullMQ Workers/Queues and raw ioredis clients.
// An EventEmitter 'error' with no listener becomes uncaughtException, which
// is ALWAYS fatal (worker/index.ts crash-net) — so a transient Railway Redis
// blip would restart the whole worker. Route these through structured logging
// + a Sentry warning instead; BullMQ reconnects on its own.
import * as Sentry from '@sentry/node';
import { createWorkerLogger } from '../src/lib/shared/logger';

const logger = createWorkerLogger('emitter-error');

interface ErrorEmitting {
  on(event: 'error', listener: (err: Error) => void): unknown;
}

// ioredis reconnect loops emit one error per failed attempt, across ~46
// emitters — unthrottled reporting is a self-inflicted log flood AND Sentry
// alert storm during any Redis outage. Per source: report the first error in
// each window (structured log + Sentry warning), count-and-suppress the rest,
// and surface the suppressed count when the next window opens.
const ERROR_REPORT_WINDOW_MS = 60_000;
interface SourceErrorWindow { windowStartedAt: number; suppressed: number }
const windowBySource = new Map<string, SourceErrorWindow>();

export function attachEmitterErrorLogger(emitter: ErrorEmitting, source: string): void {
  emitter.on('error', (err: Error) => {
    // An error listener must never throw — that WOULD be an uncaughtException.
    try {
      const now = Date.now();
      const win = windowBySource.get(source);
      if (win && now - win.windowStartedAt < ERROR_REPORT_WINDOW_MS) {
        win.suppressed += 1; // storm in progress: count, don't flood
        return;
      }
      const suppressedInPriorWindow = win?.suppressed ?? 0;
      windowBySource.set(source, { windowStartedAt: now, suppressed: 0 });
      logger.warn(
        `${source} emitted error: ${err.message}` +
          (suppressedInPriorWindow ? ` (${suppressedInPriorWindow} similar suppressed in prior window)` : ''),
      );
      Sentry.captureMessage('worker_emitter_error', {
        level: 'warning',
        tags: { subsystem: 'worker_emitter', source },
        extra: { message: err.message, stack: err.stack, suppressed_in_prior_window: suppressedInPriorWindow },
      });
    } catch {
      // Swallow: last-resort sink.
    }
  });
}
