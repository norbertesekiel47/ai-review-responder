'use client';

import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { LocationsPanel, type LocationEntry, type ArchivedLocationEntry } from '@/components/dashboard/settings/LocationsPanel';

interface Props {
  locations: LocationEntry[];
  archivedLocations: ArchivedLocationEntry[];
  activeCount: number;
  accountId: string;
}

export function LocationsClient({ locations, archivedLocations, activeCount, accountId }: Props) {
  const handleLocationChange = () => {
    // Reload the page to get fresh server data and update the switcher context via the layout
    window.location.reload();
  };

  return (
    <SettingsShell activeTab="locations" multiLocationEnabled>
      <LocationsPanel
        locations={locations}
        archivedLocations={archivedLocations}
        activeCount={activeCount}
        accountId={accountId}
        onLocationChange={handleLocationChange}
      />
    </SettingsShell>
  );
}
