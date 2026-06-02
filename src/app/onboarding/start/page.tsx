import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { sql } from '@/lib/db/server';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { StartLocationClient } from './StartLocationClient';

export const dynamic = 'force-dynamic';

interface GuardRow {
  role: string;
  subscription_status: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
}

export const metadata: Metadata = { title: 'Get started | RepWorth' };

export default async function OnboardingStartPage() {
  if (process.env.ONBOARDING_DEMO_ENABLED !== 'true') notFound();
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();

  const cookieStore = await cookies();
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
  if (!user) redirect('/login');

  const [row] = await sql<GuardRow[]>`
    SELECT u.role, a.subscription_status, b.place_id_verified, b.google_maps_url
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;

  if (!row) redirect('/signup');
  if (row.role === 'admin') redirect('/admin/overview');
  if (row.role !== 'owner') redirect('/login');
  if (row.subscription_status === SubscriptionStatus.ACTIVE) redirect('/dashboard');
  if (row.subscription_status === SubscriptionStatus.CANCELLED) redirect('/dashboard');
  if (row.place_id_verified || row.google_maps_url) redirect('/onboarding/demo');

  return <StartLocationClient />;
}
