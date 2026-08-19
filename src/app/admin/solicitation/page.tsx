import { AdminPage } from '@/components/admin/ui/AdminPage';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { sql } from '@/lib/db/server';
import { readSendBreaker } from '@/lib/solicitation/send-breaker';
import { SendBreakerClient } from './SendBreakerClient';

export const dynamic = 'force-dynamic';

export default async function AdminSolicitationPage() {
  // AAL2 unconditional, matching the reset route's requireAdminWithAal2: this
  // page server-renders the breaker state directly from `sql`, so its own gate
  // — not the route's — is what protects that read.
  await requireAdminPage(sql, { from: '/admin/solicitation', aal2: true });

  const state = await readSendBreaker(sql);
  // The client's wire shape mirrors what `fetch().json()` returns — Date fields
  // arrive as ISO strings. Mirror that conversion here so the server-fetched
  // initialData is structurally identical to a client refetch.
  const initialData = {
    open: state.open,
    trip: state.trip && { ...state.trip, trippedAt: state.trip.trippedAt.toISOString() },
  };

  return (
    <AdminPage
      group="Safety"
      title="Solicitation send breaker"
      description="Platform-wide halt on solicitation sending"
    >
      <SendBreakerClient initialData={initialData} />
    </AdminPage>
  );
}
