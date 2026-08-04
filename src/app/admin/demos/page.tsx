import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getAdminDemos } from '@/lib/admin/demos-service';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { DemosClient } from './DemosClient';

export const dynamic = 'force-dynamic';

export default async function AdminDemosPage() {
  // Gate parity with GET /api/admin/demos, which uses requireRoleOr401(admin).
  await requireAdminPage(sql, { from: '/admin/demos' });

  const demos = await getAdminDemos(sql);

  return (
    <AdminPage
      group="Growth"
      title="Demos"
      description="Generate and share prospect demo pages"
    >
      <DemosClient initialData={demos} />
    </AdminPage>
  );
}
