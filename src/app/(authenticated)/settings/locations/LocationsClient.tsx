'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import {
  LocationsPanel,
  type AddLocationState,
  type LocationChange,
  type LocationEntry,
  type ArchivedLocationEntry,
} from '@/components/dashboard/settings/LocationsPanel';
import { useToast, type ToastInput } from '@/components/dashboard/shell/toast/ToastProvider';

interface Props {
  locations: LocationEntry[];
  archivedLocations: ArchivedLocationEntry[];
  activeCount: number;
  accountId: string;
  addLocationState: AddLocationState;
  voiceHref: string;
}

/** The confirmation each location action earns once the server has applied it. */
export function locationChangeToast(change: LocationChange): ToastInput {
  switch (change) {
    case 'archived':
      return {
        tone: 'success',
        title: 'Location archived',
        body: 'Reactivate it any time from the Archived list.',
      };
    case 'reactivated':
      return { tone: 'success', title: 'Location reactivated' };
    case 'promoted':
      return { tone: 'success', title: 'Primary location updated' };
    case 'renamed':
      return { tone: 'success', title: 'Display name saved' };
  }
}

export function LocationsClient({
  locations,
  archivedLocations,
  activeCount,
  accountId,
  addLocationState,
  voiceHref,
}: Props) {
  const router = useRouter();
  const { toast } = useToast();

  // `router.refresh()` re-renders the server tree in place — this page AND the
  // authenticated layout that feeds the location switcher — without the flash
  // and lost scroll of a full reload (UX audit S32). The toast is the success
  // feedback the reload never gave.
  const handleLocationChange = useCallback(
    (change: LocationChange) => {
      toast(locationChangeToast(change));
      router.refresh();
    },
    [router, toast],
  );

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
