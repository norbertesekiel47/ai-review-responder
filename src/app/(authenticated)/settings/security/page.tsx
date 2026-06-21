import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { SecurityClient } from './SecurityClient';

export default async function SettingsSecurityPage() {
  await requireOwnerAccess();
  return (
    <>
      <TopBar
        title="Security"
        subtitle="Manage sign-in verification for this account."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <SettingsShell>
        <SecurityClient />
      </SettingsShell>
    </>
  );
}
