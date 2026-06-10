// src/app/api/admin/businesses/[id]/channels/route.ts
//
// Uses the existing auth helper at src/lib/db/auth.ts — `requireRole(request, ...roles)`
// throws AuthError on unauthenticated (401) or non-matching role (403).
// Mirrors the auth + dynamic-route pattern in src/app/api/admin/businesses/[id]/route.ts:74
// (Next.js 15: params is a Promise that must be awaited).
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRoleOr401 } from '@/lib/auth/route-helpers';
import { asLocationId } from '@/lib/shared/ids';
import type { LocationId } from '@/lib/shared/ids';

// Shape of one enrollment row, before per-channel dedup and handle masking.
interface ChannelEnrollmentRow {
  channel: string;
  handle: string | null;
  status: string;
  verified_at: Date | null;
  disabled_at: Date | null;
  unsubscribed_at: Date | null;
  unsubscribed_reason: string | null;
  expires_at: Date | null;
  last_activity_at: Date | null;
  /** null = account-scoped org-default; non-null = per-location override. */
  location_id: string | null;
}

// Admin/customer data — never cache. Matches the pattern in the existing
// admin business detail API at src/app/api/admin/businesses/[id]/route.ts:7.
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: rawBusinessId } = await params;
  const businessId: LocationId = asLocationId(rawBusinessId);

  const auth = await requireRoleOr401(request, 'admin');
  if (!auth.ok) return auth.response;

  // Channel enrollment is ACCOUNT-scoped: admin start/disable act on the
  // org-default row (account_id + channel + location_id IS NULL), regardless of
  // which location's detail page is open. `business_id` on the table is a legacy
  // FK and is NOT the org-default lookup key. So we resolve the account from the
  // location, then read account-scoped — mirroring resolveChannels' precedence
  // (per-location override beats org-default). See docs/known-issues.md
  // "ACTIVE: Admin per-business channel status read".
  const [accountRow] = await sql<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${businessId}
  `;
  if (!accountRow) {
    return NextResponse.json({ enrollments: [] });
  }
  const accountId = accountRow.account_id;

  const rows = await sql<ChannelEnrollmentRow[]>`
    SELECT
      e.channel, e.handle, e.status,
      e.verified_at, e.disabled_at, e.unsubscribed_at, e.unsubscribed_reason,
      e.verification_token_expires_at AS expires_at,
      e.location_id,
      -- Per-row COALESCE (delivered OR sent), THEN aggregate MAX. Doing it
      -- the other way (COALESCE(MAX(delivered), MAX(sent))) would return
      -- the older delivered timestamp when a newer row has only sent_at.
      -- Scope deliveries to the VIEWED location (the route's businessId), not
      -- the enrollment row's legacy business_id: an org-default row carries
      -- the creator location's business_id, so e.business_id would surface a
      -- different location's activity on this page.
      (SELECT MAX(COALESCE(nd.delivered_at, nd.sent_at))
         FROM notification_deliveries nd
         WHERE nd.business_id = ${businessId}
           AND nd.channel = e.channel) AS last_activity_at
    FROM channel_enrollments e
    WHERE e.account_id = ${accountId}
      AND (e.location_id = ${businessId} OR e.location_id IS NULL)
      AND e.archived_at IS NULL
    ORDER BY
      -- Per-location overrides first so the dedup keeps them over org-defaults
      -- for the same channel (mirrors resolveChannels VAL-NOTIF-003).
      CASE WHEN e.location_id IS NOT NULL THEN 0 ELSE 1 END,
      e.created_at ASC
  `;

  const effective = resolveEffectiveEnrollments(rows);

  // `location_id` is an internal resolution detail used only for override-vs-
  // org-default precedence; it is intentionally not part of the response.
  const masked = effective.map((r) => ({
    channel: r.channel,
    handle: maskHandle(r.channel, r.handle),
    status: r.status,
    verified_at: r.verified_at,
    disabled_at: r.disabled_at,
    unsubscribed_at: r.unsubscribed_at,
    unsubscribed_reason: r.unsubscribed_reason,
    expires_at: r.expires_at,
    last_activity_at: r.last_activity_at,
  }));

  return NextResponse.json({ enrollments: masked });
}

/**
 * Collapses account-scoped rows to one effective enrollment per channel,
 * preferring a per-location override over the org-default. Relies on the
 * query's ORDER BY placing overrides (location_id NOT NULL) before org-defaults
 * for each channel, so the first row seen per channel is the one that wins.
 */
function resolveEffectiveEnrollments(rows: ChannelEnrollmentRow[]): ChannelEnrollmentRow[] {
  const byChannel = new Map<string, ChannelEnrollmentRow>();
  for (const row of rows) {
    if (!byChannel.has(row.channel)) {
      byChannel.set(row.channel, row);
    }
  }
  return Array.from(byChannel.values());
}

function maskHandle(channel: string, handle: string | null): string {
  if (handle === null) return '(pending verification)';
  if (channel === 'email') return handle;
  if (channel === 'whatsapp') {
    // Show first 3 + last 4, mask the rest. For short handles (<= 7 chars),
    // the hidden section becomes zero-width — must clamp to avoid
    // `'•'.repeat(-1)` which throws RangeError.
    if (handle.length <= 4) return handle;
    const hidden = Math.max(0, handle.length - 7);
    return handle.slice(0, 3) + '•'.repeat(hidden) + handle.slice(-4);
  }
  if (channel === 'telegram') {
    // Telegram chat_id is a numeric identifier. Show last 4 digits for admin
    // recognition — not PII-sensitive (the owner voluntarily enrolled via QR).
    if (handle.length <= 4) return handle;
    return '••• ' + handle.slice(-4);
  }
  return handle;
}
