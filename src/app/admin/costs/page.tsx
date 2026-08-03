import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getCostReport, type CostQuery } from '@/lib/admin/cost-report-service';
import { getMarginReport } from '@/lib/admin/margin-service';
import { CostsClient } from './CostsClient';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

// Must match CostsClient's default state (days=30, page=0) — the client only
// trusts server-rendered initialData for that exact combination, so this
// query and the client default are one fact kept in two places deliberately
// (page fetch vs. client refetch), not a duplication to collapse.
const INITIAL_QUERY: CostQuery = { days: 30, limit: PAGE_SIZE, offset: 0, accountId: '' };

export default async function AdminCostsPage() {
  await requireAdminPage(sql, { from: '/admin/costs' });

  const [report, margin] = await Promise.all([
    getCostReport(sql, INITIAL_QUERY),
    getMarginReport(sql, { limit: 20 }).catch(() => null),
  ]);

  return <CostsClient initialData={{ ...report, margin }} />;
}
