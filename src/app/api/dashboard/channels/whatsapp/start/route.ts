// src/app/api/dashboard/channels/whatsapp/start/route.ts
//
// POST /api/dashboard/channels/whatsapp/start — owner-scoped enrollment.
// Mirrors the owner Telegram route: locationId from session (never body),
// wrapped with withSameOrigin() (CSRF). Orchestrates startWhatsAppEnrollment.

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '@/app/api/admin/channels/whatsapp/_shared';
import { startWhatsAppEnrollment } from '@/lib/channels/whatsapp-enrollment';
import { MultipleMobileChannelsError, EnrollmentDatabaseError } from '@/lib/channels/unique-violation';
import { TOKEN_TTL_MS } from '@/lib/notifications/channels/constants';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';
import { getActiveLocationCount } from '@/lib/locations/repo';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isWhatsAppEnabled()) return flagOff();

  const envErr = assertWhatsAppEnvReady();
  if (envErr) return envErr;

  let user;
  try {
    user = await requireRole(req, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    throw err; // surface unexpected (non-auth) failures as 5xx, not a misleading 401
  }

  const locationId = user.locationId;
  if (!locationId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  // After migration 034, subscription_status source of truth is accounts.
  const [accountRow] = await sql<{ id: string; subscription_status: string }[]>`
    SELECT a.id, a.subscription_status
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    WHERE b.id = ${locationId}
  `;
  if (!accountRow) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (accountRow.subscription_status !== SubscriptionStatus.ACTIVE) {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }
  const accountId = accountRow.id;

  // Interim safeguard: WhatsApp owner self-service is single-location-only until
  // the cross-channel account-scope fix lands (see
  // docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md).
  // The org-default enrollment desyncs on multi-location accounts because the
  // read/write paths key by business_id while the page hydrates by account_id.
  const noStore = { 'Cache-Control': 'no-store, private' };
  const activeLocationCount = await getActiveLocationCount(accountId);
  if (activeLocationCount > 1) {
    return NextResponse.json({ error: 'multi_location_unsupported' }, { status: 403, headers: noStore });
  }

  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  let result: Awaited<ReturnType<typeof startWhatsAppEnrollment>> | undefined;
  try {
    result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${locationId}`}, 0))`;
      return startWhatsAppEnrollment(tx, locationId, accountId, tokenHash, expiresAt);
    });
  } catch (err) {
    if (err instanceof MultipleMobileChannelsError) {
      return NextResponse.json({ error: 'multiple_mobile_channels' }, { status: 409, headers: noStore });
    }
    if (err instanceof EnrollmentDatabaseError) {
      console.error('[owner whatsapp/start] enrollment db error', err);
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
  await safeInvalidateChannelCache(asAccountId(accountId), 'dashboard.whatsapp.start');

  // wa.me requires digits only (no +, no whatsapp:).
  const digits = process.env.TWILIO_WHATSAPP_NUMBER!.replace(/^whatsapp:\+?/, '');
  const prefilled = encodeURIComponent(`start-${rawToken}`);
  const deepLink = `https://wa.me/${digits}?text=${prefilled}`;
  const qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 256 });

  return NextResponse.json(
    { deepLink, qrDataUrl, expiresAt: expiresAt.toISOString() },
    { headers: noStore },
  );
}

export const POST = withSameOrigin()(handler);
