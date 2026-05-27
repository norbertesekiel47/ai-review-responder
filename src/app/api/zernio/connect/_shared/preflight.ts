import { NextResponse } from 'next/server';

// Internal helpers for the Zernio connect routes. The module's public surface is
// intentionally just parseRequestedLocationId + preflightErrorResponse (imported
// by start/route.ts); everything else is module-local.
const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

class ZernioPreflightError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

export function preflightErrorResponse(error: unknown): NextResponse {
  if (error instanceof ZernioPreflightError) {
    return NextResponse.json(
      { error: error.code },
      { status: error.status, headers: NO_STORE },
    );
  }
  throw error;
}

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function parseRequestedLocationId(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ZernioPreflightError(400, 'invalid_body');
  }

  const locationId = (body as { locationId?: unknown }).locationId;
  if (locationId === undefined) {
    return null;
  }

  if (typeof locationId !== 'string') {
    throw new ZernioPreflightError(400, 'invalid_body');
  }

  const requestedLocationId = locationId.trim();
  if (requestedLocationId.length === 0 || !isValidUuid(requestedLocationId)) {
    throw new ZernioPreflightError(400, 'invalid_body');
  }

  return requestedLocationId;
}
