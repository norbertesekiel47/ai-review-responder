// src/app/api/dashboard/channels/telegram/disable/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { resolveWritableAccountForLocation } from '@/lib/shared/writable-subscription';
import { requireRoleOr401, withSameOrigin } from '@/lib/auth/route-helpers';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { disableTelegramEnrollment } from '@/lib/channels/telegram-enrollment';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  const auth = await requireRoleOr401(req, 'owner');
  if (!auth.ok) return auth.response;
  const user = auth.user;

  if (!user.locationId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  const gate = await resolveWritableAccountForLocation(user.locationId);
  if (gate.kind === 'blocked') return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (gate.kind === 'no_account') return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  const accountId = gate.accountId;

  // Disconnect cascades: the org-default disable AND every per-location
  // override disable (plus their audit rows) commit in one transaction.
  const result = await sql.begin((tx) =>
    disableTelegramEnrollment(tx, { accountId, actorUserId: user.id }),
  );

  const noStore = { 'Cache-Control': 'no-store, private' };
  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }

  // Invalidate channel cache AFTER the tx commits — the disabled channel must
  // be removed from the dispatch resolution immediately.
  await safeInvalidateChannelCache(asAccountId(accountId), 'dashboard.telegram.disable');

  return NextResponse.json({ ok: true }, { headers: noStore });
}

export const POST = withSameOrigin()(handler);
