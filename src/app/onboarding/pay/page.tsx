import type { Metadata } from 'next';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { isPriceVariant } from '@/lib/accounts/tier-config';
import {
  SubscriptionStatus,
  subscriptionGrantsFullAccess,
} from '@/lib/shared/subscription-status';
import { trialEnabled } from '@/lib/payments/flags';
import { buildPlanPresentation } from '@/lib/payments/plan-presentation';
import { autopilotPurchasable } from '@/lib/payments/tier-purchasability';
import { PlanPickerClient } from './PlanPickerClient';
import { OnboardingFunnelShell } from '../_shared/OnboardingFunnelShell';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Choose your plan | RepWorth' };

export default async function OnboardingPayPage({
  searchParams,
}: {
  searchParams: Promise<{ cancelled?: string }>;
}) {
  // Guard: authenticated session + `u.role = 'owner'` (in the query below) +
  // `pending_payment` (the redirects below). No `SELF_SERVE_SIGNUP_ENABLED`
  // check — the flag now means only "strangers may mint accounts"
  // (`docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`)
  // and an admin-invited owner picks a plan here while it is off.
  //
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
      price_variant: string;
      subscription_status: string;
      place_id_verified: boolean;
      google_maps_url: string | null;
    }[]
  >`
    SELECT
      b.id                AS business_id,
      a.price_variant,
      a.subscription_status,
      b.place_id_verified,
      b.google_maps_url
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${user.id}
      AND u.role = 'owner'
    LIMIT 1
  `;
  // Owner-only filter at the SQL boundary. Proxy gates /onboarding/* PAGES on
  // role, but this page must not depend on that: without the filter an
  // admin/sales_partner session read whichever business their account happens to
  // point at and was offered a plan picker for it. A non-owner session now gets
  // exactly the missing-row treatment — one branch, no separate role code path.
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
  if (!isPriceVariant(row.price_variant)) {
    throw new Error('Account has an invalid price variant');
  }

  const { cancelled } = await searchParams;
  const viewModel = buildPlanPresentation({
    priceVariant: row.price_variant,
    autopilotPurchasable: autopilotPurchasable(),
    trialEnabled: trialEnabled(),
  });

  return (
    <OnboardingFunnelShell step="plan" maxWidth="6xl">
      <PlanPickerClient cancelled={Boolean(cancelled)} {...viewModel} />
    </OnboardingFunnelShell>
  );
}
