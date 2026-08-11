import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { listOpenFlaggedResponses } from '@/lib/admin/flagged-service';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { FlaggedClient } from './FlaggedClient';
// Server-safe: PAGE_SIZE must NOT be imported from the client component
// module — the bundler would hand the server a stub. See page-sizes.ts.
import { FLAGGED_PAGE_SIZE as PAGE_SIZE } from '../page-sizes';

export const dynamic = 'force-dynamic';

export default async function AdminFlaggedPage() {
  // Flagged draft text + reviewer/business identity is the same sensitivity
  // as the POST disposition — this page gate must match the route's
  // requireAdminWithAal2 (admin + AAL2, unconditional).
  await requireAdminPage(sql, { from: '/admin/flagged', aal2: true });

  const flagged = await listOpenFlaggedResponses(sql, { limit: PAGE_SIZE, offset: 0 });

  return (
    <AdminPage
      group="Safety"
      title="Flagged responses"
      description="Held drafts awaiting your disposition"
    >
      <FlaggedClient initialData={{ ...flagged, limit: PAGE_SIZE, offset: 0 }} />
    </AdminPage>
  );
}
