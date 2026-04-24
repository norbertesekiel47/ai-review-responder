import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { buildPaymentLinkUrl } from '@/lib/payments/payment-link';

export const dynamic = 'force-dynamic';

export default async function OnboardingPayPage({
  searchParams,
}: {
  searchParams: { cancelled?: string };
}) {
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

  if (!user.email_confirmed_at) redirect('/signup/check-email?from=pay');
  if (row.subscription_status === 'active') redirect('/dashboard');

  const paymentUrl = buildPaymentLinkUrl(
    row.subscription_tier as 'founding' | 'standard',
    row.business_id,
    row.owner_email,
  );

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
            Payment link unavailable. Contact support.
          </p>
        )}
      </div>
    </div>
  );
}
