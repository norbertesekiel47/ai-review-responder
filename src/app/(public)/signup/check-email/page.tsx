import type { Metadata } from 'next';
import { CheckEmailClient } from '@/components/auth/CheckEmailClient';
import { noindexRobots } from '@/lib/seo';

// Bare name: the root layout's title template appends " · RepWorth".
export const metadata: Metadata = { title: 'Check your email', robots: noindexRobots };

/**
 * Always-on — see `/login`. `SELF_SERVE_SIGNUP_ENABLED` means only "strangers
 * may mint accounts", and this page mints nothing: it confirms an email that
 * already has an account behind it. An admin-invited owner whose email is
 * still unconfirmed is sent here by `/login` (`useLoginSubmit`,
 * `?from=login`) while the flag is off, so gating it produced a 404 at the
 * exact moment they needed it. The OTP routes it POSTs to enforce their own
 * boundaries (`/api/auth/verify-otp`, `/api/auth/resend-confirmation`).
 */
export default function CheckEmailPage() {
  return <CheckEmailClient />;
}
