import { NextResponse } from 'next/server';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

export const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

export class ZernioPreflightError extends Error {
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

export function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function parseRequestedLocationId(body: { locationId?: unknown }): string | null {
  const requestedLocationId =
    typeof body.locationId === 'string' && body.locationId.trim().length > 0
      ? body.locationId.trim()
      : null;

  if (requestedLocationId && !isValidUuid(requestedLocationId)) {
    throw new ZernioPreflightError(400, 'invalid_body');
  }

  return requestedLocationId;
}

export function assertActiveSubscription(status: string): void {
  if (status !== SubscriptionStatus.ACTIVE) {
    throw new ZernioPreflightError(403, 'subscription_required');
  }
}
