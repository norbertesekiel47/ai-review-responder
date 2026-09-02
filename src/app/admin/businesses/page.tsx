import Link from 'next/link';
import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getBusinessSummaries, parseBusinessListFilters } from '@/lib/admin/business-summary';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { BusinessesClient } from './BusinessesClient';
// Server-safe: PAGE_SIZE must NOT be imported from the client component
// module — the bundler would hand the server a stub. See page-sizes.ts.
import { BUSINESSES_PAGE_SIZE as PAGE_SIZE } from '../page-sizes';

export const dynamic = 'force-dynamic';

export default async function AdminBusinessesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage(sql, { from: '/admin/businesses' });

  // The first page honours the same `q` / `status` / `health` params the API
  // does (single owner: parseBusinessListFilters), so a deep link such as
  // `/admin/businesses?q=Northstar` from another admin page renders the
  // filtered list in the RSC payload — not the full list followed by a client
  // refetch.
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const key of ['q', 'status', 'health'] as const) {
    const value = raw[key];
    if (typeof value === 'string') params.set(key, value);
  }
  const filters = parseBusinessListFilters(params);

  const data = await getBusinessSummaries(sql, { limit: PAGE_SIZE, offset: 0, ...filters });

  return (
    <AdminPage
      group="Businesses"
      title="Businesses"
      description="Every location, its subscription state, and pending drafts"
      actions={
        <>
          <Link
            href="/admin/locations/csv-import"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Import CSV
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
      <BusinessesClient
        initialData={{ ...data, limit: PAGE_SIZE, offset: 0 }}
        initialFilters={filters}
      />
    </AdminPage>
  );
}
