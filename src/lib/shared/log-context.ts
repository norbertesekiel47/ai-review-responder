import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Per-request / per-job log context propagated via AsyncLocalStorage.
 * Every field is optional and only included in a log line when bound.
 */
export interface LogContext {
  request_id?: string;
  correlation_id?: string;
  account_id?: string;
  business_id?: string;
  review_id?: string;
  response_id?: string;
  worker_job_id?: string;
  outbox_id?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

function stripEmpty(context: LogContext): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null && value !== '') {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/** Run `fn` with `context` merged onto any enclosing context. Child keys win. */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  const merged = { ...(storage.getStore() ?? {}), ...stripEmpty(context) };
  return storage.run(merged, fn);
}

/** Returns the active context, or `{}` when called outside any scope. */
export function getLogContext(): LogContext {
  return storage.getStore() ?? {};
}

/** Adds IDs to the CURRENT scope (no-op when called outside a scope). */
export function mergeLogContext(context: LogContext): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, stripEmpty(context));
}

export function createRequestId(): string {
  return randomUUID();
}
