import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { redirect } from 'next/navigation';
import { Plus_Jakarta_Sans, DM_Sans } from 'next/font/google';
import { sql } from '@/lib/db/server';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { MobileTabBar } from '@/components/dashboard/MobileTabBar';
import { PendingCountProvider } from '@/components/dashboard/PendingCountContext';
import { AuthenticatedProviders } from '@/components/dashboard/AuthenticatedProviders';
import { asAccountId, asLocationId } from '@/lib/shared/ids';
import { getRequestScope } from '@/lib/auth/get-request-scope';
import { getLocationsForAccount } from '@/lib/locations/repo';
import { getDisplayLabel } from '@/lib/locations/display-label';
import type { LocationScope } from '@/contexts/LocationContext';
import type { LocationId } from '@/lib/shared/ids';
import './_styles/tokens.css';
import './_styles/console.css';
import './_styles/past-replies.css';
import './_styles/settings.css';
import './_styles/wizard.css';

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--rw-font-display',
  display: 'swap',
});
const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--rw-font-body',
  display: 'swap',
});

const LOCATION_SCOPE_COOKIE = 'rw_location_scope';

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Layout can't set cookies — handled by middleware
        },
      },
    },
  );

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect('/admin/login');

  // Read users.account_id (users.business_id was dropped in migration 034).
  const [appUser] = await sql<{
    account_id: string | null;
    owner_name: string | null;
    email: string;
  }[]>`
    SELECT u.account_id, u.name AS owner_name, u.email
    FROM users u
    WHERE u.auth_id = ${authUser.id}
    LIMIT 1
  `;

  if (!appUser?.account_id) redirect('/admin/login');

  const accountId = asAccountId(appUser.account_id);

  // Determine multi-location state and fetch all active locations
  const multiLocationEnabled = process.env.MULTI_LOCATION_ENABLED === 'true';

  // Reuse getRequestScope() for cookie validation + primary fallback
  // instead of duplicating the same validation logic inline.
  const cookieValue = cookieStore.get(LOCATION_SCOPE_COOKIE)?.value ?? null;
  const scope = await getRequestScope(
    accountId,
    cookieValue ? asLocationId(cookieValue) : null,
  );
  const currentLocationId = scope.currentLocationId;

  // Determine initial client-side scope from cookie
  let initialScope: LocationScope = currentLocationId;
  if (multiLocationEnabled && cookieValue === 'all') {
    initialScope = 'all';
  }

  // Fetch all active locations for this account in parallel with other queries
  let businessName = '';
  let initialPendingCount = 0;

  const [bizRows, pendingRows, allLocations] = await Promise.all([
    sql<{ name: string; display_label: string | null }[]>`
      SELECT name, display_label FROM businesses WHERE id = ${currentLocationId} LIMIT 1
    `,
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM responses
      WHERE business_id = ${currentLocationId}
        AND status = 'pending_approval'
    `,
    multiLocationEnabled
      ? getLocationsForAccount(accountId)
      : Promise.resolve([]),
  ]);

  businessName = bizRows[0] ? getDisplayLabel(bizRows[0]) : '';
  initialPendingCount = pendingRows[0]?.count ?? 0;

  // Build the locations list for the client-side LocationContext
  const locationInfos = allLocations.map((loc) => ({
    id: loc.id as LocationId,
    name: loc.name,
    displayLabel: loc.display_label,
    isPrimary: loc.is_primary,
  }));

  // For multi-location accounts, default to "All Locations" when no valid cookie
  if (multiLocationEnabled && locationInfos.length > 1 && !cookieValue) {
    initialScope = 'all';
  }

  const ownerName = appUser?.owner_name ?? '';
  const ownerEmail = appUser?.email ?? authUser.email ?? '';
  const pastRepliesEnabled = process.env.PAST_REPLIES_VIEW_ENABLED === 'true';

  return (
    <div className={`rw-console ${plusJakarta.variable} ${dmSans.variable}`}>
      <AuthenticatedProviders
        locations={locationInfos}
        initialScope={initialScope}
        multiLocationEnabled={multiLocationEnabled}
      >
        <PendingCountProvider initialCount={initialPendingCount}>
          <div className="shell">
            <Sidebar
              businessName={businessName}
              ownerName={ownerName}
              ownerEmail={ownerEmail}
              pastRepliesEnabled={pastRepliesEnabled}
            />
            <div className="main">{children}</div>
          </div>
          <MobileTabBar pastRepliesEnabled={pastRepliesEnabled} />
        </PendingCountProvider>
      </AuthenticatedProviders>
    </div>
  );
}
