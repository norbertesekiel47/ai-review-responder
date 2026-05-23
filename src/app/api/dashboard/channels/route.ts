// src/app/api/dashboard/channels/route.ts
//
// GET /api/dashboard/channels — owner-scoped status endpoint.
// Returns the canonical { enrollments: [...], available, reasons } shape
// consumed by useEnrollment + the channels page.
//
// Auth: requireRole(req, 'owner') — businessId from session, never body.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { isTelegramEnabled, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { whatsappEnvReady } from '@/app/api/admin/channels/whatsapp/_shared';

export const dynamic = 'force-dynamic';

function maskHandle(channel: string, handle: string | null): string | null {
  if (handle === null) return null;
  if (channel === 'email') return handle;
  if (channel === 'sms' || channel === 'whatsapp') {
    if (handle.length <= 4) return handle;
    const hidden = Math.max(0, handle.length - 7);
    return handle.slice(0, 3) + '•'.repeat(hidden) + handle.slice(-4);
  }
  if (channel === 'telegram') {
    if (handle.length <= 4) return handle;
    return '••• ' + handle.slice(-4);
  }
  return handle;
}

function smsAvailable(): boolean {
  if (process.env.CHANNELS_SMS_ENABLED !== 'true') return false;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return true;
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID', 'TWILIO_VERIFY_SERVICE_SID'];
  return required.every((k) => process.env[k] && process.env[k]!.trim().length > 0);
}

function whatsappAvailable(): boolean {
  if (process.env.CHANNELS_WHATSAPP_ENABLED !== 'true') return false;
  return whatsappEnvReady();
}

function telegramAvailable(): boolean {
  if (!isTelegramEnabled()) return false;
  return assertTelegramEnvReady() === null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let user;
  try {
    user = await requireRole(request, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!user.locationId) {
    return NextResponse.json({ error: 'no_business' }, { status: 403 });
  }

  // Subscription guard — defense-in-depth (page server component already redirects).
  // After migration 034, subscription_status source of truth is accounts.
  const [accountRow] = await sql<{ subscription_status: string }[]>`
    SELECT a.subscription_status
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    WHERE b.id = ${user.locationId}
  `;
  if (!accountRow) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (accountRow.subscription_status !== SubscriptionStatus.ACTIVE) {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }

  // verification_token_hash INTENTIONALLY excluded from SELECT — only the
  // expiry timestamp is exposed (so the UI can render a countdown).
  const rows = await sql<{
    channel: string;
    handle: string | null;
    status: string;
    verified_at: Date | null;
    disabled_at: Date | null;
    unsubscribed_at: Date | null;
    unsubscribed_reason: string | null;
    expires_at: Date | null;
  }[]>`
    SELECT
      e.channel, e.handle, e.status,
      e.verified_at, e.disabled_at, e.unsubscribed_at, e.unsubscribed_reason,
      e.verification_token_expires_at AS expires_at
    FROM channel_enrollments e
    WHERE e.business_id = ${user.locationId}
      AND e.archived_at IS NULL
    ORDER BY e.created_at ASC
  `;

  const enrollments = rows.map((r) => ({
    channel: r.channel,
    handle: maskHandle(r.channel, r.handle),
    status: r.status,
    verified_at: r.verified_at?.toISOString() ?? null,
    disabled_at: r.disabled_at?.toISOString() ?? null,
    unsubscribed_at: r.unsubscribed_at?.toISOString() ?? null,
    unsubscribed_reason: r.unsubscribed_reason,
    expires_at: r.expires_at?.toISOString() ?? null,
  }));

  return NextResponse.json(
    {
      enrollments,
      available: {
        telegram: telegramAvailable(),
        sms: smsAvailable(),
        whatsapp: whatsappAvailable(),
      },
      reasons: {
        sms: 'pending_10dlc',
        whatsapp: 'pending_meta_verification',
      },
    },
    { headers: { 'Cache-Control': 'no-store, private' } },
  );
}
