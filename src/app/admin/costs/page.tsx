import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getCostReport, type CostQuery } from '@/lib/admin/cost-report-service';
import { getMarginReport } from '@/lib/admin/margin-service';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { CostsClient } from './CostsClient';
// Server-safe: PAGE_SIZE must NOT be imported from the client component
// module — the bundler would hand the server a stub. See page-sizes.ts.
import { COSTS_PAGE_SIZE as PAGE_SIZE } from '../page-sizes';

export const dynamic = 'force-dynamic';

// Must match CostsClient's default state (days=30, page=0) — the client only
// trusts server-rendered initialData for that exact combination, so this
// query and the client default are one fact kept in two places deliberately
// (page fetch vs. client refetch), not a duplication to collapse.
const INITIAL_QUERY: CostQuery = { days: 30, limit: PAGE_SIZE, offset: 0, accountId: '' };

export default async function AdminCostsPage() {
  await requireAdminPage(sql, { from: '/admin/costs' });

  // SEQUENTIAL — do NOT re-introduce a Promise.all here (#505). Both callees
  // share the SAME `sql` client (pool = DB_POOL_MAX = 3 on Vercel) and
  // getMarginReport is itself a 3-query fan-out, so running them together put 4
  // queries in flight against a 3-connection pool — over the Supavisor
  // TRANSACTION pooler the excess query pipelines onto an already-open
  // connection and parks in state=active / wait_event=ClientRead forever.
  // Mirrors the same fix in src/app/api/admin/costs/route.ts.
  const report = await getCostReport(sql, INITIAL_QUERY);
  const margin = await getMarginReport(sql, { limit: 20 }).catch((err) => {
    reportCaughtError('admin/costs/page', err);
    return null;
  });

  return (
    <AdminPage group="Operate" title="Costs" description="LLM + API spend and margin by account">
      <CostsClient initialData={{ ...report, margin }} />
    </AdminPage>
  );
}
