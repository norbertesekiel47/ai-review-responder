import { sanitizeAnalyticsProperties } from '../analytics/events';
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
  // Stacks only in non-production: they can be large and occasionally echo input.
  if (process.env.NODE_ENV !== 'production' && err.stack) {
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
      const sanitized = sanitizeAnalyticsProperties(arg as Record<string, unknown>);
      data = { ...(data ?? {}), ...sanitized };
    }
  }

  record.message = messageParts.join(' ');
  if (data && Object.keys(data).length > 0) record.data = data;

  const line = JSON.stringify(record);
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
