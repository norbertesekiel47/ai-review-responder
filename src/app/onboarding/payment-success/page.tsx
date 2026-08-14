import type { Metadata } from 'next';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { PaymentSuccessClient } from './PaymentSuccessClient';

export const dynamic = 'force-dynamic';

interface PaymentSuccessGuardRow {
  role: string;
}

export const metadata: Metadata = { title: 'Payment confirmed | RepWorth' };

/**
 * Guard: authenticated session + `u.role = 'owner'`. Deliberately NO
 * subscription-state narrowing — this page is the crossing point of the
 * payment transition, so it must render in `pending_payment` (Stripe's
 * projection has not landed yet) and in every post-payment state alike. Its
 * poller (`GET /api/auth/signup-status`) carries the same rule; gating either
 * on a single status would bounce an owner mid-transition.
 *
 * Replaces a `SELF_SERVE_SIGNUP_ENABLED` gate — that flag now means only
 * "strangers may mint accounts", see
 * `docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`.
 */
export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string; checkout_session_id?: string }>;
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
          // Read-only — page-level SSR never rewrites session cookies.
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [row] = await sql<PaymentSuccessGuardRow[]>`
    SELECT u.role
    FROM users u
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;

  if (!row) redirect('/signup');
  if (row.role === 'admin') redirect('/admin/overview');
  if (row.role !== 'owner') redirect('/login');

  const params = await searchParams;
  return (
    <PaymentSuccessClient
      checkoutSessionId={params.session_id ?? params.checkout_session_id ?? null}
    />
  );
}
