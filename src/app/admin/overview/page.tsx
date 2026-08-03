import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getAdminOverview } from '@/lib/admin/overview-service';
import { getAdminNavCounts } from '@/lib/admin/nav-counts-service';
import { OverviewClient, PAGE_SIZE } from './OverviewClient';

export const dynamic = 'force-dynamic';

export default async function AdminOverviewPage() {
  await requireAdminPage(sql, { from: '/admin/overview' });

  const [overview, navCounts] = await Promise.all([
    getAdminOverview(sql, { limit: PAGE_SIZE, offset: 0 }),
    getAdminNavCounts(sql),
  ]);

  return <OverviewClient initialData={overview} flaggedOpen={navCounts.flaggedOpen} />;
}
