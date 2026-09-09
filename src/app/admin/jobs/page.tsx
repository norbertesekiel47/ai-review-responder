import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getAdminJobsData } from '@/lib/admin/jobs-service';
import { fetchQueueHealth } from '@/lib/admin/queue-health';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { JobsClient } from './JobsClient';
// Server-safe: PAGE_SIZE must NOT be imported from the client component
// module — the bundler would hand the server a stub. See page-sizes.ts.
import { JOBS_PAGE_SIZE as PAGE_SIZE } from '../page-sizes';

export const dynamic = 'force-dynamic';

export default async function AdminJobsPage() {
  // Gate parity with GET /api/admin/jobs, which uses requireAdminWithAal2
  // since #1184 — the outbox and queue rows name every tenant's in-flight work
  // and this page reads them directly via `sql`, not through that route.
  await requireAdminPage(sql, { from: '/admin/jobs', aal2: true });

  const [jobs, health] = await Promise.all([
    getAdminJobsData(sql, { limit: PAGE_SIZE, offset: 0 }),
    fetchQueueHealth(),
  ]);

  return (
    <AdminPage group="Operate" title="Jobs" description="Outbox, queue depth, and failed jobs">
      <JobsClient
        initialData={{
          ...jobs,
          limit: PAGE_SIZE,
          offset: 0,
          ...health,
        }}
      />
    </AdminPage>
  );
}
