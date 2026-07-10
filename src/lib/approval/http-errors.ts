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
  console.error(`[api/approve/${route}] Unexpected error:`, err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
}
