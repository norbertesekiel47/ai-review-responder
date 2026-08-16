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
import {
  telegramAvailable,
  whatsappAvailable,
} from '@/lib/notifications/channels/availability';
import { maskChannelHandle } from '@/lib/notifications/mask-handle';
import { getOrgDefaultChannelEnrollments } from '@/lib/channels/org-default-enrollments';

export const dynamic = 'force-dynamic';

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

  // Org-default rows come from their single owner; this route only masks and
  // serializes them.
  const rows = await getOrgDefaultChannelEnrollments(sql, accountId);

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
