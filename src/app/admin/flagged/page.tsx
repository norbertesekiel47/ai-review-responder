import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { listOpenFlaggedResponses } from '@/lib/admin/flagged-service';
import { FlaggedClient, PAGE_SIZE } from './FlaggedClient';

export const dynamic = 'force-dynamic';

export default async function AdminFlaggedPage() {
  // Flagged draft text + reviewer/business identity is the same sensitivity
  // as the POST disposition — this page gate must match the route's
  // requireAdminWithAal2 (admin + AAL2, unconditional).
  await requireAdminPage(sql, { from: '/admin/flagged', aal2: true });

  const flagged = await listOpenFlaggedResponses(sql, { limit: PAGE_SIZE, offset: 0 });

  return <FlaggedClient initialData={{ ...flagged, limit: PAGE_SIZE, offset: 0 }} />;
}
