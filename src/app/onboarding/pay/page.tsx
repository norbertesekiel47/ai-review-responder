import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { buildPaymentLinkUrl } from '@/lib/payments/payment-link';

export const dynamic = 'force-dynamic';

export default async function OnboardingPayPage({
  searchParams,
}: {
  searchParams: { cancelled?: string };
}) {
  // Self-serve signup must hide the entire onboarding flow when the flag is
  // off — including this server-rendered page. Otherwise a leaked URL could
  // probe whether self-serve was on.
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

  const [row] = await sql<
    {
      business_id: string;
      business_name: string;
      subscription_status: string;
      subscription_tier: string;
      owner_email: string;
    }[]
  >`
    SELECT
      b.id          AS business_id,
      b.name        AS business_name,
      b.subscription_status,
      b.subscription_tier,
      b.owner_email
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;
  if (!row) redirect('/signup');

  if (!user.email_confirmed_at) {
    const emailParam = encodeURIComponent(user.email ?? '');
    redirect(`/signup/check-email?from=pay&email=${emailParam}`);
  }
  if (row.subscription_status === 'active') redirect('/dashboard');
  // past_due / cancelled / unknown must NOT see the Payment Link — a click
  // would create a duplicate Stripe subscription. Billing recovery for these
  // states lives on the dashboard side (Customer Portal / banner flows).
  if (row.subscription_status !== 'pending_payment') redirect('/dashboard');

  // Validate tier against the allowed set instead of casting blindly. A bad
  // value in the DB (mid-migration, manual edit) would otherwise produce a
  // null env-var lookup and a confusing "contact support" screen with no
  // diagnostic — better to default to 'standard' and let the link work.
  const tier: 'founding' | 'standard' =
    row.subscription_tier === 'founding' || row.subscription_tier === 'standard'
      ? row.subscription_tier
      : 'standard';
  const paymentUrl = buildPaymentLinkUrl(tier, row.business_id, row.owner_email);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-lg border border-gray-200 p-8 text-center">
        {searchParams.cancelled && (
          <p className="text-sm text-amber-700 mb-4">
            No worries — try again when you&apos;re ready.
          </p>
        )}
        <h1 className="text-2xl font-bold mb-4">Welcome to RepWorth!</h1>
        <p className="text-gray-700 mb-6">
          Complete your payment to unlock your dashboard.
        </p>
        {paymentUrl ? (
          <a
            href={paymentUrl}
            className="inline-block bg-blue-600 text-white font-medium py-3 px-8 rounded-md hover:bg-blue-700"
          >
            Complete payment
          </a>
        ) : (
          <p className="text-sm text-red-600">
            Payment link unavailable.{' '}
            <a
              href={`mailto:support@repworth.com?subject=Payment%20link%20unavailable&body=Business%20ID:%20${row.business_id}`}
              className="underline"
            >
              Contact support
            </a>
            .
          </p>
        )}
      </div>
    </div>
  );
}
