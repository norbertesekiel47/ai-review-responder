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
import { EndImpersonationButton } from './EndImpersonationButton';

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

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold text-blue-900">
                Admin view-as session
              </p>
              <p className="mt-1 text-sm text-blue-800">
                Read-only support context for {session.impersonatedEmail ?? 'owner user'}.
                Expires {expiresAt}. Actor: {admin.email}.
              </p>
            </div>
            <EndImpersonationButton />
          </div>
        </div>

        <div className="mt-8">
          <p className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Account
          </p>
          <h1 className="mt-1 text-2xl font-bold text-gray-900">
            {session.accountDisplayName ?? session.accountId}
          </h1>
          <div className="mt-3 grid gap-3 text-sm text-gray-700 sm:grid-cols-2">
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
        </div>

        <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              Locations
            </h2>
            <span className="text-sm text-gray-500">{locations.length} total</span>
          </div>
          <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Location ID</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {locations.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-gray-400">
                      No locations found for this account.
                    </td>
                  </tr>
                )}
                {locations.map((location) => (
                  <tr key={location.id}>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">
                        {location.displayLabel ?? location.name}
                      </div>
                      {location.displayLabel && (
                        <div className="text-xs text-gray-500">{location.name}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">
                      {location.id}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                        {location.archivedAt ? 'Archived' : location.isPrimary ? 'Primary' : 'Active'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-8 rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900">Session limits</h2>
          <p className="mt-1 text-sm text-gray-600">
            This surface is intentionally admin-owned and read-only. It does not mount owner dashboard routes,
            does not swap Supabase Auth identity, and does not expose destructive customer actions.
          </p>
        </section>
      </div>
    </div>
  );
}
