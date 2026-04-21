// src/app/api/admin/businesses/[id]/channels/route.ts
//
// Uses the existing auth helper at src/lib/db/auth.ts — `requireRole(request, ...roles)`
// throws AuthError on unauthenticated (401) or non-matching role (403).
// Mirrors the auth + dynamic-route pattern in src/app/api/admin/businesses/[id]/route.ts:74
// (Next.js 15: params is a Promise that must be awaited).
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';

// Admin/customer data — never cache. Matches the pattern in the existing
// admin business detail API at src/app/api/admin/businesses/[id]/route.ts:7.
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: businessId } = await params;

  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rows = await sql<{
    channel: string;
    handle: string | null;
    status: string;
    verified_at: Date | null;
    disabled_at: Date | null;
    unsubscribed_at: Date | null;
    unsubscribed_reason: string | null;
    last_activity_at: Date | null;
  }[]>`
    SELECT
      e.channel, e.handle, e.status,
      e.verified_at, e.disabled_at, e.unsubscribed_at, e.unsubscribed_reason,
      -- Per-row COALESCE (delivered OR sent), THEN aggregate MAX. Doing it
      -- the other way (COALESCE(MAX(delivered), MAX(sent))) would return
      -- the older delivered timestamp when a newer row has only sent_at.
      (SELECT MAX(COALESCE(nd.delivered_at, nd.sent_at))
         FROM notification_deliveries nd
         WHERE nd.business_id = e.business_id
           AND nd.channel = e.channel) AS last_activity_at
    FROM channel_enrollments e
    WHERE e.business_id = ${businessId}
    ORDER BY e.created_at ASC
  `;

  const masked = rows.map((r) => ({
    ...r,
    handle: maskHandle(r.channel, r.handle),
  }));

  return NextResponse.json({ enrollments: masked });
}

function maskHandle(channel: string, handle: string | null): string {
  if (handle === null) return '(pending verification)';
  if (channel === 'email') return handle;
  if (channel === 'sms' || channel === 'whatsapp') {
    // Show first 3 + last 4, mask the rest. For short handles (<= 7 chars),
    // the hidden section becomes zero-width — must clamp to avoid
    // `'•'.repeat(-1)` which throws RangeError.
    if (handle.length <= 4) return handle;
    const hidden = Math.max(0, handle.length - 7);
    return handle.slice(0, 3) + '•'.repeat(hidden) + handle.slice(-4);
  }
  if (channel === 'telegram') return '(telegram chat)';
  return handle;
}
