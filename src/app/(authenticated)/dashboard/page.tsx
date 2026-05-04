import { DashboardContent } from '@/components/DashboardContent';
import { SetupChecklist } from './SetupChecklist';
import { sql } from '@/lib/db/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const cookieStore = cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() {},
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  let businessId: string | null = null;

  if (user) {
    const [row] = await sql<{ business_id: string | null }[]>`
      SELECT business_id FROM users WHERE auth_id = ${user.id} LIMIT 1
    `;
    businessId = row?.business_id ?? null;
  }

  return (
    <div>
      {businessId && <SetupChecklist businessId={businessId} />}
      <DashboardContent />
    </div>
  );
}
