import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { sql } from '@/lib/db/server';
import { BusinessWizardClient } from './BusinessWizardClient';
import { resolveWizardDestination, wizardClientProps, type WizardPageRow } from './guard';
import { onboardingDemoEnabled } from '@/lib/onboarding/flags';

export const dynamic = 'force-dynamic';

// Bare page name — the root layout's `title.template` appends '· RepWorth' (A26).
export const metadata: Metadata = { title: 'Set up your business' };

/**
 * Guard: authenticated session + `u.role = 'owner'` +
 * `subscriptionGrantsFullAccess(status)` + wizard-incomplete — all four owned
 * by `resolveWizardDestination` in `./guard.ts`, unchanged. The former
 * `SELF_SERVE_SIGNUP_ENABLED` check is gone: the flag now means only
 * "strangers may mint accounts"
 * (`docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`),
 * and an admin-invited owner finishes this wizard while it is off.
 */
export default async function OnboardingBusinessPage() {
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

  const [row] = await sql<WizardPageRow[]>`
    SELECT u.role, a.subscription_status, a.subscription_tier,
           b.place_id_verified, b.google_maps_url,
           b.category, b.website, b.name
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;

  // demoFlowEnabled is true ONLY when the demo is enabled AND the location was
  // already captured (pre-pay demo flow) — see `wizardClientProps`. A
  // card-up-front trial arrives subscribed with no location → non-demo wizard
  // (which captures the location), instead of the /onboarding/start bounce loop.
  const props = wizardClientProps(row, onboardingDemoEnabled());
  const decision = resolveWizardDestination(row, { demoFlowEnabled: props.demoFlowEnabled });
  if (decision.kind === 'redirect') redirect(decision.path);

  return <BusinessWizardClient {...props} />;
}
