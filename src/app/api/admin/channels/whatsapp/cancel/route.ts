// src/app/api/admin/channels/whatsapp/cancel — admin cancels a pending verification,
// clearing the token hash + expiry.
//
// Handler order: flag → env → auth → businessId.
// Idempotent: if no pending_verification row matches, the UPDATE silently affects
// 0 rows (no error — the task is already done).

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '../_shared';
import { cancelWhatsAppEnrollment } from '@/lib/channels/whatsapp-enrollment';
import { invalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';

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

  // Flip to 'disabled' so the migration 027 partial-unique-index slot is
  // released immediately, allowing a fresh mobile channel enrollment.
  // Advisory lock is held across the UPDATE so a concurrent start cannot
  // observe the pending row, fall through to its UPDATE branch (no status
  // guard), and overwrite this cancel's 'disabled' transition back to
  // 'pending_verification'. Uses the shared mobile_enroll key matching
  // SMS withMobileEnrollmentLock and Telegram start/cancel routes.
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${businessId}`}, 0))`;
    return cancelWhatsAppEnrollment(tx, businessId);
  });

  // Invalidate channel cache — the cancelled verification changes which
  // channels are available for dispatch.
  const [acctRow] = await sql<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${businessId}
  `;
  if (acctRow?.account_id) {
    await invalidateChannelCache(asAccountId(acctRow.account_id)).catch(() => {});
  }

  // M6: no-store for consistency with start/disable routes (admin-action results
  // must not be cached by proxies or the browser).
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, private' } });
}
