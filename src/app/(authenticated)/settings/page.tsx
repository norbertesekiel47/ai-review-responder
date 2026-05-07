import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/TopBar';
import { SettingsClient } from './SettingsClient';

export default async function SettingsPage() {
  await requireOwnerAccess();

  return (
    <>
      <TopBar
        title="Settings"
        subtitle="Tune your voice, channels, and account preferences."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <SettingsClient />
    </>
  );
}
