import { notFound, redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { sql } from '@/lib/db/server';
import {
  SubscriptionStatus,
  subscriptionGrantsFullAccess,
} from '@/lib/shared/subscription-status';
import { PaywallWithDemoClient } from './PaywallWithDemoClient';
import { onboardingDemoEnabled } from '@/lib/onboarding/flags';

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
  user_id: string;
  business_id: string;
  role: string;
  subscription_status: string;
  place_id_verified: boolean;
  google_maps_url: string | null;
  business_name: string;
}

export default async function OnboardingDemoPage() {
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

  const [row] = await sql<OwnerRow[]>`
    SELECT u.id AS user_id, b.id AS business_id,
           u.role, a.subscription_status, b.place_id_verified,
           b.google_maps_url, b.name AS business_name
    FROM users u
    JOIN accounts a ON a.id = u.account_id
    JOIN businesses b ON b.account_id = a.id AND b.is_primary = TRUE
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;
  if (!row) redirect('/signup');
  if (row.role === 'admin') redirect('/admin/overview');
  if (row.role !== 'owner') redirect('/login');
  if (subscriptionGrantsFullAccess(row.subscription_status)) redirect('/dashboard');
  if (row.subscription_status === SubscriptionStatus.CANCELLED) redirect('/dashboard');

  // Exclude 'archived' rows: the 23505 race-loser recovery path archives the
  // losing demo, which can have a newer created_at than the winning completed
  // row. Selecting the latest WITHOUT this filter would surface the archived
  // loser, which the UI has no render branch for → blank page.
  const [demo] = await sql<DemoRow[]>`
    SELECT id, generation_status, completed_at, source,
           reviews_snapshot, generated_responses, business_name
    FROM onboarding_demos
    WHERE user_id = ${row.user_id}::uuid
      AND business_id = ${row.business_id}::uuid
      AND generation_status <> 'archived'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (!demo) {
    // Location captured but no demo row — happens when /start succeeded but
    // the demo enqueue was skipped (cost ceiling, rate limit, or future
    // staff-allowlist gating). Without this branch we'd ping-pong between
    // /start (place_id_verified → /demo) and /demo (no demo → /start).
    // Render the paywall standalone with a sentinel "skipped" status so the
    // user can still subscribe.
    if (row.place_id_verified || row.google_maps_url) {
      return (
        <PaywallWithDemoClient
          initialDemo={{
            id: 'no-demo-sentinel',
            generation_status: 'skipped',
            completed_at: null,
            source: null,
            reviews_snapshot: null as never,
            generated_responses: null as never,
            business_name: row.business_name,
          }}
          isStale={false}
        />
      );
    }
    redirect('/onboarding/start');
  }

  const isStale = demo.completed_at
    // Server Component: renders once per request, so Date.now() is deterministic
    // here (no client re-render / hydration mismatch). The purity rule can't tell
    // this is server-only.
    // eslint-disable-next-line react-hooks/purity
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
