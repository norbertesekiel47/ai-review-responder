// src/app/api/admin/channels/telegram/cancel — admin cancels a pending verification,
// clearing the token hash + expiry.
//
// Handler order: flag → env → auth → businessId.
// Idempotent: if no pending_verification row matches, the UPDATE silently affects
// 0 rows (no error — the task is already done).

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
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

  await sql`
    UPDATE channel_enrollments
    SET verification_token_hash = NULL,
        verification_token_expires_at = NULL,
        updated_at = NOW()
    WHERE business_id = ${businessId}
      AND channel = 'telegram'
      AND status = 'pending_verification'
      AND archived_at IS NULL
  `;

  return NextResponse.json({ ok: true });
}
