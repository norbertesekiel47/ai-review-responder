import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { requireCurrentAal2FromSupabase, mfaChallengePath, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { sql } from '@/lib/db/server';
import { IMPERSONATION_COOKIE_NAME } from '@/lib/admin/impersonation/cookie';
import {
  loadImpersonationAccountLocations,
  resolveImpersonationViewSession,
} from '@/lib/admin/impersonation/view';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { EndImpersonationButton } from './EndImpersonationButton';
import {
  ImpersonationLocationsTable,
  type ImpersonationLocationRow,
} from './ImpersonationLocationsTable';

export const dynamic = 'force-dynamic';

const IMPERSONATION_EXPIRES_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function AdminImpersonationViewPage({ params }: PageProps) {
  const [{ sessionId }, cookieStore] = await Promise.all([params, cookies()]);
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Server components cannot mutate response cookies.
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  const aal = await requireCurrentAal2FromSupabase(supabase as unknown as SupabaseMfaAalClient);
  const resolution = await resolveImpersonationViewSession(sql, {
    routeSessionId: sessionId,
    signedCookieValue: cookieStore.get(IMPERSONATION_COOKIE_NAME)?.value ?? null,
    authUserId: user?.id ?? null,
    isAal2: aal.ok,
  });

  if (resolution.status === 'unauthenticated' || resolution.status === 'forbidden') {
    redirect('/admin/login');
  }
  if (resolution.status === 'mfa_required') {
    redirect(mfaChallengePath(`/admin/impersonate/${sessionId}/view`));
  }
  if (resolution.status === 'not_found') {
    notFound();
  }

  const { session, admin } = resolution;
  const locations = await loadImpersonationAccountLocations(sql, session.accountId);
  const expiresAt = IMPERSONATION_EXPIRES_FORMATTER.format(session.expiresAt);
  // Derived server-side so the client table receives plain strings only — no
  // `Date` crosses the RSC boundary (convention #2).
  const locationRows: ImpersonationLocationRow[] = locations.map((location) => ({
    id: location.id,
    name: location.name,
    displayLabel: location.displayLabel,
    state: location.archivedAt ? 'Archived' : location.isPrimary ? 'Primary' : 'Active',
  }));

  return (
    <AdminPage
      group="Growth"
      title={session.accountDisplayName ?? session.accountId}
      description="Read-only support context"
    >
      <div className="rounded-lg border border-gray-300 bg-gray-100 p-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-semibold text-gray-900">
              Admin view-as session
            </p>
            <p className="mt-1 text-sm text-gray-700">
              Read-only support context for {session.impersonatedEmail ?? 'owner user'}.
              Expires {expiresAt}. Actor: {admin.email}.
            </p>
          </div>
          <EndImpersonationButton />
        </div>
      </div>

      <div className="mt-6 grid gap-3 text-sm text-gray-700 sm:grid-cols-2">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="font-medium text-gray-500">Ticket</p>
          <p className="mt-1 font-mono text-gray-900">{session.ticketId}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="font-medium text-gray-500">Owner user</p>
          <p className="mt-1 font-mono text-gray-900">{session.impersonatedUserId}</p>
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-gray-200 bg-white p-4">
        <p className="text-sm font-medium text-gray-500">Reason</p>
        <p className="mt-1 text-sm text-gray-900">{session.reason}</p>
      </div>

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Locations
          </h2>
          <span className="text-sm text-gray-500">{locations.length} total</span>
        </div>
        <ImpersonationLocationsTable locations={locationRows} />
      </section>

      <section className="mt-8 rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900">Session limits</h2>
        <p className="mt-1 text-sm text-gray-600">
          This surface is intentionally admin-owned and read-only. It does not mount owner dashboard routes,
          does not swap Supabase Auth identity, and does not expose destructive customer actions.
        </p>
      </section>
    </AdminPage>
  );
}
