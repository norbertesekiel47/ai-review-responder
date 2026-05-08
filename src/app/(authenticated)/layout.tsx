import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { redirect } from 'next/navigation';
import { Plus_Jakarta_Sans, DM_Sans } from 'next/font/google';
import { sql } from '@/lib/db/server';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { MobileTabBar } from '@/components/dashboard/MobileTabBar';
import { PendingCountProvider } from '@/components/dashboard/PendingCountContext';
import './_styles/tokens.css';
import './_styles/console.css';
import './_styles/past-replies.css';
import './_styles/settings.css';

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--rw-font-display',
  display: 'swap',
});
const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--rw-font-body',
  display: 'swap',
});

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

  const [appUser] = await sql<{ business_id: string | null; owner_name: string | null; email: string }[]>`
    SELECT business_id, name AS owner_name, email FROM users WHERE auth_id = ${authUser.id} LIMIT 1
  `;

  let businessName = '';
  if (appUser?.business_id) {
    const [biz] = await sql<{ name: string }[]>`
      SELECT name FROM businesses WHERE id = ${appUser.business_id} LIMIT 1
    `;
    businessName = biz?.name ?? '';
  }

  const ownerName = appUser?.owner_name ?? '';
  const ownerEmail = appUser?.email ?? authUser.email ?? '';
  const pastRepliesEnabled = process.env.PAST_REPLIES_VIEW_ENABLED === 'true';

  return (
    <div className={`rw-console ${plusJakarta.variable} ${dmSans.variable}`}>
      <PendingCountProvider>
        <div className="shell">
          <Sidebar
            businessName={businessName}
            ownerName={ownerName}
            ownerEmail={ownerEmail}
            pastRepliesEnabled={pastRepliesEnabled}
          />
          <div className="main">{children}</div>
        </div>
        <MobileTabBar pastRepliesEnabled={pastRepliesEnabled} />
      </PendingCountProvider>
    </div>
  );
}
