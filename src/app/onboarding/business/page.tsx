import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { sql } from '@/lib/db/server';
import { BusinessWizardClient } from './BusinessWizardClient';
import { resolveWizardDestination, shouldUseDemoWizard, type WizardGuardRow } from './guard';

export const dynamic = 'force-dynamic';

interface BusinessDataRow extends WizardGuardRow {
  category: string | null;
  website: string | null;
  name: string;
}

export const metadata: Metadata = { title: 'Set up your business | RepWorth' };

export default async function OnboardingBusinessPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();

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

  const [row] = await sql<BusinessDataRow[]>`
    SELECT u.role, a.subscription_status, b.place_id_verified, b.google_maps_url,
           b.category, b.website, b.name
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;

  // demoFlowEnabled is true ONLY when the demo is enabled AND the location was
  // already captured (pre-pay demo flow). A card-up-front trial arrives subscribed
  // with no location → demoFlowEnabled=false → non-demo wizard (which captures the
  // location), instead of being bounced to /onboarding/start (→ infinite loop).
  const demoFlowEnabled = shouldUseDemoWizard(
    process.env.ONBOARDING_DEMO_ENABLED === 'true',
    row,
  );
  const decision = resolveWizardDestination(row, { demoFlowEnabled });
  if (decision.kind === 'redirect') redirect(decision.path);

  return (
    <BusinessWizardClient
      initialValues={{
        category: row?.category ?? '',
        website: row?.website ?? '',
        businessName: row?.name ?? '',
      }}
      demoFlowEnabled={demoFlowEnabled}
    />
  );
}
