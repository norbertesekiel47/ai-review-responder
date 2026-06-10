// src/app/api/admin/channels/whatsapp/cancel — admin cancels a pending verification,
// clearing the token hash + expiry.
//
// Handler order: same-origin wrapper → flag → env → auth → businessId.
// Idempotent: if no pending_verification row matches, the UPDATE silently affects
// 0 rows (no error — the task is already done).

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '../_shared';
import { resolveAdminChannelAccount } from '@/app/api/admin/channels/_shared/account';
import { cancelWhatsAppEnrollment } from '@/lib/channels/whatsapp-enrollment';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import { withSameOrigin } from '@/lib/auth/route-helpers';

async function cancelWhatsApp(req: NextRequest): Promise<NextResponse> {
  if (!isWhatsAppEnabled()) return flagOff();

  const envErr = assertWhatsAppEnvReady();
  if (envErr) return envErr;

  const resolved = await resolveAdminChannelAccount(req);
  if (!resolved.ok) return resolved.response;
  const { accountId } = resolved;

  // Flip to 'disabled' so the migration 027 partial-unique-index slot is
  // released immediately, allowing a fresh mobile channel enrollment.
  // Advisory lock is held across the UPDATE so a concurrent start cannot
  // observe the pending row, fall through to its UPDATE branch (no status
  // guard), and overwrite this cancel's 'disabled' transition back to
  // 'pending_verification'. Locks by the account-scoped mobile_enroll key,
  // matching the Telegram start/cancel and the owner routes —
  // so the chat channels mutually exclude on the lock.
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${accountId}`}, 0))`;
    return cancelWhatsAppEnrollment(tx, accountId);
  });

  // Invalidate channel cache — the cancelled verification changes which
  // channels are available for dispatch.
  await safeInvalidateChannelCache(asAccountId(accountId), 'admin.whatsapp.cancel');

  // M6: no-store for consistency with start/disable routes (admin-action results
  // must not be cached by proxies or the browser).
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, private' } });
}

export const POST = withSameOrigin()(cancelWhatsApp);
