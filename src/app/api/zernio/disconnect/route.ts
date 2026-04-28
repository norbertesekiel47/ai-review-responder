import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { sql } from '@/lib/db/server';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { requireRole, AuthError } from '@/lib/db/auth';
import { ZernioRouteError } from '@/lib/zernio/errors';
import { zernioClient } from '@/lib/zernio/client';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

// UUIDv7 inherits the standard 8-4-4-4-12 hex layout — accept any UUID
// version since v7 is just a particular variant.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DisconnectBody {
  businessId?: unknown;
}

/**
 * POST /api/zernio/disconnect
 *
 * Spec §3.2 step 5. Owner-initiated soft disconnect of an established
 * connection (or admin-initiated). Marks the connection 'disconnected' and
 * best-effort deletes the Zernio account.
 *
 * Critical: sales_partner is intentionally EXCLUDED. Per the documented
 * latent issue in docs/security-audit/round-1-auth-authz.md, admin
 * business-detail routes don't scope by `businesses.onboarded_by = user.id`.
 * Adding a destructive per-business write reachable by sales_partner would
 * expand the blast radius of that bug. Owner remains scoped to their own
 * business; admin can disconnect any business.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Feature flag — subsystem A is gated by ZERNIO_PUBLISHING_ENABLED (§1.1).
  if (process.env.ZERNIO_PUBLISHING_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'feature_disabled' },
      { status: 503, headers: NO_STORE },
    );
  }

  // 1. CSRF (FIRST, before any DB or external work — spec §3.2 step 5).
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json(
        { error: 'forbidden' },
        { status: 403, headers: NO_STORE },
      );
    }
    return errorToResponse(err);
  }

  // 2. Auth — owner OR admin only. sales_partner is rejected by allowing
  // only those two roles into requireRole.
  let user;
  try {
    user = await requireRole(req, 'owner', 'admin');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.statusCode === 401 ? 'unauthorized' : 'forbidden' },
        { status: err.statusCode, headers: NO_STORE },
      );
    }
    return errorToResponse(err);
  }

  // 3. Resolve the target businessId — owner is always self-scoped; admin
  // must specify it in the body.
  let businessId: string;
  if (user.role === 'owner') {
    if (!user.businessId) {
      return NextResponse.json(
        { error: 'unscoped_owner' },
        { status: 403, headers: NO_STORE },
      );
    }
    businessId = user.businessId;
  } else {
    let body: DisconnectBody;
    try {
      body = (await req.json()) as DisconnectBody;
    } catch {
      return NextResponse.json(
        { error: 'invalid_body' },
        { status: 400, headers: NO_STORE },
      );
    }
    const candidate =
      typeof body.businessId === 'string' && body.businessId.length > 0
        ? body.businessId
        : null;
    if (!candidate) {
      return NextResponse.json(
        { error: 'missing_business_id' },
        { status: 400, headers: NO_STORE },
      );
    }
    if (!UUID_REGEX.test(candidate)) {
      return NextResponse.json(
        { error: 'invalid_business_id' },
        { status: 400, headers: NO_STORE },
      );
    }
    businessId = candidate;
  }

  // 4. Resolve the active Zernio account so the best-effort delete-account
  // call has its target. 404 is cleaner than 400/500 when no live row.
  let accountId: string;
  try {
    const rows = await sql<{ zernio_account_id: string }[]>`
      SELECT zernio_account_id
      FROM zernio_connections
      WHERE business_id = ${businessId} AND status = 'active'
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return NextResponse.json(
        { error: 'no_active_connection' },
        { status: 404, headers: NO_STORE },
      );
    }
    accountId = row.zernio_account_id;
  } catch (err) {
    return errorToResponse(err);
  }

  // 5. Mark the connection disconnected. The UPDATE pins to the SAME
  // zernio_account_id we just read — without that pin, a parallel
  // webhook+reconnect race could land us disconnecting a fresh-and-active
  // row that the owner just reconnected. We also count rows updated so a
  // 0-row outcome (account already disconnected by a parallel writer)
  // skips the deleteAccount call below.
  const reason = user.role === 'owner' ? 'manual_owner' : 'manual_admin';
  let rowsUpdated = 0;
  try {
    await sql.begin(async (tx) => {
      const result = await tx`
        UPDATE zernio_connections
        SET status = 'disconnected',
            disconnected_at = NOW(),
            disconnect_reason = ${reason},
            last_error = NULL,
            last_error_at = NULL,
            updated_at = NOW()
        WHERE business_id = ${businessId}
          AND zernio_account_id = ${accountId}
          AND status = 'active'
      `;
      rowsUpdated = result.count;
    });
  } catch (err) {
    return errorToResponse(err);
  }

  // If the row already flipped to disconnected via a parallel writer, abort
  // the Zernio cleanup — the row we read is no longer the live one and
  // touching the Zernio side would conflict with whatever the parallel
  // writer already coordinated.
  if (rowsUpdated === 0) {
    return NextResponse.json(
      { ok: true, note: 'connection_already_disconnected' },
      { status: 200, headers: NO_STORE },
    );
  }

  // 6. Best-effort Zernio cleanup. Failure does NOT fail the request — the
  // DB is the source of truth from RepWorth's perspective; Zernio cleanup
  // is housekeeping. Log to Sentry for ops visibility.
  try {
    await zernioClient.deleteAccount(accountId);
  } catch (zernioErr) {
    Sentry.captureException(zernioErr, {
      tags: { business_id: businessId, kind: 'zernio_delete_account' },
    });
    console.error(
      '[api/zernio/disconnect] best-effort deleteAccount failed:',
      zernioErr,
    );
  }

  return NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
}

function errorToResponse(err: unknown): NextResponse {
  if (err instanceof ZernioRouteError) {
    return NextResponse.json(
      { error: err.code },
      { status: err.statusCode, headers: NO_STORE },
    );
  }
  console.error('[api/zernio/disconnect] internal error:', err);
  return NextResponse.json(
    { error: 'internal_error' },
    { status: 500, headers: NO_STORE },
  );
}
