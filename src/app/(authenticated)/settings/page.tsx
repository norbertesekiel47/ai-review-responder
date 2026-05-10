import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/TopBar';
import { SettingsClient } from './SettingsClient';
import { getActiveLocationCount } from '@/lib/locations/repo';
import { shouldUseMultiLocationSettings } from '@/lib/locations/multi-location-mode';

export default async function SettingsPage() {
  // Auth + subscription guard — redirects on failure.
  const access = await requireOwnerAccess();

  const activeLocationCount = await getActiveLocationCount(access.accountId);
  const multiLocationEnabled = shouldUseMultiLocationSettings(
    process.env.MULTI_LOCATION_ENABLED === 'true',
    activeLocationCount,
  );

  return (
    <>
      <TopBar
        title="Settings"
        subtitle={multiLocationEnabled ? 'Account, locations, voice, and notification preferences.' : 'Tune your voice, channels, and account preferences.'}
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <SettingsClient multiLocationEnabled={multiLocationEnabled} />
    </>
  );
}
