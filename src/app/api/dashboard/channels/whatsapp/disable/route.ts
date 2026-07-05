// src/app/api/dashboard/channels/whatsapp/disable/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { resolveWritableAccountForLocation } from '@/lib/shared/writable-subscription';
import { requireRoleOr401, withSameOrigin, errorResponse } from '@/lib/auth/route-helpers';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '@/app/api/admin/channels/whatsapp/_shared';
import { sql } from '@/lib/db/server';
import { disconnectChannel } from '@/lib/channels/disable-enrollment';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isWhatsAppEnabled()) return flagOff();

  const envErr = assertWhatsAppEnvReady();
  if (envErr) return envErr;

  const auth = await requireRoleOr401(req, 'owner');
  if (!auth.ok) return auth.response;
  const user = auth.user;

  if (!user.locationId) return errorResponse('no_business', 403);

  const gate = await resolveWritableAccountForLocation(user.locationId);
  if (gate.kind === 'blocked') return errorResponse(gate.error, gate.status);
  if (gate.kind === 'no_account') return errorResponse('subscription_not_active', 403);

  const result = await disconnectChannel(sql, {
    channel: 'whatsapp',
    accountId: gate.accountId,
    actorUserId: user.id,
    surface: 'dashboard',
  });

  const noStore = { 'Cache-Control': 'no-store, private' };
  if (result.kind === 'not_found') {
    return errorResponse('not_found', 404);
  }
  return NextResponse.json({ ok: true }, { headers: noStore });
}

export const POST = withSameOrigin()(handler);
