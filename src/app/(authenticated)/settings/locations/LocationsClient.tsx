'use client';

import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import {
  LocationsPanel,
  type AddLocationState,
  type LocationEntry,
  type ArchivedLocationEntry,
} from '@/components/dashboard/settings/LocationsPanel';

interface Props {
  locations: LocationEntry[];
  archivedLocations: ArchivedLocationEntry[];
  activeCount: number;
  accountId: string;
  addLocationState: AddLocationState;
  multiLocationEnabled: boolean;
  voiceHref: string;
}

const handleLocationChange = () => {
  // Reload the page to get fresh server data and update the switcher context via the layout
  window.location.reload();
};

export function LocationsClient({
  locations,
  archivedLocations,
  activeCount,
  accountId,
  addLocationState,
  voiceHref,
}: Props) {
  return (
    <SettingsShell>
      <LocationsPanel
        locations={locations}
        archivedLocations={archivedLocations}
        activeCount={activeCount}
        accountId={accountId}
        addLocationState={addLocationState}
        voiceHref={voiceHref}
        onLocationChange={handleLocationChange}
      />
    </SettingsShell>
  );
}
