import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { listSuspendedPolicies } from '@/lib/auto-approval/suspension';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { AutonomySuspensionsClient } from './AutonomySuspensionsClient';

export const dynamic = 'force-dynamic';

export default async function AdminAutonomyPage() {
  // Suspension evidence exposes governor rates + flag verdicts across every
  // tenant — same sensitivity class as the flagged queue, so this page gate
  // must match the suspensions route's requireAdminWithAal2 (admin + AAL2,
  // unconditional).
  await requireAdminPage(sql, { from: '/admin/autonomy', aal2: true });

  const suspensions = await listSuspendedPolicies(sql);
  // The client's SuspensionItem shape mirrors what `fetch().json()` returns —
  // Date fields arrive as ISO strings over the wire. Mirror that conversion
  // here so the server-fetched initialData is structurally identical to a
  // client refetch.
  const initialData = {
    suspensions: suspensions.map((item) => ({
      ...item,
      suspendedAt: item.suspendedAt.toISOString(),
      recentFlagVerdicts: item.recentFlagVerdicts.map((verdict) => ({
        ...verdict,
        createdAt: verdict.createdAt.toISOString(),
      })),
    })),
  };

  return (
    <AdminPage
      group="Safety"
      title="Autonomy suspensions"
      description="Accounts the Governor has pulled out of Autopilot"
    >
      <AutonomySuspensionsClient initialData={initialData} />
    </AdminPage>
  );
}
