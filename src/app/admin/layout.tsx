import { AdminProviders } from './providers';
import { AdminSidebar } from '@/components/admin/AdminSidebar';

// Auth: Supabase session checked by src/proxy.ts (admin role required)

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AdminProviders>
      <div className="flex min-h-screen bg-gray-50">
        <AdminSidebar />
        <main className="min-w-0 flex-1 pt-12 md:pt-0">{children}</main>
      </div>
    </AdminProviders>
  );
}
