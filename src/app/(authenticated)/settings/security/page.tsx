import { sql } from '@/lib/db/server';
import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { SettingsShell } from '@/components/dashboard/settings/SettingsShell';
import { SecurityClient } from './SecurityClient';

export default async function SettingsSecurityPage() {
  await requireOwnerAccess(sql);
  return (
    <>
      <TopBar
        title="Security"
        subtitle="Two-step sign-in and your password."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <SettingsShell>
        <SecurityClient />
      </SettingsShell>
    </>
  );
}
