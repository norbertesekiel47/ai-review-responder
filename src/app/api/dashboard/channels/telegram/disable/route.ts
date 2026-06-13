// src/app/api/dashboard/channels/telegram/disable/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { resolveWritableAccountForLocation } from '@/lib/shared/writable-subscription';
import { requireRoleOr401, withSameOrigin, errorResponse } from '@/lib/auth/route-helpers';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { disconnectChannel } from '@/lib/channels/disable-enrollment';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  const auth = await requireRoleOr401(req, 'owner');
  if (!auth.ok) return auth.response;
  const user = auth.user;

  if (!user.locationId) return errorResponse('no_business', 403);

  const gate = await resolveWritableAccountForLocation(user.locationId);
  if (gate.kind === 'blocked') return errorResponse(gate.error, gate.status);
  if (gate.kind === 'no_account') return errorResponse('subscription_not_active', 403);

  const result = await disconnectChannel({
    channel: 'telegram',
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
