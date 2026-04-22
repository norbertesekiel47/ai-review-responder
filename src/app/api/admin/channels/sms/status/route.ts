// src/app/api/admin/channels/sms/status/route.ts
//
// GET /api/admin/channels/sms/status — read-only poll endpoint for the admin
// SMS widget. Returns the business's single active `channel_enrollments` row
// (if any) plus a derived `sender_opt_in_cleared` boolean computed from
// `sms_sender_opt_outs`, scoped to the current Messaging Service SID.
//
// Gating: flag + auth only. NO subscription gate (safe to call anytime, even
// for pending_payment businesses — the widget polls broadly) and NO advisory
// lock (read-only, nothing to serialize).
//
// LEFT JOIN rationale: a brand-new enrollment has no opt-out row yet; the
// LEFT JOIN keeps the enrollment row visible and the CASE's first branch
// (`so.handle IS NULL THEN TRUE`) treats "never opted out" as cleared.
//
// MS SID scoping: an SMS handle can have different opt-out histories per
// Twilio Messaging Service. The JOIN predicate pins opt-out rows to the
// currently-configured service so future multi-service rollouts stay correct.

import { NextRequest, NextResponse } from 'next/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { sql } from '@/lib/db/server';
import { isSmsEnabled, flagOff, assertSmsEnvReady, badRequest } from '../_shared';

interface StatusRow {
  status: string;
  handle: string;
  verified_at: Date | null;
  disabled_at: Date | null;
  unsubscribed_at: Date | null;
  unsubscribed_reason: string | null;
  archived_at: Date | null;
  sender_opt_in_cleared: boolean;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
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

  const businessId = request.nextUrl.searchParams.get('business_id');
  if (!businessId) return badRequest('business_id_required');

  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID!;

  const rows = await sql<StatusRow[]>`
    SELECT ce.status, ce.handle,
           ce.verified_at, ce.disabled_at,
           ce.unsubscribed_at, ce.unsubscribed_reason,
           ce.archived_at,
           CASE
             WHEN so.handle IS NULL THEN TRUE
             WHEN so.opted_in_at IS NOT NULL AND so.opted_in_at > so.opted_out_at THEN TRUE
             ELSE FALSE
           END AS sender_opt_in_cleared
    FROM channel_enrollments ce
    LEFT JOIN sms_sender_opt_outs so
      ON so.handle = ce.handle
     AND so.messaging_service_sid = ${messagingServiceSid}
    WHERE ce.business_id = ${businessId}
      AND ce.channel = 'sms'
      AND ce.archived_at IS NULL
    LIMIT 1
  `;

  return NextResponse.json({ enrollment: rows[0] ?? null });
}
