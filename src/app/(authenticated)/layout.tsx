import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { redirect } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { OwnerNav } from '@/components/OwnerNav';

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
          // Layout can't set cookies — handled by middleware
        },
      },
    },
  );

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect('/admin/login');

  const [appUser] = await sql<{ business_id: string | null }[]>`
    SELECT business_id FROM users WHERE auth_id = ${authUser.id} LIMIT 1
  `;

  let businessName = '';
  if (appUser?.business_id) {
    const [biz] = await sql<{ name: string }[]>`
      SELECT name FROM businesses WHERE id = ${appUser.business_id} LIMIT 1
    `;
    businessName = biz?.name ?? '';
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <OwnerNav
        businessName={businessName}
        pastRepliesEnabled={process.env.PAST_REPLIES_VIEW_ENABLED === 'true'}
      />
      <main className="mx-auto max-w-4xl px-4 py-6">{children}</main>
    </div>
  );
}
