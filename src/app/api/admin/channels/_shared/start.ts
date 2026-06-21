// src/app/api/admin/channels/_shared/start.ts
//
// Shared admin mobile-channel enrollment-start handler. Telegram and WhatsApp
// admin /start routes run the identical chain — flag/env gate → admin auth →
// businessId → active-subscription account lookup → token generation →
// advisory-locked enrollment upsert → QR/deep-link response — differing only in
// the channel-specific bindings captured by AdminChannelStartConfig.

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { sql } from '@/lib/db/server';
import { startMobileEnrollment, type MobileChannel } from '@/lib/channels/mobile-enrollment';
import { requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';
import { MultipleMobileChannelsError, EnrollmentDatabaseError } from '@/lib/channels/unique-violation';
import { TOKEN_TTL_MS } from '@/lib/notifications/channels/constants';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

export interface AdminChannelStartConfig {
  channel: MobileChannel;
  isEnabled: () => boolean;
  flagOff: () => NextResponse;
  assertEnvReady: () => NextResponse | null;
  /** Builds the channel deep link the owner scans, from the raw token. */
  buildDeepLink: (rawToken: string) => string;
  /** safeInvalidateChannelCache label, e.g. "admin.telegram.start". */
  cacheLabel: string;
  /** reportCaughtError endpoint tag for enrollment DB errors, e.g. "telegram/start". */
  endpoint: string;
}

export async function runAdminChannelStart(
  req: NextRequest,
  config: AdminChannelStartConfig,
): Promise<NextResponse> {
  if (!config.isEnabled()) return config.flagOff();

  const envErr = config.assertEnvReady();
  if (envErr) return envErr;

  const gate = await requireAdminWithAal2(req);
  if (!gate.ok) return gate.response;

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
  if (!subscriptionGrantsFullAccess(accountRow.subscription_status)) {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }
  const accountId = accountRow.id;

  // Generate token + hash + expiresAt OUTSIDE the tx so the secret doesn't
  // depend on a possibly-rolled-back transaction.
  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  let result: { kind: 'ok' } | { kind: 'already_verified' };
  try {
    result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${accountId}`}, 0))`;
      return startMobileEnrollment(tx, config.channel, businessId, accountId, tokenHash, expiresAt);
    });
  } catch (err) {
    if (err instanceof MultipleMobileChannelsError) {
      return NextResponse.json({ error: 'multiple_mobile_channels' }, { status: 409, headers: NO_STORE });
    }
    if (err instanceof EnrollmentDatabaseError) {
      reportCaughtError(config.endpoint, err, {
        failure: 'enrollment_db_error',
        channel: config.channel,
        businessId,
        accountId,
      });
      return NextResponse.json({ error: 'internal' }, { status: 500, headers: NO_STORE });
    }
    throw err;
  }

  if (result.kind === 'already_verified') {
    return NextResponse.json({ error: 'already_verified' }, { status: 409, headers: NO_STORE });
  }

  // Invalidate channel cache — the enrollment state change affects which
  // channels are available for dispatch. Best-effort: a Redis failure
  // should not block the admin response.
  await safeInvalidateChannelCache(asAccountId(accountId), config.cacheLabel);

  const deepLink = config.buildDeepLink(rawToken);
  const qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 256 });

  return NextResponse.json(
    { deepLink, qrDataUrl, expiresAt: expiresAt.toISOString() },
    { headers: NO_STORE },
  );
}
