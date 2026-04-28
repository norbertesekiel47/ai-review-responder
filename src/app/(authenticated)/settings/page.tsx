// src/app/(authenticated)/settings/page.tsx
//
// Server component shell. Renders the tab strip and the existing
// general settings form. Auth + subscription guard runs server-side.

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { SettingsTabs } from '@/components/dashboard/SettingsTabs';
import { SettingsGeneralForm } from './SettingsGeneralForm';

export default async function SettingsPage() {
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
          // Server components can't set cookies; middleware handles refresh.
        },
      },
    },
  );

  const { data: { user: authUser } } = await supabase.auth.getUser();
  if (!authUser) redirect('/admin/login');

  const rows = await sql<{ role: string; subscription_status: string }[]>`
    SELECT u.role, b.subscription_status
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${authUser.id}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) redirect('/admin/login');
  if (row.role !== 'owner') redirect('/admin/overview');
  if (row.subscription_status !== 'active') redirect('/onboarding/pay');

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <SettingsTabs activeTab="general" />
      <SettingsGeneralForm />
    </div>
  );
}
