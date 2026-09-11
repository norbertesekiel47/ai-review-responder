'use client';

import { usePathname } from 'next/navigation';
import type { AdminShellIdentity, AdminShellImpersonation } from '@/lib/admin/shell-context';
import { AdminSidebar } from './AdminSidebar';
import { ImpersonationBanner } from './ImpersonationBanner';
import { ADMIN_AUTH_ROUTES } from './nav-config';

// Owns the auth-route decision for the whole admin shell: on login/forgot/reset
// pages it renders bare children (no sidebar mount, so no nav-counts polling and
// no mobile top-bar pad); everywhere else it renders the full sidebar + main frame.
//
// `identity` and `impersonation` come from the server layout (read once per
// request from the session cookie — never from a browser-side service key) and
// are display facts only; every page still runs its own gate.
export function AdminShellFrame({
  identity = null,
  impersonation = null,
  adminAppUrl,
  children,
}: {
  identity?: AdminShellIdentity | null;
  impersonation?: AdminShellImpersonation | null;
  adminAppUrl: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  if (pathname !== null && ADMIN_AUTH_ROUTES.includes(pathname)) {
    return <>{children}</>;
  }
  return (
    <div className="flex min-h-screen bg-gray-50">
      <AdminSidebar identity={identity} adminAppUrl={adminAppUrl} />
      <main className="min-w-0 flex-1 pt-12 md:pt-0">
        {impersonation && <ImpersonationBanner impersonation={impersonation} adminAppUrl={adminAppUrl} />}
        {children}
      </main>
    </div>
  );
}
