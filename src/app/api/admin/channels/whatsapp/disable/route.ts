// src/app/api/admin/channels/whatsapp/disable — admin disables a verified enrollment.
// Returns 404 if no verified row matches (user-facing signal that there's nothing to disable).
//
// Handler order: same-origin wrapper → flag → env → auth → businessId.

import { NextRequest, NextResponse } from 'next/server';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '../_shared';
import { resolveAdminChannelAccount } from '@/app/api/admin/channels/_shared/account';
import { disconnectChannel } from '@/lib/channels/disable-enrollment';
import { withSameOrigin } from '@/lib/auth/route-helpers';

async function disableWhatsApp(req: NextRequest): Promise<NextResponse> {
  if (!isWhatsAppEnabled()) return flagOff();

  const envErr = assertWhatsAppEnvReady();
  if (envErr) return envErr;

  const resolved = await resolveAdminChannelAccount(req);
  if (!resolved.ok) return resolved.response;

  const result = await disconnectChannel({
    channel: 'whatsapp',
    accountId: resolved.accountId,
    actorUserId: resolved.actorUserId,
    surface: 'admin',
  });

  // M6: no-store for consistency across admin whatsapp routes.
  const noStore = { 'Cache-Control': 'no-store, private' };
  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }
  return NextResponse.json({ ok: true }, { headers: noStore });
}

export const POST = withSameOrigin()(disableWhatsApp);
