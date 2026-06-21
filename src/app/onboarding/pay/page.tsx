import type { Metadata } from 'next';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import {
  SubscriptionStatus,
  subscriptionGrantsFullAccess,
} from '@/lib/shared/subscription-status';
import { PlanPickerClient } from './PlanPickerClient';
import { OnboardingFunnelShell } from '../_shared/OnboardingFunnelShell';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Choose your plan | RepWorth' };

export default async function OnboardingPayPage({
  searchParams,
}: {
  searchParams: Promise<{ cancelled?: string }>;
}) {
  // Self-serve signup must hide the entire onboarding flow when the flag is
  // off — including this server-rendered page. Otherwise a leaked URL could
  // probe whether self-serve was on.
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();

  // Use `await cookies()` for forward-compat with Next.js 15 (where it
  // returns a Promise). On Next 14 the await unwraps a non-Promise to
  // itself — a runtime no-op — but matches the existing pattern in
  // src/app/(authenticated)/layout.tsx and src/lib/db/supabase-server.ts.
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
          // Read-only — page-level SSR never rewrites session cookies.
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [row] = await sql<
    {
      business_id: string;
      subscription_status: string;
      place_id_verified: boolean;
      google_maps_url: string | null;
    }[]
  >`
    SELECT
      b.id                AS business_id,
      a.subscription_status,
      b.place_id_verified,
      b.google_maps_url
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;
  if (!row) redirect('/signup');

  if (!user.email_confirmed_at) {
    const emailParam = encodeURIComponent(user.email ?? '');
    redirect(`/signup/check-email?from=pay&email=${emailParam}`);
  }
  if (subscriptionGrantsFullAccess(row.subscription_status)) {
    // Active/trialing but wizard not yet completed → push to wizard, not
    // dashboard. The dashboard has a "Set up your business" CTA fallback, but
    // routing entitled-but-not-onboarded owners straight to the wizard matches
    // the documented happy-path flow (PaymentSuccessClient also pushes here).
    // Treat NULL google_maps_url + place_id_verified=false as "not onboarded".
    const businessOnboarded =
      row.place_id_verified || row.google_maps_url !== null;
    redirect(businessOnboarded ? '/dashboard' : '/onboarding/business');
  }
  // past_due / cancelled / unknown must NOT see the picker — a click would
  // create a duplicate Stripe subscription. Billing recovery for these
  // states lives on the dashboard side (Customer Portal / banner flows).
  if (row.subscription_status !== SubscriptionStatus.PENDING_PAYMENT) redirect('/dashboard');

  const { cancelled } = await searchParams;

  return (
    <OnboardingFunnelShell step="plan" maxWidth="6xl">
      <PlanPickerClient cancelled={Boolean(cancelled)} />
    </OnboardingFunnelShell>
  );
}
