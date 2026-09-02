import type { ReactNode } from 'react';
import { SettingsSidebar } from '@/components/dashboard/settings/SettingsSidebar';
import { multiLocationEnabled } from '@/lib/locations/flags';
import { shouldShowLocationsSettings } from '@/lib/locations/multi-location-mode';
import '@/app/(authenticated)/_styles/settings.css';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  // Visibility of the Locations tab is resolved here, on the server, with the
  // VISIBILITY check (invariant #9b — not the mode or eligibility checks) and
  // handed to the client sidebar as a boolean (invariant #13). The tab's page
  // runs the same check and 404s, so hiding it here keeps the nav honest.
  const showLocations = shouldShowLocationsSettings(multiLocationEnabled());

  return (
    <div className="settings-shell-2col">
      <SettingsSidebar showLocations={showLocations} />
      <div className="settings-detail">{children}</div>
    </div>
  );
}
