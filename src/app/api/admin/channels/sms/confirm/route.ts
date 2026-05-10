// src/app/api/admin/channels/sms/confirm/route.ts
//
// POST /api/admin/channels/sms/confirm — admin completes the Twilio Verify
// OTP check for a pending SMS enrollment. On approved code, flips the row
// to `verified` and clears any residual unsubscribe fields.
//
// The subtle case this handles (Phase 1 spec §8.2): the owner may text STOP
// to the sender number between /verify and /confirm. That STOP is recorded
// in `sms_sender_opt_outs` by the inbound webhook — the authoritative source
// for carrier-enforced opt-out. We re-check that table here BEFORE calling
// Twilio and BEFORE flipping the row to `verified`, so a mid-flow STOP
// returns 409 sender_opted_out_during_verification rather than advancing to
// a verified state we'd immediately have to tear down on the next send.
//
// Ordering invariants:
//   1. Auth → flag → subscription → per-(business_id,'sms') advisory lock.
//   2. Load active row (any status) — authoritative row used for the Twilio
//      `to` handle. Body has no `phone` — the row's handle is canonical.
//   3. Re-check sms_sender_opt_outs BEFORE Twilio call.
//   4. Dispatch on status: only `pending_verification` proceeds; everything
//      else returns 409 row_not_pending.
//   5. Twilio verificationChecks.create only after gates pass.
//   6. On approved: UPDATE status → verified, clear unsubscribe fields.
//      RETURNING id checks row count; 0 rows → 409 race_conflict.
//   7. Do NOT touch sms_sender_opt_outs / sms_sender_opt_out_events —
//      audit trail of opt-out history is preserved across re-verifications.

import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';
import { sql } from '@/lib/db/server';
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
  conflict,
} from '../_shared';
import { asLocationId, asAccountId } from '@/lib/shared/ids';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';

interface ConfirmBody {
  business_id?: string;
  code?: string;
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
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = (await request.json()) as ConfirmBody;
  const rawBusinessId = body.business_id;
  const code = body.code;
  if (!rawBusinessId || !code) return badRequest('missing_fields');
  const businessId = asLocationId(rawBusinessId);

  const subStatus = await loadBusinessSubscriptionStatus(businessId);
  if (!isSubscriptionActive(subStatus)) return subscriptionNotActive();

  const result = await withMobileEnrollmentLock(businessId, async (tx) => {
    // Step 1: Load active row (any status — row status gates are applied in step 3).
    const activeRows = await tx<{ handle: string; status: string }[]>`
      SELECT handle, status FROM channel_enrollments
      WHERE business_id = ${businessId} AND channel = 'sms' AND archived_at IS NULL
    `;
    const row = activeRows[0];
    if (!row) return badRequest('no_pending_verification');

    // Step 2: Re-check sender-opt-out gate. The inbound STOP webhook writes
    // sms_sender_opt_outs atomically; checking it here (not just the row's
    // status) catches the mid-flow STOP race where the owner texts STOP
    // between /verify and /confirm but the row is still pending_verification.
    // Equal timestamps treated as still opted out, matching /verify.
    const optRows = await tx<{ opted_out_at: Date; opted_in_at: Date | null }[]>`
      SELECT opted_out_at, opted_in_at FROM sms_sender_opt_outs
      WHERE messaging_service_sid = ${process.env.TWILIO_MESSAGING_SERVICE_SID!}
        AND handle = ${row.handle}
    `;
    const opt = optRows[0];
    if (
      opt &&
      opt.opted_out_at &&
      (!opt.opted_in_at || opt.opted_in_at <= opt.opted_out_at)
    ) {
      return conflict('sender_opted_out_during_verification');
    }

    // Step 3: Dispatch on status. Only pending_verification proceeds.
    // verified / disabled / unsubscribed → 409 row_not_pending.
    if (row.status !== 'pending_verification') return conflict('row_not_pending');

    // Step 4: Twilio Verify check.
    const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
    const check = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID!)
      .verificationChecks.create({ to: row.handle, code });

    // Step 6: Non-approved — wrong code, expired, or already consumed.
    if (check.status !== 'approved') return badRequest('invalid_code_or_expired');

    // Step 5: Flip the row to verified and clear any residual unsubscribe
    // metadata from an earlier unsubscribed → pending_verification transition.
    // The WHERE guard on status = 'pending_verification' ensures a concurrent
    // cancel/disable between step 3 and this UPDATE surfaces as race_conflict.
    const updated = await tx<{ id: string }[]>`
      UPDATE channel_enrollments
      SET status = 'verified',
          verified_at = NOW(),
          unsubscribed_at = NULL,
          unsubscribed_reason = NULL,
          updated_at = NOW()
      WHERE business_id = ${businessId} AND channel = 'sms'
        AND status = 'pending_verification' AND archived_at IS NULL
      RETURNING id
    `;
    if (updated.length !== 1) return conflict('race_conflict');

    return NextResponse.json({ ok: true });
  });

  // Invalidate channel cache — the newly verified channel must be
  // immediately available for notification dispatch.
  const [acctRow] = await sql<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${businessId}
  `;
  if (acctRow?.account_id) {
    await safeInvalidateChannelCache(asAccountId(acctRow.account_id), 'admin.sms.confirm');
  }

  return result;
}
