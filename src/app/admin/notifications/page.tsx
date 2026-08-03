import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getAdminNotifications } from '@/lib/admin/notifications-service';
import { NotificationsClient } from './NotificationsClient';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

export default async function AdminNotificationsPage() {
  await requireAdminPage(sql, { from: '/admin/notifications' });

  const notifications = await getAdminNotifications(sql, { limit: PAGE_SIZE, offset: 0 });

  return <NotificationsClient initialData={{ ...notifications, limit: PAGE_SIZE, offset: 0 }} />;
}
