import { notFound, redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { sql } from '@/lib/db/server';
import { PaywallWithDemoClient } from './PaywallWithDemoClient';

export const dynamic = 'force-dynamic';

interface DemoRow {
  id: string;
  generation_status: string;
  completed_at: Date | null;
  source: string | null;
  reviews_snapshot: unknown;
  generated_responses: unknown;
  business_name: string;
}

interface OwnerRow {
  role: string;
  subscription_status: string;
}

export default async function OnboardingDemoPage() {
  if (process.env.ONBOARDING_DEMO_ENABLED !== 'true') notFound();

  const cookieStore = cookies();
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

  const [row] = await sql<OwnerRow[]>`
    SELECT u.role, b.subscription_status
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;
  if (!row) redirect('/signup');
  if (row.role !== 'owner') redirect('/admin/overview');
  if (row.subscription_status === 'active') redirect('/dashboard');
  if (row.subscription_status === 'cancelled') redirect('/dashboard');

  const [demo] = await sql<DemoRow[]>`
    SELECT id, generation_status, completed_at, source,
           reviews_snapshot, generated_responses, business_name
    FROM onboarding_demos
    WHERE user_id = (SELECT id FROM users WHERE auth_id = ${user.id} LIMIT 1)
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (!demo) {
    redirect('/onboarding/start');
  }

  const isStale = demo.completed_at
    ? Date.now() - new Date(demo.completed_at).getTime() > 24 * 60 * 60 * 1000
    : false;

  // SCOPE: auto-regen on stale revisit (spec §3.6) is deferred to Phase 2.
  // v1 ships stale-with-footnote + the manual <RegenerateButton /> in
  // PaywallWithDemoClient; the button already covers the bookmark-revisit case
  // at the cost of one user click. If Phase 1 telemetry shows revisit conversion
  // drag, implement here as: (a) attempt reserveOnboardingDemoBudget();
  // (b) on success, run the same archive+insert+outbox tx as
  // /api/onboarding/demo/regenerate inline; (c) on CostCeilingExceeded, fall
  // through to stale render.

  return (
    <PaywallWithDemoClient
      initialDemo={{
        id: demo.id,
        generation_status: demo.generation_status,
        completed_at: demo.completed_at?.toISOString() ?? null,
        source: demo.source,
        reviews_snapshot: demo.reviews_snapshot as never,
        generated_responses: demo.generated_responses as never,
        business_name: demo.business_name,
      }}
      isStale={isStale}
    />
  );
}
