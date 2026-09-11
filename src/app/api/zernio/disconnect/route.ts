import { NextRequest, NextResponse } from 'next/server';
import {
  activeOffboardingStateFromProjection,
  isConnectBlocked,
  type ActiveOffboardingProjection,
} from '@/lib/account-offboarding/gate';
import { sql } from '@/lib/db/server';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { requireRole, AuthError } from '@/lib/db/auth';
import { zernioRouteErrorResponse } from '../_shared/error-response';
import { assertWritableSubscriptionStatus } from '@/lib/shared/writable-subscription';
import { disconnectZernioConnection } from '@/lib/zernio/disconnect';
import { zernioPublishingEnabled } from '@/lib/publishing/flags';
import type { AccountFlagsInput } from '@/lib/shared/past-due-recovery';

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
 * Auth is owner OR admin only (requireRole below). `admin` is an intentional
 * global super-role (docs/security-audit/2026-06-15-refresh-delta.md §4), so an
 * admin can disconnect any business by design; the prior sales_partner
 * cross-partner IDOR (R1 H-1) was closed at the root by migration 053. Keep
 * this route's write surface minimal regardless. Owner remains scoped to their
 * own business.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Feature flag — subsystem A is gated by ZERNIO_PUBLISHING_ENABLED (§1.1).
  if (!zernioPublishingEnabled()) {
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

  // 2. Auth — owner OR admin only.
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
    if (!user.locationId) {
      return NextResponse.json(
        { error: 'unscoped_owner' },
        { status: 403, headers: NO_STORE },
      );
    }
    businessId = user.locationId;
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

  if (user.role === 'owner') {
    try {
      const [accountRow] = await sql<Array<{
        account_id: string;
        subscription_status: string;
        past_due_at: Date | string | null;
        flags: AccountFlagsInput;
      } & ActiveOffboardingProjection>>`
        SELECT a.id AS account_id, a.subscription_status, a.past_due_at, a.flags,
             ao.id AS offboarding_id,
             ao.account_id AS offboarding_account_id,
             ao.mode AS offboarding_mode,
             ao.status AS offboarding_status,
             ao.failed_step AS offboarding_failed_step,
             ao.access_ends_at AS offboarding_access_ends_at,
             ao.teardown_started_at AS offboarding_teardown_started_at,
             ao.purge_after AS offboarding_purge_after,
             ao.purge_started_at AS offboarding_purge_started_at,
             ao.purge_cancelled_at AS offboarding_purge_cancelled_at
        FROM businesses b
        JOIN accounts a ON a.id = b.account_id
        LEFT JOIN account_offboardings ao
          ON ao.account_id = a.id
         AND ao.account_id = ${user.accountId}
         AND ao.terminal_at IS NULL
        WHERE b.id = ${businessId}
          AND b.account_id = ${user.accountId}
          AND b.archived_at IS NULL
        ORDER BY ao.created_at DESC NULLS LAST
        LIMIT 1
      `;
      if (!accountRow) {
        return NextResponse.json(
          { error: 'invalid_location_scope' },
          { status: 403, headers: NO_STORE },
        );
      }
      const writable = assertWritableSubscriptionStatus({
        subscriptionStatus: accountRow.subscription_status,
        pastDueAt: accountRow.past_due_at,
        accountFlags: accountRow.flags,
      });
      if (!writable.ok) {
        return NextResponse.json(
          { error: writable.error },
          { status: writable.status, headers: NO_STORE },
        );
      }
      const offboardingState = activeOffboardingStateFromProjection(accountRow);
      if (isConnectBlocked(offboardingState)) {
        return NextResponse.json(
          { error: 'account_offboarding_blocked' },
          { status: 403, headers: NO_STORE },
        );
      }
    } catch (err) {
      return errorToResponse(err);
    }
  }

  try {
    const result = await disconnectZernioConnection(
      sql,
      businessId,
      user.role === 'owner' ? 'owner' : 'admin',
    );
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
  } catch (err) {
    return errorToResponse(err);
  }
}

function errorToResponse(err: unknown): NextResponse {
  return zernioRouteErrorResponse(err, '[api/zernio/disconnect]');
}
