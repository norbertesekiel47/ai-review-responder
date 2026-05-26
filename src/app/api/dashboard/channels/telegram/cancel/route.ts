// src/app/api/dashboard/channels/telegram/cancel/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { computePastDueRecoveryState, type AccountFlagsInput } from '@/lib/shared/past-due-recovery';
import { assertWritableSubscription } from '@/lib/shared/writable-subscription';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { cancelTelegramEnrollment } from '@/lib/channels/telegram-enrollment';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';

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
  const [accountRow] = await sql<{
    id: string;
    subscription_status: string;
    past_due_at: Date | string | null;
    flags: AccountFlagsInput;
  }[]>`
    SELECT a.id, a.subscription_status, a.past_due_at, a.flags
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    WHERE b.id = ${user.locationId}
  `;
  if (accountRow?.subscription_status === SubscriptionStatus.PAST_DUE) {
    const writable = assertWritableSubscription(computePastDueRecoveryState({
      subscriptionStatus: accountRow.subscription_status,
      pastDueAt: accountRow.past_due_at,
      accountFlags: accountRow.flags,
    }));
    if (!writable.ok) return NextResponse.json({ error: writable.error }, { status: writable.status });
  } else if (accountRow?.subscription_status !== SubscriptionStatus.ACTIVE) {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }
  const accountId = accountRow.id;

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${accountId}`}, 0))`;
    return cancelTelegramEnrollment(tx, accountId);
  });

  // Invalidate channel cache — the cancelled verification changes which
  // channels are available for dispatch.
  await safeInvalidateChannelCache(asAccountId(accountId), 'dashboard.telegram.cancel');

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, private' } });
}

export const POST = withSameOrigin()(handler);
