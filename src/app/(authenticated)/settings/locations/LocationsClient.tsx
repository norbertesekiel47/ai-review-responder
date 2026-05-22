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

export function LocationsClient({
  locations,
  archivedLocations,
  activeCount,
  accountId,
  addLocationState,
  multiLocationEnabled,
  voiceHref,
}: Props) {
  const handleLocationChange = () => {
    // Reload the page to get fresh server data and update the switcher context via the layout
    window.location.reload();
  };

  return (
    <SettingsShell
      activeTab="locations"
      multiLocationEnabled={multiLocationEnabled}
      locationsSettingsEnabled
    >
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
