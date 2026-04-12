import { AdminProviders } from './providers';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AdminProviders>{children}</AdminProviders>;
}
