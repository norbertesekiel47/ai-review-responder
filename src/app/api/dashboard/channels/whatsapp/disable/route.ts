// src/app/api/dashboard/channels/whatsapp/disable/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { resolveWritableAccountForLocation } from '@/lib/shared/writable-subscription';
import { requireRoleOr401, withSameOrigin } from '@/lib/auth/route-helpers';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '@/app/api/admin/channels/whatsapp/_shared';
import { disconnectChannel } from '@/lib/channels/disable-enrollment';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isWhatsAppEnabled()) return flagOff();

  const envErr = assertWhatsAppEnvReady();
  if (envErr) return envErr;

  const auth = await requireRoleOr401(req, 'owner');
  if (!auth.ok) return auth.response;
  const user = auth.user;

  if (!user.locationId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  const gate = await resolveWritableAccountForLocation(user.locationId);
  if (gate.kind === 'blocked') return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (gate.kind === 'no_account') return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });

  const result = await disconnectChannel({
    channel: 'whatsapp',
    accountId: gate.accountId,
    actorUserId: user.id,
    surface: 'dashboard',
  });

  const noStore = { 'Cache-Control': 'no-store, private' };
  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }
  return NextResponse.json({ ok: true }, { headers: noStore });
}

export const POST = withSameOrigin()(handler);
