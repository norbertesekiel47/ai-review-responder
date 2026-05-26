const PROTECTED_ZERNIO_API_PATHS = new Set([
  '/api/zernio/connect/start',
  '/api/zernio/connect/cancel',
  '/api/zernio/connect/select-location',
  '/api/zernio/disconnect',
]);

function normalizePath(pathname: string): string {
  // Normalize trailing slash before any comparison.
  //
  // Next.js's default `trailingSlash: false` setting redirects `/x/` → `/x`,
  // but that redirect runs AFTER proxy. Proxy sees the original
  // request path. Without normalization here, `/admin/login/` would fail the
  // exact-match exemption check (`'/admin/login/' === '/admin/login'` is
  // false) AND match the protected `startsWith('/admin/')` branch, locking
  // legitimate users out of the public login surface.
  //
  // Preserve `/` (the root) — it's both the public landing page and the
  // only path where the trailing slash IS the path.
  return pathname.length > 1 && pathname.endsWith('/')
    ? pathname.replace(/\/+$/, '')
    : pathname;
}

export function isProtectedOwnerApiRoute(pathname: string): boolean {
  const normalized = normalizePath(pathname);
  return (
    normalized === '/api/dashboard' || normalized.startsWith('/api/dashboard/') ||
    normalized === '/api/settings' || normalized.startsWith('/api/settings/') ||
    normalized === '/api/account' || normalized.startsWith('/api/account/') ||
    normalized === '/api/billing' || normalized.startsWith('/api/billing/') ||
    normalized === '/api/locations' || normalized.startsWith('/api/locations/') ||
    PROTECTED_ZERNIO_API_PATHS.has(normalized)
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
    isProtectedOwnerApiRoute(normalized) ||
    normalized === '/dashboard' || normalized.startsWith('/dashboard/') ||
    normalized === '/settings' || normalized.startsWith('/settings/') ||
    normalized === '/mfa' || normalized.startsWith('/mfa/') ||
    normalized === '/onboarding' || normalized.startsWith('/onboarding/')
  );
}
