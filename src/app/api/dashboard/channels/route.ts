// src/app/api/dashboard/channels/route.ts
//
// GET /api/dashboard/channels — owner-scoped status endpoint.
// Returns the canonical { enrollments: [...], available, reasons } shape
// consumed by useEnrollment + the channels page.
//
// Auth: requireRole(req, 'owner') — businessId from session, never body.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRoleOr401, errorResponse } from '@/lib/auth/route-helpers';
import { subscriptionAllowsDashboardRead } from '@/lib/shared/subscription-status';
import { isTelegramEnabled, assertTelegramEnvReady } from '@/app/api/admin/channels/telegram/_shared';
import { whatsappEnvReady } from '@/app/api/admin/channels/whatsapp/_shared';
import { CHANNEL_IDS } from '@/lib/notifications/channels/types';
import { maskChannelHandle } from '@/lib/notifications/mask-handle';

export const dynamic = 'force-dynamic';


function whatsappAvailable(): boolean {
  if (process.env.CHANNELS_WHATSAPP_ENABLED !== 'true') return false;
  return whatsappEnvReady();
}

function telegramAvailable(): boolean {
  if (!isTelegramEnabled()) return false;
  return assertTelegramEnvReady() === null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireRoleOr401(request, 'owner');
  if (!auth.ok) return auth.response;
  const user = auth.user;

  if (!user.locationId) {
    return errorResponse('no_business', 403);
  }

  // Subscription guard — defense-in-depth (page server component already redirects).
  // This status endpoint is read-only, so past_due accounts can still inspect
  // channel state while write routes enforce the recovery/read-only guard.
  // After migration 034, subscription_status source of truth is accounts.
  const [accountRow] = await sql<{ id: string; subscription_status: string }[]>`
    SELECT a.id, a.subscription_status
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    WHERE b.id = ${user.locationId}
  `;
  if (!accountRow) return errorResponse('not_found', 404);
  if (!subscriptionAllowsDashboardRead(accountRow.subscription_status)) {
    return errorResponse('subscription_not_active', 403);
  }
  const accountId = accountRow.id;

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
    WHERE e.account_id = ${accountId}
      AND e.location_id IS NULL
      AND e.archived_at IS NULL
      AND e.channel = ANY(${[...CHANNEL_IDS] as string[]}::text[])
    ORDER BY e.created_at ASC
  `;

  const enrollments = rows.map((r) => ({
    channel: r.channel,
    handle: r.handle !== null ? maskChannelHandle(r.channel, r.handle) : null,
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
        whatsapp: whatsappAvailable(),
      },
      reasons: {
        whatsapp: 'pending_meta_verification',
      },
    },
    { headers: { 'Cache-Control': 'no-store, private' } },
  );
}
