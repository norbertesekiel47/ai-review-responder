export function isProtectedRoute(pathname: string): boolean {
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
  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.replace(/\/+$/, '')
      : pathname;

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
    normalized === '/api/billing' || normalized.startsWith('/api/billing/') ||
    normalized === '/api/locations' || normalized.startsWith('/api/locations/') ||
    normalized === '/api/dashboard' || normalized.startsWith('/api/dashboard/') ||
    normalized === '/api/settings' || normalized.startsWith('/api/settings/') ||
    normalized === '/dashboard' || normalized.startsWith('/dashboard/') ||
    normalized === '/settings' || normalized.startsWith('/settings/') ||
    normalized === '/mfa' || normalized.startsWith('/mfa/') ||
    normalized === '/onboarding' || normalized.startsWith('/onboarding/')
  );
}
