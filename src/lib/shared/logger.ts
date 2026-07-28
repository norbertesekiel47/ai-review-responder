import { sanitizeAnalyticsProperties } from '../analytics/events';
import { requiresProductionConfig } from '../config/deployment-lane';
import { getLogContext } from './log-context';

export interface WorkerLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

type LogLevel = 'info' | 'warn' | 'error';

const CONTEXT_FIELDS = [
  'request_id',
  'correlation_id',
  'account_id',
  'business_id',
  'review_id',
  'response_id',
  'worker_job_id',
  'outbox_id',
] as const;

function serviceName(): string {
  return process.env.LOG_SERVICE ?? 'worker';
}

/** '[ResponseGeneratorWorker]' -> 'ResponseGeneratorWorker'. */
function normalizeLoggerName(prefix: string): string {
  return prefix.replace(/^\[/, '').replace(/\]$/, '').trim();
}

function serializeError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    error_name: err.name,
    error_message: err.message,
  };
  // Stacks only on lanes that do not require production config: they can be
  // large and occasionally echo input. NODE_ENV alone leaked them on the
  // production Railway lane, which leaves it unset (#611).
  if (!requiresProductionConfig() && err.stack) {
    out.error_stack = err.stack;
  }
  return out;
}

function emit(level: LogLevel, prefix: string, correlationId: string | undefined, args: unknown[]): void {
  const context = getLogContext();
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    service: serviceName(),
    logger: normalizeLoggerName(prefix),
    message: '',
  };

  for (const field of CONTEXT_FIELDS) {
    const value = context[field];
    if (value !== undefined) record[field] = value;
  }
  if (correlationId && record.correlation_id === undefined) {
    record.correlation_id = correlationId;
  }

  const messageParts: string[] = [];
  let data: Record<string, unknown> | undefined;

  for (const arg of args) {
    if (typeof arg === 'string') {
      messageParts.push(arg);
    } else if (typeof arg === 'number' || typeof arg === 'boolean') {
      messageParts.push(String(arg));
    } else if (arg instanceof Error) {
      Object.assign(record, serializeError(arg));
    } else if (arg && typeof arg === 'object') {
      try {
        const sanitized = sanitizeAnalyticsProperties(arg as Record<string, unknown>);
        data = { ...(data ?? {}), ...sanitized };
      } catch {
        // Fail open: a cyclic/unserializable arg must never crash the logger.
        data = { ...(data ?? {}), unserializable: true };
      }
    }
  }

  record.message = messageParts.join(' ');
  if (data && Object.keys(data).length > 0) record.data = data;

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // Fail open: a record we can't serialize must not throw from a log call.
    line = JSON.stringify({ message: record.message, unserializable: true });
  }
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Creates a JSON structured logger for workers. The public API is unchanged:
 * `createWorkerLogger(prefix, correlationId)`. The prefix becomes `logger`,
 * `correlationId` is merged with any AsyncLocalStorage log context, and each
 * call emits one JSON object per line.
 *
 * Never pass raw review text, response text, approval/OAuth tokens, API keys,
 * passwords, MFA codes, or provider request payloads — object args are passed
 * through the analytics blocked-key sanitizer, but string args are logged verbatim.
 */
export function createWorkerLogger(prefix: string, correlationId?: string): WorkerLogger {
  return {
    log: (...args: unknown[]) => emit('info', prefix, correlationId, args),
    warn: (...args: unknown[]) => emit('warn', prefix, correlationId, args),
    error: (...args: unknown[]) => emit('error', prefix, correlationId, args),
  };
}

/** Normalizes a caught value to an Error so the logger serializes it. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Catch handler for fire-and-forget poller/scheduler ticks: routes the
 * rejection through the structured logger instead of losing it. Single owner
 * of the `.catch(...)` boilerplate every background loop needs.
 */
export function logUnhandledPollError(
  prefix: string,
  message = 'Unhandled poll error',
): (err: unknown) => void {
  return (err) => createWorkerLogger(prefix).error(message, toError(err));
}
