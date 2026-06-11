// src/app/api/admin/channels/whatsapp/disable — admin disables a verified enrollment.
// Returns 404 if no verified row matches (user-facing signal that there's nothing to disable).
//
// Handler order: same-origin wrapper → flag → env → auth → businessId.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '../_shared';
import { resolveAdminChannelAccount } from '@/app/api/admin/channels/_shared/account';
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
  const { accountId, actorUserId } = resolved;

  // M6: no-store for consistency across admin whatsapp routes.
  const noStore = { 'Cache-Control': 'no-store, private' };

  // disableWhatsAppEnrollment is account-scoped: it disables the org-default
  // row AND cascades to every per-location override (with audit rows) in one
  // transaction.
  const result = await sql.begin((tx) =>
    disableWhatsAppEnrollment(tx, { accountId, actorUserId }),
  );
  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }

  // Invalidate channel cache AFTER the tx commits — the disabled channel must
  // be removed from the dispatch resolution immediately.
  await safeInvalidateChannelCache(asAccountId(accountId), 'admin.whatsapp.disable');

  return NextResponse.json({ ok: true }, { headers: noStore });
}

export const POST = withSameOrigin()(disableWhatsApp);
