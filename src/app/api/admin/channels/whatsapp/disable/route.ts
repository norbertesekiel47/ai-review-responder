// src/app/api/admin/channels/whatsapp/disable — admin disables a verified enrollment.
// Returns 404 if no verified row matches (user-facing signal that there's nothing to disable).
//
// Handler order: flag → env → auth → businessId.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '../_shared';

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isWhatsAppEnabled()) return flagOff();

  const envErr = assertWhatsAppEnvReady();
  if (envErr) return envErr;

  try {
    await requireRole(req, 'admin', 'sales_partner');
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }

  const body = (await req.json().catch(() => null)) as { businessId?: string } | null;
  const businessId = body?.businessId;
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  const updated = await sql<{ id: string }[]>`
    UPDATE channel_enrollments
    SET status = 'disabled', disabled_at = NOW(), updated_at = NOW()
    WHERE business_id = ${businessId}
      AND channel = 'whatsapp'
      AND status = 'verified'
      AND archived_at IS NULL
    RETURNING id
  `;

  // M6: no-store for consistency across admin whatsapp routes.
  const noStore = { 'Cache-Control': 'no-store, private' };

  if (updated.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }

  return NextResponse.json({ ok: true }, { headers: noStore });
}
