import { AdminProviders } from './providers';
import { AdminNav } from '@/components/AdminNav';

// Auth: Supabase session checked by src/proxy.ts (admin role required)

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AdminProviders>
      <AdminNav />
      {children}
    </AdminProviders>
  );
}
