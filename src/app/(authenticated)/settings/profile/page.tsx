import { requireOwnerAccess } from '@/lib/auth/require-owner-access';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { ProfileClient } from './ProfileClient';

export default async function ProfilePage() {
  await requireOwnerAccess();
  return (
    <>
      <TopBar
        title="Profile"
        subtitle="Your business identity and account."
        rightLink={{ href: '/dashboard', label: 'Back to dashboard' }}
      />
      <ProfileClient />
    </>
  );
}
