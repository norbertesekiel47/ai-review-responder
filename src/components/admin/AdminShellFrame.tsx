'use client';

import { usePathname } from 'next/navigation';
import type { AdminShellIdentity, AdminShellImpersonation } from '@/lib/admin/shell-context';
import { AdminIdentity } from './AdminIdentity';
import { ImpersonationBanner } from './ImpersonationBanner';
import { ADMIN_AUTH_ROUTES } from './nav-config';

// Owns the auth-route decision for the whole admin shell: on login/forgot/reset
// pages it renders bare children. The permanent support pages keep identity,
// one external Admin app link and the active-session banner, with no sidebar
// or nav-counts polling.
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
    <div className="flex min-h-screen flex-col bg-gray-50">
      <header className="border-b border-rw-cream bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <AdminIdentity identity={identity} pathname={pathname} />
          <a href={adminAppUrl} className="ml-auto inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm font-medium text-rw-teal-strong underline hover:bg-rw-cream focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rw-teal-strong">
            Open Admin app
          </a>
        </div>
      </header>
      <main className="min-w-0 flex-1">
        {impersonation && <ImpersonationBanner impersonation={impersonation} adminAppUrl={adminAppUrl} />}
        {children}
      </main>
    </div>
  );
}
