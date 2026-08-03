import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getAdminJobsData } from '@/lib/admin/jobs-service';
import { fetchQueueHealth } from '@/lib/admin/queue-health';
import { JobsClient } from './JobsClient';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

export default async function AdminJobsPage() {
  await requireAdminPage(sql, { from: '/admin/jobs' });

  const [jobs, health] = await Promise.all([
    getAdminJobsData(sql, { limit: PAGE_SIZE, offset: 0 }),
    fetchQueueHealth(),
  ]);

  return (
    <JobsClient
      initialData={{
        ...jobs,
        limit: PAGE_SIZE,
        offset: 0,
        ...health,
      }}
    />
  );
}
