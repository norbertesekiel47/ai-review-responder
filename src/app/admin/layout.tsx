import { AdminProviders } from './providers';
import { AdminShellFrame } from '@/components/admin/AdminShellFrame';

// Auth: Supabase session checked by src/proxy.ts (admin role required)

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AdminProviders>
      <AdminShellFrame>{children}</AdminShellFrame>
    </AdminProviders>
  );
}
