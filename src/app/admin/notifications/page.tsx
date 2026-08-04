import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getAdminNotifications } from '@/lib/admin/notifications-service';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { NotificationsClient, PAGE_SIZE } from './NotificationsClient';

export const dynamic = 'force-dynamic';

export default async function AdminNotificationsPage() {
  await requireAdminPage(sql, { from: '/admin/notifications' });

  const notifications = await getAdminNotifications(sql, { limit: PAGE_SIZE, offset: 0 });

  return (
    <AdminPage group="Operate" title="Notifications" description="Delivery log across channels">
      <NotificationsClient initialData={{ ...notifications, limit: PAGE_SIZE, offset: 0 }} />
    </AdminPage>
  );
}
