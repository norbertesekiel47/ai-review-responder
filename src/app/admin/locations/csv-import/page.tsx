import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { CsvImportClient } from './CsvImportClient';

export const dynamic = 'force-dynamic';

// Static asset download (served from /public), not an in-app route — a plain
// <a> so it is a document request, not a <Link> prefetch.
const CSV_TEMPLATE_HREF = '/csv-templates/locations.csv';

export default async function CsvImportPage() {
  // Defense-in-depth behind src/proxy.ts's /admin gate. No read data — this page
  // is an upload form, so "server-first" means the chrome renders in the RSC
  // payload.
  await requireAdminPage(sql, { from: '/admin/locations/csv-import' });

  return (
    <AdminPage
      group="Businesses"
      title="Locations import"
      description="Bulk-add locations to an existing account from a CSV"
      actions={
        <a
          href={CSV_TEMPLATE_HREF}
          className="inline-flex rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Download template
        </a>
      }
    >
      <CsvImportClient />
    </AdminPage>
  );
}
