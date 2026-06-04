import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { getActiveLocationCount } from '@/lib/locations/repo';
import {
  shouldShowLocationsSettings,
  shouldUseMultiLocationSettings,
} from '@/lib/locations/multi-location-mode';
import { SecurityClient } from './SecurityClient';

export default async function SettingsSecurityPage() {
  const access = await requireOwnerAccess();
  const activeLocationCount = await getActiveLocationCount(access.accountId);
  const featureEnabled = process.env.MULTI_LOCATION_ENABLED === 'true';
  const multiLocationEnabled = shouldUseMultiLocationSettings(
    featureEnabled,
    activeLocationCount,
  );
  const locationsSettingsEnabled = shouldShowLocationsSettings(featureEnabled);

  return (
    <>
      <TopBar
        title="Security"
        subtitle="Manage sign-in verification for this account."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <SettingsShell
        activeTab="security"
        locationsSettingsEnabled={locationsSettingsEnabled}
        multiLocationEnabled={multiLocationEnabled}
      >
        <SecurityClient />
      </SettingsShell>
    </>
  );
}
