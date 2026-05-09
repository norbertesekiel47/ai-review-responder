// src/app/api/admin/channels/telegram/start/route.ts
//
// POST /api/admin/channels/telegram/start — admin generates a one-time Telegram
// verification deep link + QR for owner scan.
//
// Handler order: flag → env → auth → businessId → subscription → advisory lock → state-machine upsert.
//
// State machine logic lives in src/lib/channels/telegram-enrollment.ts and is
// shared with the owner route at /api/dashboard/channels/telegram/start.
// 23505 from migration 027 → MultipleMobileChannelsError → 409.

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '../_shared';
import { startTelegramEnrollment } from '@/lib/channels/telegram-enrollment';
import { MultipleMobileChannelsError, EnrollmentDatabaseError } from '@/lib/channels/unique-violation';
import { TOKEN_TTL_MS } from '@/lib/notifications/channels/constants';
import { invalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  try {
    await requireRole(req, 'admin', 'sales_partner');
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }

  const body = (await req.json().catch(() => null)) as { businessId?: string } | null;
  const businessId = body?.businessId;
  if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

  // After migration 034, subscription_status source of truth is accounts.
  const [accountRow] = await sql<{ id: string; subscription_status: string }[]>`
    SELECT a.id, a.subscription_status
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    WHERE b.id = ${businessId}
  `;
  if (!accountRow) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (accountRow.subscription_status !== SubscriptionStatus.ACTIVE) {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }
  const accountId = accountRow.id;

  // Generate token + hash + expiresAt OUTSIDE the tx so the secret doesn't
  // depend on a possibly-rolled-back transaction.
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  const noStore = { 'Cache-Control': 'no-store, private' };

  let result: Awaited<ReturnType<typeof startTelegramEnrollment>>;
  try {
    result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${businessId}`}, 0))`;
      return startTelegramEnrollment(tx, businessId, accountId, tokenHash, expiresAt);
    });
  } catch (err) {
    if (err instanceof MultipleMobileChannelsError) {
      return NextResponse.json({ error: 'multiple_mobile_channels' }, { status: 409, headers: noStore });
    }
    if (err instanceof EnrollmentDatabaseError) {
      console.error('[telegram/start] enrollment db error', err);
      return NextResponse.json({ error: 'internal' }, { status: 500, headers: noStore });
    }
    throw err;
  }

  if (result.kind === 'already_verified') {
    return NextResponse.json({ error: 'already_verified' }, { status: 409, headers: noStore });
  }

  // Invalidate channel cache — the enrollment state change affects which
  // channels are available for dispatch. Best-effort: a Redis failure
  // should not block the admin response.
  await invalidateChannelCache(asAccountId(accountId)).catch(() => {});

  const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? 'RepWorthBot';
  const deepLink = `https://t.me/${botUsername}?start=${rawToken}`;
  const qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 256 });

  return NextResponse.json(
    { deepLink, qrDataUrl, expiresAt: expiresAt.toISOString() },
    { headers: noStore },
  );
}
