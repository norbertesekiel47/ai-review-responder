// src/app/api/admin/channels/sms/delete/route.ts
//
// POST /api/admin/channels/sms/delete — admin soft-deletes the active SMS
// enrollment row. Preserves TCPA audit trail: verified_at, disabled_at,
// unsubscribed_at, unsubscribed_reason stay intact; only archived_at +
// archive_reason are set.
//
// Ordering invariants:
//   1. Flag → auth → body parse → explicit confirm gate → subscription.
//   2. Per-(business_id, 'sms') advisory lock — matches /verify, /confirm,
//      /cancel, /disable.
//   3. UPDATE gated on `archived_at IS NULL` so repeated calls are idempotent
//      (0 rows updated on a second call is fine — no error surfaced).
//
// NOT touched here: `sms_sender_opt_outs` and `sms_sender_opt_out_events` —
// sender-level opt-out state is retained across enrollment churn for TCPA
// compliance (7-year retention).

import { NextRequest, NextResponse } from 'next/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import {
  isSmsEnabled,
  flagOff,
  assertSmsEnvReady,
  loadBusinessSubscriptionStatus,
  isSubscriptionActive,
  subscriptionNotActive,
  withMobileEnrollmentLock,
  badRequest,
} from '../_shared';

interface DeleteBody {
  business_id?: string;
  confirm?: boolean;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
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

  const body = (await request.json()) as DeleteBody;
  const businessId = body.business_id;
  if (!businessId) return badRequest('business_id_required');
  // Strict `=== true` check — rejects truthy-but-not-true values like the
  // string 'true' or 1, which usually indicate a client serialization bug.
  if (body.confirm !== true) return badRequest('confirmation_required');

  const subStatus = await loadBusinessSubscriptionStatus(businessId);
  if (!isSubscriptionActive(subStatus)) return subscriptionNotActive();

  return withMobileEnrollmentLock(businessId, async (tx) => {
    await tx`
      UPDATE channel_enrollments
      SET archived_at = NOW(), archive_reason = 'admin_delete', updated_at = NOW()
      WHERE business_id = ${businessId} AND channel = 'sms' AND archived_at IS NULL
    `;
    return NextResponse.json({ ok: true });
  });
}
