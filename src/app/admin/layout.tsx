import { AdminProviders } from './providers';

// Auth handled by src/middleware.ts (ADMIN_API_KEY cookie check)
// Sprint 3: replace with Supabase Auth role check (admin/sales_partner)

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AdminProviders>{children}</AdminProviders>;
}
