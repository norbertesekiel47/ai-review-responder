import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { ImpersonationStartClient } from './ImpersonationStartClient';

export const dynamic = 'force-dynamic';

export default async function AdminImpersonatePage() {
  // Defense-in-depth behind src/proxy.ts's /admin gate. No read data — this page
  // is a form, so "server-first" means the chrome renders in the RSC payload.
  // aal2: /api/admin/impersonation/start is gated by requireAdminWithAal2 —
  // step up before the form renders, not after it is filled in and submitted.
  await requireAdminPage(sql, { from: '/admin/impersonate', aal2: true });

  return (
    <AdminPage
      group="Growth"
      title="Support"
      description="Start a scoped, read-only support session tied to a ticket and audit log"
    >
      <ImpersonationStartClient />
    </AdminPage>
  );
}
