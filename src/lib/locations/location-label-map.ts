// src/lib/locations/location-label-map.ts
//
// Shared label resolution for surfaces that render per-location rows which
// may point at archived locations (channel overrides SSR page + GET
// /api/settings/channels/overrides). One businesses query covers active AND
// archived locations; consumers derive any "(archived)" presentation from the
// `archived` flag at render time — labels are never suffixed server-side.

import { getAllLocationsForAccount } from './repo';
import { getDisplayLabel } from './display-label';

export interface LocationLabelEntry {
  label: string;
  archived: boolean;
}

/**
 * Returns a map of location id → { label, archived } for every location
 * (active or archived) belonging to the account. Label is the canonical
 * display_label ?? name resolution.
 */
export async function getLocationLabelMap(
  accountId: string,
): Promise<Map<string, LocationLabelEntry>> {
  const locations = await getAllLocationsForAccount(accountId);

  const labelMap = new Map<string, LocationLabelEntry>();
  for (const location of locations) {
    labelMap.set(location.id, {
      label: getDisplayLabel(location),
      archived: location.archived_at !== null,
    });
  }
  return labelMap;
}
