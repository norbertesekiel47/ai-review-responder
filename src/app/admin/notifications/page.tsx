import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getAdminNotifications } from '@/lib/admin/notifications-service';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { NotificationsClient } from './NotificationsClient';
// Server-safe: PAGE_SIZE must NOT be imported from the client component
// module — the bundler would hand the server a stub. See page-sizes.ts.
import { NOTIFICATIONS_PAGE_SIZE as PAGE_SIZE } from '../page-sizes';

export const dynamic = 'force-dynamic';

export default async function AdminNotificationsPage() {
  // Gate parity with GET /api/admin/notifications, which uses
  // requireAdminWithAal2 since #1184 — the delivery log names owner recipients
  // across every tenant and this page reads it directly via `sql`, not through
  // that route.
  await requireAdminPage(sql, { from: '/admin/notifications', aal2: true });

  const notifications = await getAdminNotifications(sql, { limit: PAGE_SIZE, offset: 0 });

  return (
    <AdminPage group="Operate" title="Notifications" description="Delivery log across channels">
      <NotificationsClient initialData={{ ...notifications, limit: PAGE_SIZE, offset: 0 }} />
    </AdminPage>
  );
}
