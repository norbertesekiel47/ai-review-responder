import { AdminPage } from '@/components/admin/ui/AdminPage';
import { AdminSecurityClient } from './AdminSecurityClient';

export const dynamic = 'force-dynamic';

export default function AdminSecurityPage() {
  return (
    <AdminPage
      group="Safety"
      title="Security"
      description="Your admin account's MFA enrollment"
    >
      <AdminSecurityClient />
    </AdminPage>
  );
}
