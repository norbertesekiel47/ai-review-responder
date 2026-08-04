import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getAdminDemos } from '@/lib/admin/demos-service';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { DemosClient } from './DemosClient';

export const dynamic = 'force-dynamic';

export default async function AdminDemosPage() {
  // Defense-in-depth behind src/proxy.ts's /admin gate.
  // The read this page renders (GET /api/admin/demos) is only requireRoleOr401,
  // but the page also hosts GenerateForm, which POSTs to
  // /api/admin/demos/generate — gated by requireAdminWithAal2
  // (src/app/api/admin/demos/generate/route.ts:89, auth-before-spend). Step up
  // BEFORE the form renders, the same call new-business / csv-import /
  // impersonate already make; otherwise the only feedback is a bare
  // `mfa_required` banner after the admin has filled the form in.
  await requireAdminPage(sql, { from: '/admin/demos', aal2: true });

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
