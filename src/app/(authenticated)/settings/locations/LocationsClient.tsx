'use client';

import { useCallback, useState } from 'react';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { LocationsPanel, type LocationEntry } from '@/components/dashboard/settings/LocationsPanel';
import { useLocationScope } from '@/contexts/LocationContext';

interface Props {
  locations: LocationEntry[];
  activeCount: number;
  accountId: string;
}

export function LocationsClient({ locations, activeCount, accountId }: Props) {
  const [locList, setLocList] = useState(locations);
  const [count, setCount] = useState(activeCount);
  const { setLocations } = useLocationScope();

  const handleLocationChange = useCallback(async () => {
    // Refetch locations from the API
    try {
      const res = await fetch('/api/account/settings');
      if (res.ok) {
        const data = await res.json();
        // We need the actual location list, not just the account settings.
        // Let's refresh the page data from the server instead.
      }
    } catch {
      // ignore
    }
    // Simple approach: reload the page to get fresh data
    // This also updates the switcher context via the layout
    window.location.reload();
  }, []);

  return (
    <SettingsShell activeTab="locations" multiLocationEnabled>
      <LocationsPanel
        locations={locList}
        activeCount={count}
        accountId={accountId}
        onLocationChange={handleLocationChange}
      />
    </SettingsShell>
  );
}
