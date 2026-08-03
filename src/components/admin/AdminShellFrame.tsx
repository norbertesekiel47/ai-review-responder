'use client';

import { usePathname } from 'next/navigation';
import { AdminSidebar } from './AdminSidebar';
import { ADMIN_AUTH_ROUTES } from './nav-config';

// Owns the auth-route decision for the whole admin shell: on login/forgot/reset
// pages it renders bare children (no sidebar mount, so no nav-counts polling and
// no mobile top-bar pad); everywhere else it renders the full sidebar + main frame.
export function AdminShellFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname !== null && ADMIN_AUTH_ROUTES.includes(pathname)) {
    return <>{children}</>;
  }
  return (
    <div className="flex min-h-screen bg-gray-50">
      <AdminSidebar />
      <main className="min-w-0 flex-1 pt-12 md:pt-0">{children}</main>
    </div>
  );
}
