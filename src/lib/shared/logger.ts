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

/**
 * The record's opening shape: the five base fields, then any bound context
 * IDs in CONTEXT_FIELDS order, then the factory's correlation id — but only
 * when the bound context did not already supply one.
 *
 * `message` is seeded empty here and re-assigned by `emit` once the args are
 * joined. That is deliberate: re-assigning an existing key does not move it,
 * so seeding it fixes its position ahead of the context block.
 */
function buildBaseRecord(
  level: LogLevel,
  prefix: string,
  correlationId: string | undefined,
): Record<string, unknown> {
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
  return record;
}

/**
 * A string, number or boolean arg's contribution to the message, or undefined
 * when the arg is neither. The test is `typeof`, never truthiness — `false`
 * and `0` are real message parts.
 */
function messagePart(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
  return undefined;
}

/** Accumulates one object arg onto whatever earlier object args contributed. */
function mergeObjectArg(
  data: Record<string, unknown> | undefined,
  arg: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return { ...(data ?? {}), ...sanitizeAnalyticsProperties(arg) };
  } catch {
    // Fail open: a cyclic/unserializable arg must never crash the logger.
    return { ...(data ?? {}), unserializable: true };
  }
}

/**
 * Splits the variadic args into the three things `emit` assembles. Error
 * fields come back SEPARATELY rather than written straight onto the record, so
 * `emit` alone decides where they land in key order. `data` is undefined when
 * it would be empty, which is what keeps the key absent.
 */
function collectLogArgs(args: unknown[]): {
  message: string;
  errorFields: Record<string, unknown>;
  data: Record<string, unknown> | undefined;
} {
  const messageParts: string[] = [];
  const errorFields: Record<string, unknown> = {};
  let data: Record<string, unknown> | undefined;

  for (const arg of args) {
    const part = messagePart(arg);
    if (part !== undefined) {
      messageParts.push(part);
      continue;
    }
    // Errors are tested BEFORE plain objects: an Error is also an object, and
    // it must serialize through serializeError, not the analytics sanitizer.
    if (arg instanceof Error) {
      Object.assign(errorFields, serializeError(arg));
      continue;
    }
    // `arg &&` is what keeps null out — typeof null === 'object'.
    if (arg && typeof arg === 'object') {
      data = mergeObjectArg(data, arg as Record<string, unknown>);
    }
  }

  return {
    message: messageParts.join(' '),
    errorFields,
    data: data && Object.keys(data).length > 0 ? data : undefined,
  };
}

function stringifyRecord(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    // Fail open: a record we can't serialize must not throw from a log call.
    return JSON.stringify({ message: record.message, unserializable: true });
  }
}

function writeLine(level: LogLevel, line: string): void {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function emit(level: LogLevel, prefix: string, correlationId: string | undefined, args: unknown[]): void {
  const record = buildBaseRecord(level, prefix, correlationId);
  const { message, errorFields, data } = collectLogArgs(args);

  // These three statements ARE the key-order contract: error fields append
  // after the context block, `message` is re-assigned in place and keeps the
  // position it was seeded at, and `data` lands last. Reordering them changes
  // the emitted JSON. Pinned by the key-order test in logger.test.ts.
  Object.assign(record, errorFields);
  record.message = message;
  if (data) record.data = data;

  writeLine(level, stringifyRecord(record));
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
