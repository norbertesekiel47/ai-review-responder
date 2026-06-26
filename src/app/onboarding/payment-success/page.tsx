import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { notFound } from 'next/navigation';
import { PaymentSuccessClient } from './PaymentSuccessClient';

export const metadata: Metadata = { title: 'Payment confirmed | RepWorth' };

export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string; checkout_session_id?: string }>;
}) {
  if (!selfServeSignupEnabled()) notFound();
  const params = await searchParams;
  return (
    <PaymentSuccessClient
      checkoutSessionId={params.session_id ?? params.checkout_session_id ?? null}
    />
  );
}
