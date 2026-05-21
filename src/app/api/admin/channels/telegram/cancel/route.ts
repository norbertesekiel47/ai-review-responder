// src/app/api/admin/channels/telegram/cancel/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';
import { cancelTelegramEnrollment } from '@/lib/channels/telegram-enrollment';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import { withSameOrigin } from '@/lib/auth/route-helpers';

async function cancelTelegram(req: NextRequest): Promise<NextResponse> {
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

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${businessId}`}, 0))`;
    return cancelTelegramEnrollment(tx, businessId);
  });

  // Invalidate channel cache — the cancelled verification changes which
  // channels are available for dispatch.
  const [acctRow] = await sql<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${businessId}
  `;
  if (acctRow?.account_id) {
    await safeInvalidateChannelCache(asAccountId(acctRow.account_id), 'admin.telegram.cancel');
  }

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, private' } });
}

export const POST = withSameOrigin()(cancelTelegram);
