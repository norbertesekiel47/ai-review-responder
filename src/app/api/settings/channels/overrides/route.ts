// src/app/api/settings/channels/overrides/route.ts
//
// GET endpoint for fetching all per-location channel overrides for the
// current account. Used by ChannelsTabClient to refresh after add/remove
// operations.
//
// VAL-SETTINGS-013: Per-location override panel collapsed by default.
// VAL-SETTINGS-015: Per-location override displays location name label.

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { jsonResponse, requireOwnerWithAccount } from '@/lib/auth/route-helpers';
import { getLocationsForAccount } from '@/lib/locations/repo';
import { getDisplayLabel, type HasDisplayLabel } from '@/lib/locations/display-label';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;
  const user = owner.user;

  const [overrides, locations] = await Promise.all([
    // Fetch per-location overrides (location_id IS NOT NULL)
    sql<{
      id: string;
      channel: string;
      handle: string | null;
      status: string;
      verified_at: Date | null;
      location_id: string;
    }[]>`
      SELECT e.id, e.channel, e.handle, e.status, e.verified_at, e.location_id
      FROM channel_enrollments e
      WHERE e.account_id = ${user.accountId}::uuid
        AND e.location_id IS NOT NULL
        AND e.archived_at IS NULL
        AND e.channel IN ('email', 'telegram', 'whatsapp') -- keep in sync with NOTIFICATION_DISPATCH_CHANNEL_ORDER (worker/jobs/notification/plan.ts)
      ORDER BY e.location_id, e.channel
    `,
    // Fetch location names for display
    getLocationsForAccount(owner.accountId),
  ]);
  const locationMap = new Map(
    locations.map((loc) => [loc.id, { name: loc.name, display_label: loc.display_label }]),
  );

  const result = overrides.map((o) => {
    const locInfo = locationMap.get(o.location_id);
    const locName = locInfo ? getDisplayLabel(locInfo as HasDisplayLabel) : o.location_id;

    return {
      enrollmentId: o.id,
      locationId: o.location_id,
      locationName: locName,
      channel: o.channel,
      handle: o.handle,
      status: o.status,
      verified_at: o.verified_at?.toISOString() ?? null,
    };
  });

  return jsonResponse({ overrides: result });
}
