import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getAdminJobsData } from '@/lib/admin/jobs-service';
import { fetchQueueHealth } from '@/lib/admin/queue-health';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { JobsClient, PAGE_SIZE } from './JobsClient';

export const dynamic = 'force-dynamic';

export default async function AdminJobsPage() {
  await requireAdminPage(sql, { from: '/admin/jobs' });

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
