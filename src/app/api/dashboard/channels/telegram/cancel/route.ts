// src/app/api/dashboard/channels/telegram/cancel/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { cancelTelegramEnrollment } from '@/lib/channels/telegram-enrollment';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  let user;
  try {
    user = await requireRole(req, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!user.locationId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  // After migration 034, subscription_status source of truth is accounts.
  const [accountRow] = await sql<{ subscription_status: string }[]>`
    SELECT a.subscription_status
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    WHERE b.id = ${user.locationId}
  `;
  if (accountRow?.subscription_status !== SubscriptionStatus.ACTIVE) {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }

  const locationId = user.locationId;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${locationId}`}, 0))`;
    return cancelTelegramEnrollment(tx, locationId);
  });

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, private' } });
}

export const POST = withSameOrigin()(handler);
