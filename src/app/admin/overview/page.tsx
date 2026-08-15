import Link from 'next/link';
import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getAdminOverview } from '@/lib/admin/overview-service';
import { getAdminNavCounts } from '@/lib/admin/nav-counts-service';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { OverviewClient } from './OverviewClient';

export const dynamic = 'force-dynamic';

export default async function AdminOverviewPage() {
  await requireAdminPage(sql, { from: '/admin/overview' });

  // SEQUENTIAL — do NOT re-introduce a Promise.all here (#505). Both callees
  // share the SAME `sql` client (pool = DB_POOL_MAX = 3 on Vercel), and
  // getAdminNavCounts is itself a 2-query fan-out. Running them concurrently
  // puts 3 queries in flight against a 3-connection pool with zero headroom —
  // any future growth in either callee silently crosses the pipelining
  // threshold and reintroduces the permanent Connection wedge.
  const overview = await getAdminOverview(sql);
  const navCounts = await getAdminNavCounts(sql);

  return (
    <AdminPage
      group="Operate"
      title="Overview"
      description="System health and every business at a glance"
      actions={
        <>
          <Link
            href="/admin/demos"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Demos
          </Link>
          <Link
            href="/admin/businesses"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            All Businesses
          </Link>
          <Link
            href="/admin/businesses/new"
            className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
          >
            + Add Business
          </Link>
        </>
      }
    >
      <OverviewClient initialData={overview} flaggedOpen={navCounts.flaggedOpen} />
    </AdminPage>
  );
}
