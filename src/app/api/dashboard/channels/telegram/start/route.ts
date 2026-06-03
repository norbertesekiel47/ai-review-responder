// src/app/api/dashboard/channels/telegram/start/route.ts
//
// POST /api/dashboard/channels/telegram/start — owner-scoped enrollment.
// Mirrors the admin route but reads locationId from session (never body)
// and is wrapped with withSameOrigin() (CSRF protection).

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { sql } from '@/lib/db/server';
import { resolveWritableAccountForLocation } from '@/lib/shared/writable-subscription';
import { requireRoleOr401, withSameOrigin } from '@/lib/auth/route-helpers';
import { isTelegramEnabled, flagOff, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { startTelegramEnrollment } from '@/lib/channels/telegram-enrollment';
import { MultipleMobileChannelsError, EnrollmentDatabaseError } from '@/lib/channels/unique-violation';
import { TOKEN_TTL_MS } from '@/lib/notifications/channels/constants';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramEnabled()) return flagOff();

  const envErr = assertTelegramEnvReady();
  if (envErr) return envErr;

  const auth = await requireRoleOr401(req, 'owner');
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const locationId = user.locationId;
  if (!locationId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  const gate = await resolveWritableAccountForLocation(locationId);
  if (gate.kind === 'no_account') return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (gate.kind === 'blocked') return NextResponse.json({ error: gate.error }, { status: gate.status });
  const accountId = gate.accountId;

  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const noStore = { 'Cache-Control': 'no-store, private' };

  let result: Awaited<ReturnType<typeof startTelegramEnrollment>> | undefined;
  try {
    result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${accountId}`}, 0))`;
      return startTelegramEnrollment(tx, locationId, accountId, tokenHash, expiresAt);
    });
  } catch (err) {
    if (err instanceof MultipleMobileChannelsError) {
      return NextResponse.json({ error: 'multiple_mobile_channels' }, { status: 409, headers: noStore });
    }
    if (err instanceof EnrollmentDatabaseError) {
      console.error('[owner telegram/start] enrollment db error', err);
      return NextResponse.json({ error: 'internal' }, { status: 500, headers: noStore });
    }
    throw err;
  }

  if (result?.kind === 'already_verified') {
    return NextResponse.json({ error: 'already_verified' }, { status: 409, headers: noStore });
  }

  // Invalidate channel cache — the enrollment state change affects which
  // channels are available for dispatch. Best-effort: a Redis failure
  // should not block the owner response.
  await safeInvalidateChannelCache(asAccountId(accountId), 'dashboard.telegram.start');

  // `||` (not `??`) so a blank TELEGRAM_BOT_USERNAME falls back too — an empty
  // string would otherwise produce a broken https://t.me/?start=... link.
  const botUsername = process.env.TELEGRAM_BOT_USERNAME?.trim() || 'RepWorthBot';
  const deepLink = `https://t.me/${botUsername}?start=${rawToken}`;
  const qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 256 });

  return NextResponse.json(
    { deepLink, qrDataUrl, expiresAt: expiresAt.toISOString() },
    { headers: noStore },
  );
}

export const POST = withSameOrigin()(handler);
