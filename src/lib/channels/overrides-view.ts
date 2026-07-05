// src/lib/channels/overrides-view.ts
//
// One owner for everything the per-location override surfaces render. The SSR
// channels page and GET /api/settings/channels/overrides both call
// getChannelOverridesView, so the DTO shape, the row→DTO mapping (label ??
// raw-UUID fallback, archived flag, ISO timestamps) and the "which org
// channels can spawn overrides" rule (live verified org-default) exist
// exactly once.
//
// VAL-SETTINGS-015: Per-location override displays location name label.

import type { Sql } from 'postgres';
import { CHANNEL_IDS, type ChannelId } from '@/lib/notifications/channels/types';
import { getAllLocationsForAccount } from '@/lib/locations/repo';
import { getDisplayLabel } from '@/lib/locations/display-label';

export interface PerLocationOverride {
  enrollmentId: string;
  locationId: string;
  /** Plain display label — any "(archived)" suffix is derived from `archived` at render time. */
  locationName: string;
  archived: boolean;
  channel: ChannelId;
  handle: string | null;
  status: string;
  verified_at: string | null;
}

export interface OverrideViewLocation {
  id: string;
  /** Canonical display_label ?? name resolution. */
  displayName: string;
  isPrimary: boolean;
  archived: boolean;
}

export interface ChannelOverridesView {
  overrides: PerLocationOverride[];
  /** Every location for the account — active AND archived — in primary-first order. */
  locations: OverrideViewLocation[];
  /** Org-default channels with a live verified enrollment, in CHANNEL_IDS order. */
  verifiedOrgChannels: ChannelId[];
}

/**
 * Returns the complete override view for an account: per-location override
 * DTOs with resolved labels, the full location list (one businesses query —
 * active and archived together), and the set of verified org-default channels
 * that are eligible to spawn new overrides.
 */
export async function getChannelOverridesView(
  sql: Sql,
  accountId: string,
): Promise<ChannelOverridesView> {
  const [enrollments, locationRows] = await Promise.all([
    sql<{
      id: string;
      channel: ChannelId;
      handle: string | null;
      status: string;
      verified_at: Date | null;
      location_id: string | null;
    }[]>`
      SELECT e.id, e.channel, e.handle, e.status, e.verified_at, e.location_id
      FROM channel_enrollments e
      WHERE e.account_id = ${accountId}::uuid
        AND e.archived_at IS NULL
        AND e.channel = ANY(${[...CHANNEL_IDS] as string[]}::text[])
      ORDER BY e.location_id NULLS FIRST, e.channel
    `,
    getAllLocationsForAccount(accountId),
  ]);

  const locations: OverrideViewLocation[] = locationRows.map((location) => ({
    id: location.id,
    displayName: getDisplayLabel(location),
    isPrimary: location.is_primary,
    archived: location.archived_at !== null,
  }));
  const locationById = new Map(locations.map((location) => [location.id, location]));

  const overrides: PerLocationOverride[] = [];
  const verifiedOrg = new Set<ChannelId>();

  for (const enrollment of enrollments) {
    if (enrollment.location_id === null) {
      if (enrollment.status === 'verified') verifiedOrg.add(enrollment.channel);
      continue;
    }

    const location = locationById.get(enrollment.location_id);
    overrides.push({
      enrollmentId: enrollment.id,
      locationId: enrollment.location_id,
      // Fall back to the raw UUID only for a truly-unknown id (shouldn't happen in practice).
      locationName: location?.displayName ?? enrollment.location_id,
      archived: location?.archived ?? false,
      channel: enrollment.channel,
      handle: enrollment.handle,
      status: enrollment.status,
      verified_at: enrollment.verified_at?.toISOString() ?? null,
    });
  }

  return {
    overrides,
    locations,
    verifiedOrgChannels: CHANNEL_IDS.filter((channel) => verifiedOrg.has(channel)),
  };
}
