import { NextResponse } from 'next/server';
import {
  InvalidTokenError,
  ExpiredTokenError,
  RevokedTokenError,
  ConsumedTokenError,
  DeviceConflictError,
  EmptyEditedResponseError,
  ResponseNotPendingError,
} from './errors';
import { NO_STORE_HEADERS as NO_STORE } from '@/lib/shared/constants';

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
  console.error(`[api/approve/${route}] Unexpected error:`, err);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE });
}
