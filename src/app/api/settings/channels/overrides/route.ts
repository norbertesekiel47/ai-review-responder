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
import { getLocationsForAccount, getArchivedLocationsForAccount } from '@/lib/locations/repo';
import { getDisplayLabel, type HasDisplayLabel } from '@/lib/locations/display-label';
import { CHANNEL_IDS } from '@/lib/notifications/channels/types';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const owner = await requireOwnerWithAccount(request);
  if (!owner.ok) return owner.response;
  const user = owner.user;

  const [overrides, activeLocations, archivedLocations] = await Promise.all([
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
        AND e.channel = ANY(${[...CHANNEL_IDS] as string[]}::text[])
      ORDER BY e.location_id, e.channel
    `,
    // Fetch active location names for display
    getLocationsForAccount(owner.accountId),
    // Fetch archived location names so overrides on archived locations resolve correctly
    getArchivedLocationsForAccount(owner.accountId),
  ]);

  const locationMap = new Map<string, string>();
  for (const loc of activeLocations) {
    locationMap.set(loc.id, getDisplayLabel(loc as HasDisplayLabel));
  }
  for (const loc of archivedLocations) {
    locationMap.set(loc.id, `${getDisplayLabel(loc as HasDisplayLabel)} (archived)`);
  }

  const result = overrides.map((o) => {
    // Fall back to raw UUID only for a truly-unknown id (shouldn't happen in practice)
    const locName = locationMap.get(o.location_id) ?? o.location_id;

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
