import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { NewBusinessClient } from './NewBusinessClient';

export const dynamic = 'force-dynamic';

export default async function AdminNewBusinessPage() {
  // Defense-in-depth behind src/proxy.ts's /admin gate. No read data — this page
  // is a form, so "server-first" means the chrome renders in the RSC payload.
  await requireAdminPage(sql, { from: '/admin/businesses/new' });

  return (
    <AdminPage
      group="Businesses"
      title="Onboard new business"
      description="Create a location, its owner, and the initial sync"
    >
      <NewBusinessClient />
    </AdminPage>
  );
}
