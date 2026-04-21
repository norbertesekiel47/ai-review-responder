export function isProtectedRoute(pathname: string): boolean {
  if (pathname === '/admin/login') return false;
  return (
    pathname === '/admin' || pathname.startsWith('/admin/') ||
    pathname === '/api/admin' || pathname.startsWith('/api/admin/') ||
    pathname === '/api/dashboard' || pathname.startsWith('/api/dashboard/') ||
    pathname === '/api/settings' || pathname.startsWith('/api/settings/') ||
    pathname === '/dashboard' || pathname.startsWith('/dashboard/') ||
    pathname === '/settings' || pathname.startsWith('/settings/')
  );
}
