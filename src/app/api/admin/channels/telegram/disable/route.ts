// src/app/api/admin/channels/telegram/disable/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';
import { disableTelegramEnrollment } from '@/lib/channels/telegram-enrollment';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import { withSameOrigin } from '@/lib/auth/route-helpers';

async function disableTelegram(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  try {
    await requireRole(req, 'admin');
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }

  const body = (await req.json().catch(() => null)) as { businessId?: string } | null;
  const businessId = body?.businessId;
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  const noStore = { 'Cache-Control': 'no-store, private' };

  // Resolve account_id first — disableTelegramEnrollment is account-scoped
  // (org-default row, location_id IS NULL), so it must be keyed by account.
  const [acctRow] = await sql<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${businessId}
  `;
  if (!acctRow) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }

  const result = await disableTelegramEnrollment(sql, acctRow.account_id);
  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }

  // Invalidate channel cache — the disabled channel must be removed from
  // the dispatch resolution immediately.
  await safeInvalidateChannelCache(asAccountId(acctRow.account_id), 'admin.telegram.disable');

  return NextResponse.json({ ok: true }, { headers: noStore });
}

export const POST = withSameOrigin()(disableTelegram);
