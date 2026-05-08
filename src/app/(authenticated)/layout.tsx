import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { redirect } from 'next/navigation';
import { Plus_Jakarta_Sans, DM_Sans } from 'next/font/google';
import { sql } from '@/lib/db/server';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { MobileTabBar } from '@/components/dashboard/MobileTabBar';
import { PendingCountProvider } from '@/components/dashboard/PendingCountContext';
import { asAccountId, asLocationId } from '@/lib/shared/ids';
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

const LOCATION_SCOPE_COOKIE = 'rw_location_scope';

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

  // Read users.account_id and primary_location_id (users.business_id was
  // dropped in migration 034).
  const [appUser] = await sql<{
    account_id: string | null;
    primary_location_id: string | null;
    owner_name: string | null;
    email: string;
  }[]>`
    SELECT u.account_id,
           (SELECT b.id FROM businesses b
            WHERE b.account_id = u.account_id
              AND b.is_primary = TRUE
              AND b.archived_at IS NULL
            LIMIT 1) AS primary_location_id,
           u.name AS owner_name, u.email
    FROM users u
    WHERE u.auth_id = ${authUser.id}
    LIMIT 1
  `;

  // Resolve the current location from the cookie, falling back to primary.
  const scopeCookie = cookieStore.get(LOCATION_SCOPE_COOKIE);
  let currentLocationId = appUser?.primary_location_id ?? null;

  if (appUser?.account_id && scopeCookie?.value) {
    // Validate the cookie location belongs to this account and isn't archived
    const [validated] = await sql<{ id: string }[]>`
      SELECT id FROM businesses
      WHERE id = ${scopeCookie.value}
        AND account_id = ${appUser.account_id}
        AND archived_at IS NULL
      LIMIT 1
    `;
    if (validated) {
      currentLocationId = validated.id;
    }
  }

  let businessName = '';
  let initialPendingCount = 0;
  if (currentLocationId) {
    const locationId = asLocationId(currentLocationId);
    // Run the two reads in parallel — they're independent.
    const [bizRows, pendingRows] = await Promise.all([
      sql<{ name: string; display_label: string | null }[]>`
        SELECT name, display_label FROM businesses WHERE id = ${locationId} LIMIT 1
      `,
      sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM responses
        WHERE business_id = ${locationId}
          AND status = 'pending_approval'
      `,
    ]);
    businessName = bizRows[0]?.display_label ?? bizRows[0]?.name ?? '';
    initialPendingCount = pendingRows[0]?.count ?? 0;
  }

  const ownerName = appUser?.owner_name ?? '';
  const ownerEmail = appUser?.email ?? authUser.email ?? '';
  const pastRepliesEnabled = process.env.PAST_REPLIES_VIEW_ENABLED === 'true';

  return (
    <div className={`rw-console ${plusJakarta.variable} ${dmSans.variable}`}>
      <PendingCountProvider initialCount={initialPendingCount}>
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
