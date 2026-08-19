import { AdminPage } from '@/components/admin/ui/AdminPage';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { sql } from '@/lib/db/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { readSendBreaker } from '@/lib/solicitation/send-breaker';
import { SendBreakerClient } from './SendBreakerClient';

export const dynamic = 'force-dynamic';

/**
 * The client's wire shape mirrors what `fetch().json()` returns — Date fields
 * arrive as ISO strings. Mirror that conversion here so the server-fetched
 * initialData is structurally identical to a client refetch.
 */
async function readBreakerWire() {
  const state = await readSendBreaker(sql);
  return {
    open: state.open,
    trip: state.trip && { ...state.trip, trippedAt: state.trip.trippedAt.toISOString() },
  };
}

export default async function AdminSolicitationPage() {
  // AAL2 unconditional, matching the reset route's requireAdminWithAal2: this
  // page server-renders the breaker state directly from `sql`, so its own gate
  // — not the route's — is what protects that read.
  await requireAdminPage(sql, { from: '/admin/solicitation', aal2: true });

  // `readSendBreaker` fails CLOSED — it throws rather than reporting an unknown
  // verdict — and that throw is the SEND path's halt signal. This is a READ
  // surface, so it is handled the way the sibling GET route handles it
  // (`breaker/route.ts` → internalError), and for the same reason the
  // /admin/costs page catches its margin read: a failing breaker read is
  // precisely the halt scenario, and an admin who opens this page to
  // investigate must land on the panel, not on Next's error boundary.
  //
  // Dropping `initialData` hands the fetch to the client, which renders its own
  // error state with a retry over the GET route — a transient failure recovers
  // without a full page reload, and a persistent one is legible.
  let initialData: Awaited<ReturnType<typeof readBreakerWire>> | undefined;
  try {
    initialData = await readBreakerWire();
  } catch (error) {
    reportCaughtError('admin/solicitation/page', error);
  }

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
