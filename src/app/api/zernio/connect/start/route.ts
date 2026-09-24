import { NextRequest, NextResponse } from 'next/server';
import { zernioPublishingEnabled } from '@/lib/publishing/flags';
import { sql } from '@/lib/db/server';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { requireRole, AuthError } from '@/lib/db/auth';
import { zernioRouteErrorResponse } from '@/app/api/zernio/_shared/error-response';
import { startZernioConnect } from '@/lib/zernio/connect-start';
import { parseRequestedLocationId, preflightErrorResponse } from '../_shared/preflight';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

interface StartConnectBody {
  locationId?: unknown;
}

/**
 * POST /api/zernio/connect/start — gates (flag, same-origin, owner auth),
 * parses the body, and delegates the connect-flow state machine (account
 * gate, pending marker, request lock, orphan self-heal, Zernio profile +
 * OAuth start, CAS steps) to `startZernioConnect`
 * (`src/lib/zernio/connect-start.ts`, #1368). Its short Zernio calls stay in
 * this request under ADR 0001; thrown errors map via the shared Zernio
 * route-error response.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Feature flag — subsystem A is flag-gated by ZERNIO_PUBLISHING_ENABLED (§1.1).
  if (!zernioPublishingEnabled()) {
    return NextResponse.json({ error: 'feature_disabled' }, { status: 503, headers: NO_STORE });
  }

  // 1. CSRF (FIRST, before any DB or external work — round-7 correction).
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    }
    return errorToResponse(err);
  }

  // 2. Auth.
  let user;
  try {
    user = await requireRole(req, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.statusCode === 401 ? 'unauthorized' : 'forbidden' },
        { status: err.statusCode, headers: NO_STORE },
      );
    }
    return errorToResponse(err);
  }

  let body: StartConnectBody = {};
  try {
    const rawBody = await req.text();
    body = rawBody ? (JSON.parse(rawBody) as StartConnectBody) : {};
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  }

  let requestedLocationId: string | null;
  try {
    requestedLocationId = parseRequestedLocationId(body);
  } catch (err) {
    return preflightErrorResponse(err);
  }

  // AppUser.locationId is the primary location. Secondary-location connects
  // pass an explicit locationId and are validated against the account.
  if (!user.accountId || (!requestedLocationId && !user.locationId)) {
    return NextResponse.json({ error: 'unscoped_owner' }, { status: 403, headers: NO_STORE });
  }

  try {
    const result = await startZernioConnect(sql, {
      userId: user.id,
      accountId: user.accountId,
      locationId: requestedLocationId ?? user.locationId!,
      locationScope: requestedLocationId ? 'location' : 'all',
    });
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  } catch (err) {
    return errorToResponse(err);
  }
}

function errorToResponse(err: unknown): NextResponse {
  return zernioRouteErrorResponse(err, '[api/zernio/connect/start]');
}
