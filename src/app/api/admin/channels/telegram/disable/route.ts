// src/app/api/admin/channels/telegram/disable/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';
import { resolveAdminChannelAccount } from '@/app/api/admin/channels/_shared/account';
import { disableTelegramEnrollment } from '@/lib/channels/telegram-enrollment';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import { withSameOrigin } from '@/lib/auth/route-helpers';

async function disableTelegram(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  const resolved = await resolveAdminChannelAccount(req);
  if (!resolved.ok) return resolved.response;
  const { accountId, actorUserId } = resolved;

  const noStore = { 'Cache-Control': 'no-store, private' };

  // disableTelegramEnrollment is account-scoped: it disables the org-default
  // row AND cascades to every per-location override (with audit rows) in one
  // transaction.
  const result = await sql.begin((tx) =>
    disableTelegramEnrollment(tx, { accountId, actorUserId }),
  );
  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }

  // Invalidate channel cache AFTER the tx commits — the disabled channel must
  // be removed from the dispatch resolution immediately.
  await safeInvalidateChannelCache(asAccountId(accountId), 'admin.telegram.disable');

  return NextResponse.json({ ok: true }, { headers: noStore });
}

export const POST = withSameOrigin()(disableTelegram);
