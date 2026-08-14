import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { sql } from '@/lib/db/server';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { PLACEHOLDER_BUSINESS_NAME } from '@/lib/onboarding/create-business';
import { StartLocationClient } from './StartLocationClient';
import { onboardingDemoEnabled } from '@/lib/onboarding/flags';

export const dynamic = 'force-dynamic';

interface GuardRow {
  role: string;
  subscription_status: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
  name: string;
}

export const metadata: Metadata = { title: 'Get started | RepWorth' };

/**
 * Guard: `ONBOARDING_DEMO_ENABLED` (the demo lane's own kill switch) +
 * authenticated session + `u.role = 'owner'` + `pending_payment`. The former
 * `SELF_SERVE_SIGNUP_ENABLED` check is gone — the flag now means only
 * "strangers may mint accounts"
 * (`docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`),
 * so the double gate collapses to the single demo gate.
 */
export default async function OnboardingStartPage() {
  if (!onboardingDemoEnabled()) notFound();

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
    SELECT u.role, a.subscription_status, b.place_id_verified, b.google_maps_url,
           b.name
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;

  if (!row) redirect('/signup');
  if (row.role === 'admin') redirect('/admin/overview');
  if (row.role !== 'owner') redirect('/login');
  // The allowed state for this step is exactly `pending_payment`. Everything
  // else belongs on the dashboard: active/trialing are already entitled,
  // past_due and cancelled are billing-recovery states. Stated positively so
  // no status can fall through — `past_due` used to, rendering a form whose
  // POST answers 409.
  if (row.subscription_status !== SubscriptionStatus.PENDING_PAYMENT) redirect('/dashboard');
  if (row.place_id_verified || row.google_maps_url) redirect('/onboarding/demo');

  // An admin-invited owner arrives with the real business name already on the
  // Business row (the admin typed it at creation); a self-serve owner arrives
  // with the placeholder. Prefill only in the first case so the invited owner
  // sees their name instead of an empty box, and the self-serve owner is never
  // shown "(pending setup)" as if it were their answer. Server-rendered prop —
  // no client fetch, so the value cannot be probed without a session.
  const initialBusinessName =
    row.name && row.name !== PLACEHOLDER_BUSINESS_NAME ? row.name : '';

  return <StartLocationClient initialBusinessName={initialBusinessName} />;
}
