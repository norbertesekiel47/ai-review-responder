import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { adminAppUrl } from '@/lib/config/admin-app-url';
import localFont from 'next/font/local';
import { sql } from '@/lib/db/server';
import { Sidebar } from '@/components/dashboard/shell/Sidebar';
import { MobileTabBar } from '@/components/dashboard/shell/MobileTabBar';
import { PendingCountProvider } from '@/contexts/PendingCountContext';
import { OwnerIdentityProvider } from '@/contexts/OwnerIdentityContext';
import { ToastProvider } from '@/components/dashboard/shell/toast/ToastProvider';
import { AuthenticatedProviders } from '@/app/(authenticated)/_components/AuthenticatedProviders';
import { asAccountId, asLocationId } from '@/lib/shared/ids';
import {
  getRenderAuthUser,
  getRenderOwnerRow,
  getRenderRequestScope,
  ownerLoginPath,
} from '@/lib/auth/require-owner-access';
import { getPendingApprovalCount } from '@/lib/dashboard/pending-count';
import { getDisplayLabel } from '@/lib/locations/display-label';
import type { LocationScope } from '@/contexts/LocationContext';
import type { LocationId } from '@/lib/shared/ids';
import { accountOffboardingEnabled } from '@/lib/account-offboarding/flags';
import { multiLocationEnabled as isMultiLocationEnabled } from '@/lib/locations/flags';
import { solicitationWatchEnabled } from '@/lib/solicitation/flags';
import { getOffboardingState, isOperationalUIBlocked } from '@/lib/account-offboarding/gate';
import {
  ACCOUNT_OFFBOARDING_STATUS_PATH,
  REQUEST_PATHNAME_HEADER,
} from '@/lib/shared/request-path-header';
import './_styles/tokens.css';
import './_styles/console.css';

// Harbor: Gabarito is the display face (variable 400–900) — page titles, stat
// numerals, section/card headings. Figtree carries all body/UI text.
//
// Self-hosted for the same reason as the root layout — see the comment in
// src/app/layout.tsx. This second call site is why fixing only the root layout
// would NOT have fixed the build failure: any next/font/google import anywhere
// re-introduces the compile-time fetch.
const gabarito = localFont({
  src: '../fonts/gabarito-latin.woff2',
  weight: '400 900',
  variable: '--rw-font-display',
  display: 'swap',
});
const figtree = localFont({
  src: '../fonts/figtree-latin.woff2',
  weight: '300 900',
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
  // Render-scoped memo (React.cache, see require-owner-access.ts): the page
  // under this shell calls requireOwnerAccess(sql), which needs the same auth
  // user, `users` row and request scope. Going through the same three memoised
  // helpers means one Supabase Auth round trip, one `users` read and one
  // `businesses` scan per page render instead of two of each.
  // An owner whose session expired goes to the OWNER login, carrying the page
  // they were on so they land back there afterwards — the admin login rejects
  // owner credentials (UX audit D4). proxy.ts does the same one layer up; this
  // is the shell's own half of that posture.
  const authUser = await getRenderAuthUser();
  if (!authUser) redirect(ownerLoginPath(pathname));

  // Read users.account_id (users.business_id was dropped in migration 034).
  const appUser = await getRenderOwnerRow(sql, authUser.id);

  // A signed-in Supabase user with no app row is not an admin: owner login,
  // with the reason, never the admin form (UX audit D4).
  if (!appUser) redirect(ownerLoginPath(pathname, 'account_not_found'));

  // Role routing, matching requireOwnerAccess (same helper, same row)
  // exactly — 10 pages under THIS shell call that helper and get these two
  // redirects, so the shell itself having only an `account_id` check meant two
  // different postures under one layout. Defense in depth behind proxy.ts's
  // owner-page block (`role === 'owner'` on /dashboard, /settings, /account —
  // the whole of this route group), not a replacement for it.
  if (appUser.role === 'admin') redirect(adminAppUrl());
  if (appUser.role !== 'owner') redirect('/login');

  // An owner row with no account is a provisioning gap, not an admin (D4).
  if (!appUser.account_id) redirect(ownerLoginPath(pathname, 'account_not_found'));

  const accountId = asAccountId(appUser.account_id);

  if (accountOffboardingEnabled()) {
    const activeOffboarding = await getOffboardingState(accountId, sql);
    if (isOperationalUIBlocked(activeOffboarding)) {
      if (pathname !== null && pathname !== ACCOUNT_OFFBOARDING_STATUS_PATH) {
        redirect(ACCOUNT_OFFBOARDING_STATUS_PATH);
      }

      return (
        <div className={`rw-console ${gabarito.variable} ${figtree.variable}`}>
          <div className="rw-grain" aria-hidden="true" />
          <AuthenticatedProviders
            locations={[]}
            initialScope="all"
            multiLocationEnabled={false}
            enableLocationProvider={false}
          >
            <ToastProvider>
              <a className="skip-link" href="#main-content">Skip to main content</a>
              <main className="main" id="main-content">{children}</main>
            </ToastProvider>
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
  const scope = await getRenderRequestScope(
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

  const ownerName = appUser?.name ?? '';
  const ownerEmail = appUser?.email ?? authUser.email ?? '';

  // Server-authoritative flag read (invariant #13). Both navs learn watch-mode
  // state only from this prop — no NEXT_PUBLIC companion exists, and adding one
  // would fail ci:static-policy.
  const solicitationEnabled = solicitationWatchEnabled();

  return (
    <div className={`rw-console ${gabarito.variable} ${figtree.variable}`}>
      <div className="rw-grain" aria-hidden="true" />
      <AuthenticatedProviders
        locations={locationInfos}
        initialScope={initialScope}
        multiLocationEnabled={multiLocationEnabled}
      >
        <PendingCountProvider initialCount={initialPendingCount}>
          <OwnerIdentityProvider name={ownerName} email={ownerEmail}>
            <ToastProvider>
              <a className="skip-link" href="#main-content">Skip to main content</a>
              <div className="shell">
                <Sidebar
                  businessName={businessName}
                  solicitationEnabled={solicitationEnabled}
                />
                <main className="main" id="main-content">{children}</main>
              </div>
              <MobileTabBar solicitationEnabled={solicitationEnabled} />
            </ToastProvider>
          </OwnerIdentityProvider>
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
