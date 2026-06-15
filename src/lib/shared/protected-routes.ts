const PROTECTED_OWNER_ZERNIO_API_PATHS = new Set([
  '/api/zernio/connect/start',
  '/api/zernio/connect/cancel',
  '/api/zernio/connect/select-location',
]);

const PROTECTED_OWNER_ACCOUNT_API_PATHS = new Set([
  '/api/account/offboarding/confirm',
  '/api/account/offboarding/reactivate',
  '/api/account/offboarding/status',
]);

// Routes under /api/account/* that are intentionally PUBLIC despite the blanket
// owner-API gate below. Owner offboarding keep-my-data is clicked from an email
// by a (logged-out) owner — GET renders a public confirmation page, POST
// validates the raw keep-my-data token itself — so it must not require a
// session. Checked before the `/api/account/` prefix so it is never gated.
const PUBLIC_OWNER_ACCOUNT_API_PATHS = new Set([
  '/api/account/offboarding/keep-my-data',
]);

const PROTECTED_MIXED_ROLE_API_PATHS = new Set([
  '/api/zernio/disconnect',
]);

export function normalizePath(pathname: string): string {
  // Normalize case AND trailing slash before any comparison.
  //
  // Case: App Router routes are case-sensitive (so /ADMIN/x would 404), but
  // the proxy's protection check must not be bypassable by casing — lowercase
  // here so /ADMIN, /Api/Admin, etc. still match the protected prefixes.
  //
  // Trailing slash: Next.js's default `trailingSlash: false` redirects
  // `/x/` → `/x`, but that redirect runs AFTER proxy sees the path. Without
  // normalization here, `/admin/login/` would fail the exact-match exemption
  // AND match the protected `startsWith('/admin/')` branch, locking
  // legitimate users out of the public login surface.
  //
  // Preserve `/` (the root) — it's both the public landing page and the only
  // path where the trailing slash IS the path.
  const lowered = pathname.toLowerCase();
  return lowered.length > 1 && lowered.endsWith('/')
    ? lowered.replace(/\/+$/, '')
    : lowered;
}

export function isProtectedOwnerApiRoute(pathname: string): boolean {
  const normalized = normalizePath(pathname);
  if (PUBLIC_OWNER_ACCOUNT_API_PATHS.has(normalized)) return false;
  return (
    normalized === '/api/dashboard' || normalized.startsWith('/api/dashboard/') ||
    normalized === '/api/settings' || normalized.startsWith('/api/settings/') ||
    PROTECTED_OWNER_ACCOUNT_API_PATHS.has(normalized) ||
    normalized === '/api/account' || normalized.startsWith('/api/account/') ||
    normalized === '/api/billing' || normalized.startsWith('/api/billing/') ||
    normalized === '/api/locations' || normalized.startsWith('/api/locations/') ||
    PROTECTED_OWNER_ZERNIO_API_PATHS.has(normalized)
  );
}

export function isProtectedMixedRoleApiRoute(pathname: string): boolean {
  const normalized = normalizePath(pathname);
  return PROTECTED_MIXED_ROLE_API_PATHS.has(normalized);
}

function isProtectedAppApiRoute(pathname: string): boolean {
  return (
    isProtectedOwnerApiRoute(pathname) ||
    isProtectedMixedRoleApiRoute(pathname)
  );
}

export function isProtectedRoute(pathname: string): boolean {
  const normalized = normalizePath(pathname);

  if (
    normalized === '/admin/login' ||
    normalized === '/admin/forgot-password' ||
    normalized === '/admin/reset-password'
  ) {
    return false;
  }
  return (
    normalized === '/admin' || normalized.startsWith('/admin/') ||
    normalized === '/api/admin' || normalized.startsWith('/api/admin/') ||
    isProtectedAppApiRoute(normalized) ||
    normalized === '/dashboard' || normalized.startsWith('/dashboard/') ||
    normalized === '/account' || normalized.startsWith('/account/') ||
    normalized === '/settings' || normalized.startsWith('/settings/') ||
    normalized === '/mfa' || normalized.startsWith('/mfa/') ||
    normalized === '/onboarding' || normalized.startsWith('/onboarding/')
  );
}
