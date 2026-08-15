import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { NewBusinessClient } from './NewBusinessClient';

export const dynamic = 'force-dynamic';

export default async function AdminNewBusinessPage() {
  // Defense-in-depth behind src/proxy.ts's /admin gate. No read data — this page
  // is a form, so "server-first" means the chrome renders in the RSC payload.
  // aal2: the POST this form submits to (api/admin/businesses) is gated by
  // requireAdminWithAal2, so step up BEFORE the admin fills the form —
  // otherwise the only feedback is a bare `mfa_required` banner on submit.
  await requireAdminPage(sql, { from: '/admin/businesses/new', aal2: true });

  return (
    <AdminPage
      group="Businesses"
      title="Onboard new business"
      description="Invite an owner — they set their password, capture their location, pick a plan, and finish setup themselves"
    >
      <NewBusinessClient />
    </AdminPage>
  );
}
