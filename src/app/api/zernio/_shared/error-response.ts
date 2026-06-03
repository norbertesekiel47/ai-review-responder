// src/app/api/zernio/_shared/error-response.ts
//
// Shared error mapping for the Zernio connect/disconnect routes. They all map a
// ZernioRouteError to its (code, status) and fall back to a logged 500
// internal_error, with a no-store header on both. Routes that bubble extra
// outcome-known errors (e.g. select-location's ZernioAuthError /
// ZernioValidationError) handle those first, then delegate here.

import { NextResponse } from 'next/server';
import { ZernioRouteError } from '@/lib/zernio/errors';

const ZERNIO_NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

export function zernioRouteErrorResponse(err: unknown, logPrefix: string): NextResponse {
  if (err instanceof ZernioRouteError) {
    return NextResponse.json(
      { error: err.code },
      { status: err.statusCode, headers: ZERNIO_NO_STORE },
    );
  }
  console.error(`${logPrefix} internal error:`, err);
  return NextResponse.json(
    { error: 'internal_error' },
    { status: 500, headers: ZERNIO_NO_STORE },
  );
}
