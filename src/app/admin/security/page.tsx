import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { AdminSecurityClient } from './AdminSecurityClient';

export const dynamic = 'force-dynamic';

export default async function AdminSecurityPage() {
  // No `aal2` here, unlike every other Safety-group page: this page IS the MFA
  // enrollment surface, so requiring AAL2 to reach it would lock out an admin
  // who hasn't enrolled yet. Posture consistency only — the page renders no
  // tenant data and src/proxy.ts already gates all of /admin.
  await requireAdminPage(sql, { from: '/admin/security' });

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
