import { notFound, redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { sql } from '@/lib/db/server';
import { BusinessWizardClient } from './BusinessWizardClient';
import { resolveWizardDestination, type WizardGuardRow } from './guard';

export const dynamic = 'force-dynamic';

export default async function OnboardingBusinessPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();

  const cookieStore = cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Read-only — page-level SSR never rewrites session cookies.
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [row] = await sql<WizardGuardRow[]>`
    SELECT u.role, b.subscription_status, b.place_id_verified, b.google_maps_url
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;

  // All four redirect rules live in resolveWizardDestination (see ./guard.ts)
  // so they can be unit-tested without dragging a JSX transformer into vitest.
  const decision = resolveWizardDestination(row);
  if (decision.kind === 'redirect') redirect(decision.path);

  return <BusinessWizardClient />;
}
