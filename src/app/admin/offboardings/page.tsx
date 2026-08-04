import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getAdminOffboardings } from '@/lib/admin/offboardings-service';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { OffboardingsClient, PAGE_SIZE } from './OffboardingsClient';

export const dynamic = 'force-dynamic';

export default async function AdminOffboardingsPage() {
  // Gate parity with GET /api/admin/offboardings, which uses
  // requireAdminWithAal2 — a plain admin gate here would serve the same
  // cross-tenant lifecycle data to a session that has not stepped up.
  await requireAdminPage(sql, { from: '/admin/offboardings', aal2: true });

  const data = await getAdminOffboardings(sql, { limit: PAGE_SIZE, offset: 0 });

  return (
    <AdminPage
      group="Businesses"
      title="Offboardings"
      description="Active, failed, and stuck account offboarding lifecycles"
    >
      <OffboardingsClient initialData={{ ...data, limit: PAGE_SIZE, offset: 0 }} />
    </AdminPage>
  );
}
