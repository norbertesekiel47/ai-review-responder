// src/app/api/admin/channels/sms/verify/route.ts
//
// POST /api/admin/channels/sms/verify — admin starts a Twilio Verify
// code-send for a business's SMS enrollment. This is the most complex of
// the six admin SMS routes because it owns state-machine dispatch across
// brand-new / pending_verification / disabled / unsubscribed / verified
// rows, enforces the sender-level opt-out gate, and does Twilio-FIRST
// ordering so a Twilio failure never leaves a half-mutated DB row.
//
// State machine (from Phase 1 spec §8.2):
//   no row             → INSERT pending_verification (phone required)
//   pending_verification → re-send code, no DB change
//   disabled           → UPDATE status → pending_verification
//   unsubscribed       → UPDATE status → pending_verification
//                        (sender-opt-out gate below handles START requirement)
//   verified           → 400 already_verified (admin must Disable/Delete first)
//
// Ordering invariants:
//   1. Auth → flag → subscription → per-(business_id,'sms') advisory lock.
//   2. Resolve dbAction inside the lock so concurrent admins can't race.
//   3. Sender-opt-out check scoped to current Messaging Service SID.
//   4. Twilio Verify call happens BEFORE the INSERT/UPDATE, so a Twilio
//      failure leaves the DB untouched.
//   5. DB mutation only on success; UPDATE RETURNING id verifies row count.

import { NextRequest, NextResponse } from 'next/server';
import { parsePhoneNumber } from 'libphonenumber-js';
import twilio from 'twilio';
import { v7 as uuidv7 } from 'uuid';
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
  twilioVerifyError,
} from '../_shared';
import { classifyEnrollmentError, MultipleMobileChannelsError, EnrollmentDatabaseError } from '@/lib/channels/unique-violation';

interface VerifyBody {
  business_id?: string;
  phone?: string;
}

// Masks the middle three digits of a 10-digit US number for the response
// payload. Falls back to a generic mask if the number isn't the expected
// +1-XXX-XXX-XXXX shape (e.g. legacy row with a non-US handle).
function maskUsPhone(e164: string): string {
  const rest = e164.replace(/^\+1/, '');
  if (rest.length !== 10) return '+1 XXX-XXX-XXXX';
  return `+1 ${rest.slice(0, 3)}-XXX-${rest.slice(6)}`;
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

  const body = (await request.json()) as VerifyBody;
  const businessId = body.business_id;
  const submittedPhone = body.phone;
  if (!businessId) return badRequest('business_id_required');

  const subStatus = await loadBusinessSubscriptionStatus(businessId);
  if (!isSubscriptionActive(subStatus)) return subscriptionNotActive();

  return withMobileEnrollmentLock(businessId, async (tx) => {
    // Load the active (non-archived) SMS enrollment row, if any. At most one
    // exists because of the partial unique index (channel_enrollments
    // (business_id, channel) WHERE archived_at IS NULL) shipped in 021.
    const activeRows = await tx<{ handle: string; status: string }[]>`
      SELECT handle, status FROM channel_enrollments
      WHERE business_id = ${businessId} AND channel = 'sms' AND archived_at IS NULL
    `;
    const row = activeRows[0];

    // Resolve the Twilio destination phone and the DB action we'll take.
    // `handle_change_forbidden` enforces that admins can't retarget an
    // existing enrollment by passing a different phone — they must Delete
    // the row and start over, so audit history stays clean.
    let twilioPhone: string;
    let dbAction: 'insert' | 'update' | 'noop';

    if (!row) {
      if (!submittedPhone) return badRequest('phone_required');
      let parsed;
      try {
        parsed = parsePhoneNumber(submittedPhone, 'US');
      } catch {
        return badRequest('phone_invalid');
      }
      if (!parsed || !parsed.isValid() || parsed.countryCallingCode !== '1') {
        return badRequest('phone_invalid');
      }
      twilioPhone = parsed.number;
      dbAction = 'insert';
    } else {
      if (submittedPhone && submittedPhone !== row.handle) {
        return badRequest('handle_change_forbidden');
      }
      twilioPhone = row.handle;
      if (row.status === 'verified') return badRequest('already_verified');
      dbAction = row.status === 'pending_verification' ? 'noop' : 'update';
    }

    // Sender-level opt-out gate. Scoped to the current Messaging Service
    // SID so a handle opted out on a previous MS doesn't block re-enrollment
    // on a new one. A later opted_in_at (matching START keyword) clears the
    // opt-out; we treat equal timestamps as still opted out.
    const optRows = await tx<{ opted_out_at: Date; opted_in_at: Date | null }[]>`
      SELECT opted_out_at, opted_in_at FROM sms_sender_opt_outs
      WHERE messaging_service_sid = ${process.env.TWILIO_MESSAGING_SERVICE_SID!}
        AND handle = ${twilioPhone}
    `;
    const opt = optRows[0];
    if (
      opt &&
      opt.opted_out_at &&
      (!opt.opted_in_at || opt.opted_in_at <= opt.opted_out_at)
    ) {
      return badRequest('sender_opt_in_required');
    }

    // Pre-check migration 027's predicate before calling Twilio. Saves
    // the cost of a Verify SMS when another mobile channel is already
    // pending or verified. The DB index is still authoritative — a
    // concurrent Telegram/WhatsApp start would race past this check and
    // be caught by the catch block below.
    const otherMobileRows = await tx<{ channel: string }[]>`
      SELECT channel FROM channel_enrollments
      WHERE business_id = ${businessId}
        AND channel IN ('telegram', 'whatsapp')
        AND status IN ('pending_verification', 'verified')
        AND archived_at IS NULL
      LIMIT 1
    `;
    if (otherMobileRows.length > 0) {
      return conflict('multiple_mobile_channels');
    }

    // Twilio-first ordering: if Verify fails, we return 500 without
    // touching the DB. The admin can retry and the state machine picks
    // up from the same row_state / dbAction.
    const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
    try {
      await client.verify.v2
        .services(process.env.TWILIO_VERIFY_SERVICE_SID!)
        .verifications.create({ to: twilioPhone, channel: 'sms' });
    } catch (err) {
      console.error(
        `[sms/verify] Twilio Verify failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return twilioVerifyError('verify_send_failed');
    }

    // Post-Twilio race check: STOP may have fired between step 5's opt-out gate
    // and Twilio's API roundtrip. Re-read sms_sender_opt_outs inside the same
    // transaction; if now opted-out, refuse to flip the row to pending_verification
    // (the STOP handler already moved it to unsubscribed; we'd be overwriting).
    const postOptRows = await tx<{ opted_out_at: Date; opted_in_at: Date | null }[]>`
      SELECT opted_out_at, opted_in_at FROM sms_sender_opt_outs
      WHERE messaging_service_sid = ${process.env.TWILIO_MESSAGING_SERVICE_SID!}
        AND handle = ${twilioPhone}
    `;
    const postOpt = postOptRows[0];
    if (
      postOpt &&
      postOpt.opted_out_at &&
      (!postOpt.opted_in_at || postOpt.opted_in_at <= postOpt.opted_out_at)
    ) {
      return conflict('sender_opted_out_during_verification');
    }

    try {
      if (dbAction === 'insert') {
        // Resolve account_id from businesses within the same tx so the
        // INSERT satisfies the NOT NULL constraint added by migration 034.
        const [bizRow] = await tx<{ account_id: string }[]>`
          SELECT account_id FROM businesses WHERE id = ${businessId}
        `;
        if (!bizRow?.account_id) {
          return NextResponse.json({ error: 'account_not_found' }, { status: 404 });
        }
        await tx`
          INSERT INTO channel_enrollments (id, account_id, business_id, channel, handle, status)
          VALUES (${uuidv7()}, ${bizRow.account_id}, ${businessId}, 'sms', ${twilioPhone}, 'pending_verification')
        `;
      } else if (dbAction === 'update') {
        // dbAction='update' is only set in the else branch above where `row`
        // is defined, so row.status is safe. The `AND status = ${row.status}`
        // guard narrows the UPDATE to the same state we observed, so a
        // concurrent STOP webhook that flipped the row to 'unsubscribed'
        // won't be silently overwritten here (updated.length === 0 → 409).
        const updated = await tx<{ id: string }[]>`
          UPDATE channel_enrollments
          SET status = 'pending_verification', updated_at = NOW()
          WHERE business_id = ${businessId} AND channel = 'sms' AND archived_at IS NULL
            AND status = ${row!.status}
          RETURNING id
        `;
        if (updated.length !== 1) return conflict('race_conflict');
      }
      // dbAction === 'noop': re-send code to an already-pending row; no DB write.
    } catch (err) {
      // Classify before letting the error escape the lock callback.
      try {
        classifyEnrollmentError(err);
      } catch (classified) {
        if (classified instanceof MultipleMobileChannelsError) {
          return conflict('multiple_mobile_channels');
        }
        if (classified instanceof EnrollmentDatabaseError) {
          console.error('[sms/verify] enrollment db error', classified);
          return NextResponse.json({ error: 'internal' }, { status: 500 });
        }
        throw classified;
      }
    }

    return NextResponse.json({ ok: true, phoneMasked: maskUsPhone(twilioPhone) });
  });
}
