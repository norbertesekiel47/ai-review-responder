import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { sql } from '@/lib/db/server';
import { IMPERSONATION_COOKIE_NAME } from '@/lib/admin/impersonation/cookie';
import { loadAdminShellContext } from '@/lib/admin/shell-context';
import { AdminShellFrame } from '@/components/admin/AdminShellFrame';
import { AdminProviders } from './providers';

// Auth: Supabase session checked by src/proxy.ts (admin role required), and
// again per page by requireAdminPage. This layout reads identity for DISPLAY
// only — the sidebar footer and the view-as banner — and never redirects: the
// auth routes share it and must render signed-out.

export default async function AdminLayout({
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
          // Server components cannot mutate response cookies.
        },
      },
    },
  );

  const shell = await loadAdminShellContext(sql, {
    supabase,
    signedImpersonationCookie: cookieStore.get(IMPERSONATION_COOKIE_NAME)?.value ?? null,
  });

  return (
    <AdminProviders>
      <AdminShellFrame identity={shell.identity} impersonation={shell.impersonation}>
        {children}
      </AdminShellFrame>
    </AdminProviders>
  );
}
