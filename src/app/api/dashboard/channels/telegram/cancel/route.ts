// src/app/api/dashboard/channels/telegram/cancel/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { resolveWritableAccountForLocation } from '@/lib/shared/writable-subscription';
import { requireRoleOr401, withSameOrigin, errorResponse } from '@/lib/auth/route-helpers';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { cancelMobileEnrollment } from '@/lib/channels/mobile-enrollment';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  const auth = await requireRoleOr401(req, 'owner');
  if (!auth.ok) return auth.response;
  const user = auth.user;

  if (!user.locationId) return errorResponse('no_business', 403);

  const gate = await resolveWritableAccountForLocation(user.locationId, sql);
  if (gate.kind === 'blocked') return errorResponse(gate.error, gate.status);
  if (gate.kind === 'no_account') return errorResponse('subscription_not_active', 403);
  const accountId = gate.accountId;

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${accountId}`}, 0))`;
    return cancelMobileEnrollment(tx, 'telegram', accountId);
  });

  // Invalidate channel cache — the cancelled verification changes which
  // channels are available for dispatch.
  await safeInvalidateChannelCache(asAccountId(accountId), 'dashboard.telegram.cancel');

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, private' } });
}

export const POST = withSameOrigin()(handler);
