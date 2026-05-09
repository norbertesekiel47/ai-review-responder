import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/TopBar';
import { SettingsClient } from './SettingsClient';

export default async function SettingsPage() {
  // Auth + subscription guard — redirects on failure.
  await requireOwnerAccess();

  const multiLocationEnabled = process.env.MULTI_LOCATION_ENABLED === 'true';

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
