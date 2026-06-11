// src/app/api/admin/channels/telegram/disable/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';
import { resolveAdminChannelAccount } from '@/app/api/admin/channels/_shared/account';
import { disconnectChannel } from '@/lib/channels/disable-enrollment';
import { withSameOrigin } from '@/lib/auth/route-helpers';

async function disableTelegram(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  const resolved = await resolveAdminChannelAccount(req);
  if (!resolved.ok) return resolved.response;

  const result = await disconnectChannel({
    channel: 'telegram',
    accountId: resolved.accountId,
    actorUserId: resolved.actorUserId,
    surface: 'admin',
  });

  const noStore = { 'Cache-Control': 'no-store, private' };
  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }
  return NextResponse.json({ ok: true }, { headers: noStore });
}

export const POST = withSameOrigin()(disableTelegram);
