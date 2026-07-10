import { NextResponse } from 'next/server';
import {
  InvalidTokenError,
  ExpiredTokenError,
  RevokedTokenError,
  ConsumedTokenError,
  DeviceConflictError,
  EmptyEditedResponseError,
  ResponseNotPendingError,
  VetoTooLateError,
} from './errors';
import { NO_STORE_HEADERS as NO_STORE } from '@/lib/shared/constants';
import { SubscriptionReadOnlyError } from '@/lib/shared/writable-subscription';

// SQLSTATE 40P01 (deadlock_detected): Postgres aborted this tx as the losing
// side of a lock cycle — e.g. the veto tx (links → reviews) colliding with a
// concurrent mark-posted (reviews → links). Structural check (not instanceof)
// so this module needs no runtime `postgres` import.
function isDeadlockDetected(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: unknown }).code === '40P01';
}

/**
 * Maps typed approval errors to HTTP responses. Used by all POST
 * approval routes so error-to-status mapping is defined once.
 */
export function handleApprovalError(err: unknown, route: string): NextResponse {
  if (err instanceof ExpiredTokenError) return NextResponse.json({ error: err.message }, { status: 410, headers: NO_STORE });
  if (err instanceof ConsumedTokenError) return NextResponse.json({ error: err.message }, { status: 410, headers: NO_STORE });
  if (err instanceof RevokedTokenError) return NextResponse.json({ error: err.message }, { status: 410, headers: NO_STORE });
  if (err instanceof InvalidTokenError) return NextResponse.json({ error: err.message }, { status: 404, headers: NO_STORE });
  if (err instanceof DeviceConflictError) return NextResponse.json({ error: err.message }, { status: 403, headers: NO_STORE });
  if (err instanceof EmptyEditedResponseError) return NextResponse.json({ error: err.message }, { status: 400, headers: NO_STORE });
  if (err instanceof ResponseNotPendingError) return NextResponse.json({ error: err.message }, { status: 409, headers: NO_STORE });
  // The veto race resolved against the owner (publisher claimed first, or the
  // response left the scheduled state another way). `result` is the machine
  // key the approve page branches on; the tx has rolled back by the time this
  // maps, so 409 is truthful "nothing was cancelled".
  if (err instanceof VetoTooLateError) return NextResponse.json({ result: 'too_late', error: err.message }, { status: 409, headers: NO_STORE });
  if (err instanceof SubscriptionReadOnlyError) return NextResponse.json({ error: err.message }, { status: err.status, headers: NO_STORE });
  // A 40P01 loser rolled back cleanly: nothing was cancelled and an immediate
  // retry succeeds, so it maps to a RETRYABLE 409 — deliberately NOT
  // result:'too_late' (the race was not resolved against the owner) and not a
  // 500 (this is an expected concurrency outcome, not a server fault).
  if (isDeadlockDetected(err)) return NextResponse.json({ error: 'conflict_retry' }, { status: 409, headers: NO_STORE });
  console.error(`[api/approve/${route}] Unexpected error:`, err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
}
