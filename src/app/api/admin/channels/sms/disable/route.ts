// src/app/api/admin/channels/sms/disable/route.ts
//
// POST /api/admin/channels/sms/disable — admin transitions a verified SMS
// enrollment to 'disabled'. Preserves the handle + terminal timestamps so a
// future /verify call can re-enable via the UPDATE branch.
//
// Ordering invariants:
//   1. Same-origin wrapper → flag → env → auth → body parse → subscription.
//   2. Per-account mobile-enrollment advisory lock — matches /verify, /confirm,
//      /cancel (and the Telegram/WhatsApp admin routes).
//   3. UPDATE gated on `status = 'verified'` + `archived_at IS NULL`; empty
//      RETURNING means the row was not in verified state (409 not_verified).

import { NextRequest, NextResponse } from 'next/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import {
  isSmsEnabled,
  flagOff,
  assertSmsEnvReady,
  loadBusinessAccountContext,
  isSubscriptionActive,
  subscriptionNotActive,
  withMobileEnrollmentLock,
  badRequest,
  conflict,
} from '../_shared';
import { asLocationId, asAccountId } from '@/lib/shared/ids';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { withSameOrigin } from '@/lib/auth/route-helpers';

interface DisableBody {
  business_id?: string;
}

async function disableSms(request: NextRequest): Promise<NextResponse> {
  if (!isSmsEnabled()) return flagOff();
  const envError = assertSmsEnvReady();
  if (envError) return envError;

  try {
    await requireRole(request, 'admin');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    throw err;
  }

  const body = (await request.json()) as DisableBody;
  const rawBusinessId = body.business_id;
  if (!rawBusinessId) return badRequest('business_id_required');
  const businessId = asLocationId(rawBusinessId);

  const accountContext = await loadBusinessAccountContext(businessId);
  if (!accountContext || !isSubscriptionActive(accountContext.subscriptionStatus)) {
    return subscriptionNotActive();
  }
  const accountId = accountContext.accountId;

  const result = await withMobileEnrollmentLock(accountId, async (tx) => {
    const result = await tx<{ id: string }[]>`
      UPDATE channel_enrollments
      SET status = 'disabled', disabled_at = NOW(), updated_at = NOW()
      WHERE account_id = ${accountId} AND channel = 'sms' AND location_id IS NULL
        AND status = 'verified' AND archived_at IS NULL
      RETURNING id
    `;
    if (result.length !== 1) return conflict('not_verified');
    return NextResponse.json({ ok: true });
  });

  // Invalidate channel cache — the disabled channel must be removed from
  // the dispatch resolution immediately. Reuse the account id resolved
  // up-front instead of a second businesses lookup.
  await safeInvalidateChannelCache(asAccountId(accountId), 'admin.sms.disable');

  return result;
}

export const POST = withSameOrigin()(disableSms);
