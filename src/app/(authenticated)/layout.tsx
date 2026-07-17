import { cookies, headers } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { redirect } from 'next/navigation';
import { Young_Serif, DM_Sans } from 'next/font/google';
import { sql } from '@/lib/db/server';
import { Sidebar } from '@/components/dashboard/shell/Sidebar';
import { MobileTabBar } from '@/components/dashboard/shell/MobileTabBar';
import { PendingCountProvider } from '@/contexts/PendingCountContext';
import { AuthenticatedProviders } from '@/app/(authenticated)/_components/AuthenticatedProviders';
import { asAccountId, asLocationId } from '@/lib/shared/ids';
import { getRequestScope } from '@/lib/auth/get-request-scope';
import { getPendingApprovalCount } from '@/lib/dashboard/pending-count';
import { getDisplayLabel } from '@/lib/locations/display-label';
import type { LocationScope } from '@/contexts/LocationContext';
import type { LocationId } from '@/lib/shared/ids';
import { accountOffboardingEnabled } from '@/lib/account-offboarding/flags';
import { multiLocationEnabled as isMultiLocationEnabled } from '@/lib/locations/flags';
import { getOffboardingState, isOperationalUIBlocked } from '@/lib/account-offboarding/gate';
import {
  ACCOUNT_OFFBOARDING_STATUS_PATH,
  REQUEST_PATHNAME_HEADER,
} from '@/lib/shared/request-path-header';
import './_styles/tokens.css';
import './_styles/console.css';
import './_styles/past-replies.css';
import './_styles/settings.css';
import './_styles/wizard.css';

// Warm Editorial: Young Serif is display-only (single weight 400) — page titles,
// stat numerals, section/card headings. DM Sans carries all body/UI text.
const youngSerif = Young_Serif({
  subsets: ['latin'],
  weight: ['400'],
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
  const [cookieStore, requestHeaders] = await Promise.all([
    cookies(),
    headers(),
  ]);
  const pathname = normalizeLayoutPathname(
    requestHeaders.get(REQUEST_PATHNAME_HEADER),
  );
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Layout can't set cookies — handled by proxy
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

  if (accountOffboardingEnabled()) {
    const activeOffboarding = await getOffboardingState(accountId, sql);
    if (isOperationalUIBlocked(activeOffboarding)) {
      if (pathname !== null && pathname !== ACCOUNT_OFFBOARDING_STATUS_PATH) {
        redirect(ACCOUNT_OFFBOARDING_STATUS_PATH);
      }

      return (
        <div className={`rw-console ${youngSerif.variable} ${dmSans.variable}`}>
          <div className="rw-grain" aria-hidden="true" />
          <AuthenticatedProviders
            locations={[]}
            initialScope="all"
            multiLocationEnabled={false}
            enableLocationProvider={false}
          >
            <div className="main">{children}</div>
          </AuthenticatedProviders>
        </div>
      );
    }
  }

  // Determine multi-location state and fetch all active locations
  const multiLocationEnabled = isMultiLocationEnabled();

  // Reuse getRequestScope() for cookie validation + primary fallback
  // instead of duplicating the same validation logic inline.
  const cookieValue = cookieStore.get(LOCATION_SCOPE_COOKIE)?.value ?? null;
  const scope = await getRequestScope(
    sql,
    accountId,
    cookieValue ? asLocationId(cookieValue) : null,
  );
  const currentLocationId = scope.currentLocationId;

  // Determine initial client-side scope from cookie
  let initialScope: LocationScope = currentLocationId;
  if (multiLocationEnabled && cookieValue === 'all') {
    initialScope = 'all';
  }

  // The scope query above already fetched every active location's
  // name/display_label, so the current-location lookup and the multi-location
  // list need no further `businesses WHERE account_id` round trips — only the
  // pending count still hits the DB here.
  //
  // Shared authoritative pending count (excludes held/flagged) — same helper
  // the dashboard response uses, so the tab badge and approvals strip agree.
  const initialPendingCount = await getPendingApprovalCount(sql, currentLocationId);

  const currentLocation = scope.activeLocations.find((loc) => loc.id === currentLocationId);
  const businessName = currentLocation ? getDisplayLabel(currentLocation) : '';

  // Build the locations list for the client-side LocationContext
  const locationInfos = multiLocationEnabled
    ? scope.activeLocations.map((loc) => ({
        id: loc.id as LocationId,
        name: loc.name,
        displayLabel: loc.display_label,
        isPrimary: loc.is_primary,
      }))
    : [];

  // For multi-location accounts, default to "All Locations" when no valid cookie
  if (multiLocationEnabled && locationInfos.length > 1 && !cookieValue) {
    initialScope = 'all';
  }

  const ownerName = appUser?.owner_name ?? '';
  const ownerEmail = appUser?.email ?? authUser.email ?? '';

  return (
    <div className={`rw-console ${youngSerif.variable} ${dmSans.variable}`}>
      <div className="rw-grain" aria-hidden="true" />
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
            />
            <div className="main">{children}</div>
          </div>
          <MobileTabBar />
        </PendingCountProvider>
      </AuthenticatedProviders>
    </div>
  );
}

function normalizeLayoutPathname(pathname: string | null): string | null {
  if (!pathname) return null;
  return pathname.length > 1 && pathname.endsWith('/')
    ? pathname.replace(/\/+$/, '')
    : pathname;
}
