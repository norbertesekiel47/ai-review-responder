import Link from 'next/link';
import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getBusinessSummaries } from '@/lib/admin/business-summary';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { BusinessesClient } from './BusinessesClient';
// Server-safe: PAGE_SIZE must NOT be imported from the client component
// module — the bundler would hand the server a stub. See page-sizes.ts.
import { BUSINESSES_PAGE_SIZE as PAGE_SIZE } from '../page-sizes';

export const dynamic = 'force-dynamic';

export default async function AdminBusinessesPage() {
  await requireAdminPage(sql, { from: '/admin/businesses' });

  const data = await getBusinessSummaries(sql, { limit: PAGE_SIZE, offset: 0 });

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
      <BusinessesClient initialData={{ ...data, limit: PAGE_SIZE, offset: 0 }} />
    </AdminPage>
  );
}
