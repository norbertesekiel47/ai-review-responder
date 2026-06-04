// src/app/api/admin/channels/whatsapp/disable — admin disables a verified enrollment.
// Returns 404 if no verified row matches (user-facing signal that there's nothing to disable).
//
// Handler order: same-origin wrapper → flag → env → auth → businessId.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '../_shared';
import { resolveAdminChannelAccount } from '../../_shared/account';
import { disableWhatsAppEnrollment } from '@/lib/channels/whatsapp-enrollment';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import { withSameOrigin } from '@/lib/auth/route-helpers';

async function disableWhatsApp(req: NextRequest): Promise<NextResponse> {
  if (!isWhatsAppEnabled()) return flagOff();

  const envErr = assertWhatsAppEnvReady();
  if (envErr) return envErr;

  const resolved = await resolveAdminChannelAccount(req);
  if (!resolved.ok) return resolved.response;
  const { accountId } = resolved;

  // M6: no-store for consistency across admin whatsapp routes.
  const noStore = { 'Cache-Control': 'no-store, private' };

  // disableWhatsAppEnrollment is account-scoped (org-default row,
  // location_id IS NULL), so it is keyed by the resolved account.
  const result = await disableWhatsAppEnrollment(sql, accountId);
  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }

  // Invalidate channel cache — the disabled channel must be removed from
  // the dispatch resolution immediately.
  await safeInvalidateChannelCache(asAccountId(accountId), 'admin.whatsapp.disable');

  return NextResponse.json({ ok: true }, { headers: noStore });
}

export const POST = withSameOrigin()(disableWhatsApp);
