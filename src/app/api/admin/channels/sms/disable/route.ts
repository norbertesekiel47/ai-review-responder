// src/app/api/admin/channels/sms/disable/route.ts
//
// POST /api/admin/channels/sms/disable — admin transitions a verified SMS
// enrollment to 'disabled'. Preserves the handle + terminal timestamps so a
// future /verify call can re-enable via the UPDATE branch.
//
// Ordering invariants:
//   1. Flag → auth → body parse → subscription.
//   2. Per-(business_id, 'sms') advisory lock — matches /verify, /confirm,
//      /cancel.
//   3. UPDATE gated on `status = 'verified'` + `archived_at IS NULL`; empty
//      RETURNING means the row was not in verified state (409 not_verified).

import { NextRequest, NextResponse } from 'next/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import {
  isSmsEnabled,
  flagOff,
  assertSmsEnvReady,
  loadBusinessSubscriptionStatus,
  subscriptionNotActive,
  withSmsEnrollmentLock,
  badRequest,
  conflict,
} from '../_shared';

interface DisableBody {
  business_id?: string;
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

  const body = (await request.json()) as DisableBody;
  const businessId = body.business_id;
  if (!businessId) return badRequest('business_id_required');

  const subStatus = await loadBusinessSubscriptionStatus(businessId);
  if (subStatus !== 'active') return subscriptionNotActive();

  return withSmsEnrollmentLock(businessId, async (tx) => {
    const result = await tx<{ id: string }[]>`
      UPDATE channel_enrollments
      SET status = 'disabled', disabled_at = NOW(), updated_at = NOW()
      WHERE business_id = ${businessId} AND channel = 'sms'
        AND status = 'verified' AND archived_at IS NULL
      RETURNING id
    `;
    if (result.length !== 1) return conflict('not_verified');
    return NextResponse.json({ ok: true });
  });
}
