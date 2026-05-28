// src/app/api/admin/channels/sms/cancel/route.ts
//
// POST /api/admin/channels/sms/cancel — admin aborts a pending SMS verification.
//
// Design (Phase 1 spec §8.2): because /verify never mutates an existing row's
// handle, cancel can safely restore the row to whichever terminal state it was
// in before. We use a single atomic CTE that:
//   1. UPDATEs rows in `pending_verification` in-place, restoring status
//      from the first non-null terminal timestamp (unsubscribed_at →
//      'unsubscribed', else disabled_at → 'disabled', else verified_at →
//      'verified'). Brand-new rows (no terminal timestamps) fall through to
//      'pending_verification' — effectively a no-op for the status column.
//   2. DELETEs any rows that remained 'pending_verification' after the UPDATE.
//      These are brand-new rows — no prior terminal to revert to, so we drop
//      the row entirely (matches /verify's brand-new INSERT being rolled back).
//
// The sender-level opt-out tables (sms_sender_opt_outs,
// sms_sender_opt_out_events) are explicitly NOT touched — carrier-enforced
// opt-out history must persist across enrollment churn.
//
// Ordering invariants:
//   1. Same-origin wrapper → flag → env → auth → body parse → subscription.
//   2. Per-account mobile-enrollment advisory lock — matches /verify and /confirm
//      (and the Telegram/WhatsApp admin routes).
//   3. Single CTE inside the lock.

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
} from '../_shared';
import { asLocationId, asAccountId } from '@/lib/shared/ids';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { withSameOrigin } from '@/lib/auth/route-helpers';

interface CancelBody {
  business_id?: string;
}

async function cancelSms(request: NextRequest): Promise<NextResponse> {
  if (!isSmsEnabled()) return flagOff();
  const envError = assertSmsEnvReady();
  if (envError) return envError;

  try {
    await requireRole(request, 'admin');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as CancelBody;
  const rawBusinessId = body.business_id;
  if (!rawBusinessId) return badRequest('business_id_required');
  const businessId = asLocationId(rawBusinessId);

  const accountContext = await loadBusinessAccountContext(businessId);
  if (!accountContext || !isSubscriptionActive(accountContext.subscriptionStatus)) {
    return subscriptionNotActive();
  }
  const accountId = accountContext.accountId;

  const result = await withMobileEnrollmentLock(accountId, async (tx) => {
    // State-revert CTE: UPDATE in-place based on prior terminal timestamps,
    // then DELETE any rows that remained 'pending_verification' (brand-new).
    await tx`
      WITH reverted AS (
        UPDATE channel_enrollments
        SET status = CASE
              WHEN unsubscribed_at IS NOT NULL THEN 'unsubscribed'
              WHEN disabled_at     IS NOT NULL THEN 'disabled'
              WHEN verified_at     IS NOT NULL THEN 'verified'
              ELSE 'pending_verification'
            END,
            updated_at = NOW()
        WHERE account_id = ${accountId} AND channel = 'sms' AND location_id IS NULL
          AND status = 'pending_verification' AND archived_at IS NULL
        RETURNING id, status
      )
      DELETE FROM channel_enrollments
      WHERE id IN (SELECT id FROM reverted WHERE status = 'pending_verification')
    `;
    return NextResponse.json({ ok: true });
  });

  // Invalidate channel cache — the cancelled verification changes which
  // channels are available for dispatch. Reuse the account id resolved
  // up-front instead of a second businesses lookup.
  await safeInvalidateChannelCache(asAccountId(accountId), 'admin.sms.cancel');

  return result;
}

export const POST = withSameOrigin()(cancelSms);
