import { AdminPage } from '@/components/admin/ui/AdminPage';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { sql } from '@/lib/db/server';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import {
  BREAKER_COMPLAINT_RATE,
  BREAKER_HARD_BOUNCE_RATE,
  BREAKER_MIN_SENDS,
  BREAKER_WINDOW_DAYS,
  readSendBreaker,
} from '@/lib/solicitation/send-breaker';
import { SendBreakerClient } from './SendBreakerClient';
import type { BreakerThresholds } from './SendBreakerClient';

export const dynamic = 'force-dynamic';

/**
 * The four enforcement thresholds, read HERE and passed down.
 *
 * This is a server component, so it may import `send-breaker.ts` freely — that
 * module instantiates a worker logger at module scope and therefore drags
 * `node:async_hooks` into whatever chunk imports it at runtime. The client
 * panel used to import these constants directly, which put that chain in a
 * client chunk and failed the route build outright. The numbers still have
 * exactly one owner; only the direction of travel changed, and server ->
 * client via props is the direction that was always correct.
 */
const BREAKER_THRESHOLDS: BreakerThresholds = {
  windowDays: BREAKER_WINDOW_DAYS,
  minSends: BREAKER_MIN_SENDS,
  hardBounceRate: BREAKER_HARD_BOUNCE_RATE,
  complaintRate: BREAKER_COMPLAINT_RATE,
};

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
  // costs API catches its margin read: a failing breaker read is
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
      <SendBreakerClient initialData={initialData} thresholds={BREAKER_THRESHOLDS} />
    </AdminPage>
  );
}
